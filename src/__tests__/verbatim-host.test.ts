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
 * The options a create carries, across the IPC boundary, against the REAL pty-host
 * module and a REAL socket, with only fancy-pty's `open` faked. It is what proves on
 * every platform that `windowsVerbatimArguments` survives the host's own option
 * plumbing and reaches the engine. `verbatim-live.test.ts` runs the same path with
 * the real engine, on Windows only.
 */

interface Opened {
    argv: string[];
    windowsVerbatimArguments?: boolean;
    env?: Record<string, string | undefined>;
    name?: unknown;
}

const opened = vi.hoisted(() => [] as Opened[]);

vi.mock('@particle-academy/fancy-pty', () => ({
    open: (options: Opened) => {
        if (options.argv[0] === 'fth-spawn-throws') throw new Error('the engine refused this');
        opened.push(options);
        return {
            pid: 77,
            childPid: 78,
            onData() {},
            onExit() {},
            onError() {},
            write: () => true,
            resize: () => true,
            kill: () => true,
        };
    },
}));

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

async function nextOpen(): Promise<Opened> {
    await vi.waitFor(() => expect(opened.length, 'the host never called open').toBe(1), { timeout: 3000 });
    return opened[0];
}

beforeAll(async () => {
    if (process.platform === 'win32') expect(socketPathFor(userData)).not.toBe(defaultSocket);
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
    opened.length = 0;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('the real pty-host', () => {
    it('hands the engine the flag, and the arguments as a list', async () => {
        // The handshake happened for real, so this also proves the host
        // advertises the capability: the client refuses to send otherwise.
        client.create({ id: 'flag', cwd: userData, shell: 'cmd.exe', args: ARGS, windowsVerbatimArguments: true });
        const o = await nextOpen();
        expect(o.argv).toEqual(['cmd.exe', ...ARGS]);
        expect(o.windowsVerbatimArguments).toBe(true);
    });

    it('sends no flag on a default spawn', async () => {
        client.create({ id: 'default', cwd: userData, shell: 'cmd.exe', args: ARGS });
        const o = await nextOpen();
        expect(o.argv).toEqual(['cmd.exe', ...ARGS]);
        expect(o).not.toHaveProperty('windowsVerbatimArguments');
    });

    it('resolves TERM itself and passes no node-pty name', async () => {
        client.create({ id: 'term', cwd: userData, shell: 'sh', env: { TERM: 'fth-test-term', FTH_X: '1' } });
        const o = await nextOpen();
        expect(o.env?.TERM).toBe('fth-test-term');
        expect(o.env?.FTH_X).toBe('1');
        expect(o).not.toHaveProperty('name');
    });

    it('answers a create the engine throws on, and leaves the id free', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const heard: Array<[string, string]> = [];
        client.on('create-error', (id: string, e: { message: string }) => heard.push([id, e.message]));
        client.create({ id: 'throws', cwd: userData, shell: 'fth-spawn-throws' });
        await vi.waitFor(() => expect(heard).toEqual([['throws', 'the engine refused this']]), { timeout: 3000 });
        expect(client.isLive('throws')).toBe(false);

        client.create({ id: 'throws', cwd: userData, shell: 'cmd.exe' });
        await nextOpen();
        expect(client.isLive('throws')).toBe(true);
    });

    it('refuses a non-boolean sent straight to the socket, spawning nothing, and says so', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
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
        expect(opened).toEqual([]);
        expect(failed?.message).toMatch(/windowsVerbatimArguments/);
    });

    it('takes frames in order: a kill in the same read as its create finds the pty', async () => {
        // The frames have to arrive as ONE read, or this passes on the bug: with
        // two socket writes the host usually sees them separately. A create is async,
        // so a frame run beside it instead of after it finds no pty and does nothing.
        const sock = net.createConnection(socketPathFor(userData));
        await new Promise<void>((r) => sock.once('connect', () => r()));
        const dec = new FrameDecoder();
        const lists = new Map<number, string[]>();
        sock.on('data', (b: Buffer) => {
            for (const f of dec.push(b)) {
                const m = f as { kind: string; seq: number; terminals?: Array<{ id: string }> };
                if (m.kind === 'list-result') lists.set(m.seq, (m.terminals ?? []).map((t) => t.id));
            }
        });
        sock.write(
            Buffer.concat([
                encodeFrame({ kind: 'create', seq: 1, opts: { id: 'chunk', cwd: userData, shell: 'sh' } }),
                encodeFrame({ kind: 'kill', id: 'chunk' }),
                encodeFrame({ kind: 'ping', seq: 2 }),
            ]),
        );
        await nextOpen();
        // Asked once everything above has run: out of order, the kill was lost and
        // the terminal is still here.
        await new Promise((r) => setTimeout(r, 50));
        sock.write(encodeFrame({ kind: 'list', seq: 3 }));
        await vi.waitFor(() => expect(lists.has(3)).toBe(true), { timeout: 3000 });
        sock.destroy();
        expect(lists.get(3)).not.toContain('chunk');
    });

    it('does not change the protocol version: older clients and hosts still attach', () => {
        // Deliberate. The field is additive and the refusal lives in the capability
        // check. A bump would strand every running host's live terminals on upgrade.
        expect(PROTOCOL_VERSION).toBe(2);
    });
});
