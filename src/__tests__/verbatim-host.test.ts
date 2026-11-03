import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostClient } from '../host-client';
import { readPidfile, pidfileUsable, socketPathFor } from '../host-locate';
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION } from '../host-protocol';
import type { SnapshotStore } from '../sessions';

/**
 * `windowsVerbatimArguments` across the IPC boundary, against the REAL pty-host
 * module and a REAL socket, with only node-pty faked. It is what proves on every
 * platform that the flag survives the host's own option plumbing and arrives in
 * the shape node-pty needs. `verbatim-live.test.ts` runs the same path with the
 * real engine, on Windows only.
 */

const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[] | string }>);

vi.mock('node-pty', () => ({
    spawn: (file: string, args: string[] | string) => {
        if (file === 'fth-spawn-throws') throw new Error('the engine refused this');
        spawned.push({ file, args });
        return { pid: 77, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
    },
}));

const realPlatform = process.platform;
function onPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

const noSnapshots: SnapshotStore = {
    readSnapshot: () => null,
    writeSnapshot: () => 1,
    deleteSnapshot: () => undefined,
    encrypting: () => false,
};

const LINE = '"C:\\x\\node.exe" -v';
const ARGS = ['/d', '/s', '/c', `"${LINE}"`];

/** Inside the repo, not the temp directory, and gitignored. */
const userData = path.resolve(__dirname, '..', '..', '.tmp-verbatim-host', String(process.pid));

/**
 * The default Windows pipe is machine-wide and belongs to whatever real host an app
 * on this machine is running. This suite IS a host, so it takes a pipe of its own
 * before the module is imported, and checks that it did. `userHash` asks os.hostname
 * on every call, so the client below sees the same name.
 */
const defaultSocket = socketPathFor(userData);
os.hostname = () => `fth-test-verbatim-host-${process.pid}`;

let client: HostClient;

async function nextSpawn(): Promise<{ file: string; args: string[] | string }> {
    for (let i = 0; i < 300 && spawned.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
    }
    expect(spawned.length, 'the host never called node-pty').toBe(1);
    return spawned[0];
}

beforeAll(async () => {
    if (realPlatform === 'win32') expect(socketPathFor(userData)).not.toBe(defaultSocket);
    fs.mkdirSync(userData, { recursive: true });
    process.env.GENIE_USERDATA = userData;
    // The module IS the host: importing it starts the server and writes the pidfile.
    await import('../pty-host');
    for (let i = 0; i < 300 && !pidfileUsable(readPidfile(userData)); i++) {
        await new Promise((r) => setTimeout(r, 10));
    }
    client = await HostClient.connect(socketPathFor(userData), noSnapshots, 3000, {
        heartbeatIntervalMs: 0,
    });
}, 30_000);

afterAll(() => {
    client?.disconnect();
    fs.rmSync(path.dirname(userData), { recursive: true, force: true });
});

beforeEach(() => {
    spawned.length = 0;
});

afterEach(() => onPlatform(realPlatform));

describe('the real pty-host', () => {
    it('on Windows, hands node-pty the verbatim line as a string', async () => {
        // The handshake happened for real, so this also proves the host
        // advertises the capability: the client refuses to send otherwise.
        onPlatform('win32');
        client.create({ id: 'win', cwd: userData, shell: 'cmd.exe', args: ARGS, windowsVerbatimArguments: true });
        const s = await nextSpawn();
        expect(s.file).toBe('cmd.exe');
        expect(s.args).toBe(`/d /s /c "${LINE}"`);
    });

    it('on Windows, keeps a default spawn a list', async () => {
        onPlatform('win32');
        client.create({ id: 'win-default', cwd: userData, shell: 'cmd.exe', args: ARGS });
        expect((await nextSpawn()).args).toEqual(ARGS);
    });

    it('on POSIX, keeps the list even with the flag, because node-pty throws on a string', async () => {
        onPlatform('linux');
        client.create({ id: 'posix', cwd: userData, shell: 'sh', args: ['-c', 'true'], windowsVerbatimArguments: true });
        expect((await nextSpawn()).args).toEqual(['-c', 'true']);
    });

    it('answers a create the engine throws on, and leaves the id free', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        const heard: Array<[string, string]> = [];
        client.on('create-error', (id: string, e: { message: string }) => heard.push([id, e.message]));
        client.create({ id: 'throws', cwd: userData, shell: 'fth-spawn-throws' });
        await vi.waitFor(() => expect(heard).toEqual([['throws', 'the engine refused this']]), { timeout: 3000 });
        expect(client.isLive('throws')).toBe(false);
        logged.mockRestore();

        client.create({ id: 'throws', cwd: userData, shell: 'cmd.exe' });
        await nextSpawn();
        expect(client.isLive('throws')).toBe(true);
    });

    it('refuses a non-boolean sent straight to the socket, spawning nothing, and says so', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        const sock = net.createConnection(socketPathFor(userData));
        const dec = new FrameDecoder();
        let failed: { message?: string } | undefined;
        const answered = new Promise<void>((resolve) => {
            sock.on('data', (b: Buffer) => {
                for (const f of dec.push(b)) {
                    if ((f as { kind: string }).kind === 'create-failed') {
                        failed = f as { message?: string };
                        resolve();
                    }
                }
            });
        });
        await new Promise<void>((r) => sock.once('connect', () => r()));
        sock.write(
            encodeFrame({
                kind: 'create',
                seq: 1,
                opts: {
                    id: 'bad',
                    cwd: userData,
                    shell: 'cmd.exe',
                    args: ARGS,
                    windowsVerbatimArguments: 'yes' as unknown as boolean,
                },
            }),
        );
        await answered;
        sock.destroy();
        expect(spawned).toEqual([]);
        expect(failed?.message).toMatch(/windowsVerbatimArguments/);
        logged.mockRestore();
    });

    it('does not change the protocol version: older clients and hosts still attach', () => {
        // Deliberate. The field is additive and the refusal lives in the capability
        // check. A bump would strand every running host's live terminals on upgrade.
        expect(PROTOCOL_VERSION).toBe(2);
    });
});
