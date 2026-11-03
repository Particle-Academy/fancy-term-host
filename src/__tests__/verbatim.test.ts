import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFancyPtySpawn, type FancyPty, type FancyPtyOpenOptions } from '../fancy-pty';
import { configureInProcessBackend, terminalManager, type PtySpawn } from '../manager';
import { HostClient } from '../host-client';
import {
    encodeFrame,
    FrameDecoder,
    PROTOCOL_VERSION,
    type ClientMessage,
    type HostMessage,
} from '../host-protocol';
import { checkVerbatimOption } from '../verbatim';
import type { SnapshotStore } from '../sessions';

/**
 * `windowsVerbatimArguments`, hermetic half: every boundary it crosses on the way
 * to `open()`, asserted on the actual argument. Runs on every platform, so this
 * is the half CI sees (CI is ubuntu-latest). `verbatim-live.test.ts` is the half
 * that proves a real `cmd.exe` agrees, and `verbatim-host.test.ts` runs the real
 * pty-host script.
 */

// A hook that APPENDS launch args, as PowerShell's does, without writing a shim
// to the temp directory. Only for the shell named here.
vi.mock('../shells', async (importActual) => {
    const actual = await importActual<typeof import('../shells')>();
    return {
        ...actual,
        cwdHookSpawn: (shell: string) =>
            shell === 'hooked-shell'
                ? { env: {}, args: ['-NoExit', '-Command', ". 'shim'"] }
                : { env: {}, args: [] },
    };
});

const realPlatform = process.platform;
function onPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}
afterEach(() => onPlatform(realPlatform));

const LINE = '"C:\\x\\node.exe" -v';
const ARGS = ['/d', '/s', '/c', `"${LINE}"`];

const noSnapshots: SnapshotStore = {
    readSnapshot: () => null,
    writeSnapshot: () => 1,
    deleteSnapshot: () => undefined,
    encrypting: () => false,
};

const quietPty: FancyPty = {
    pid: 1,
    write: () => true,
    resize: () => true,
    kill: () => true,
    onData: () => {},
    onExit: () => {},
    onError: () => {},
};

describe('adapter: createFancyPtySpawn -> open()', () => {
    function opened(opts: Parameters<ReturnType<typeof createFancyPtySpawn>>[2]) {
        let seen: FancyPtyOpenOptions | undefined;
        createFancyPtySpawn((o) => {
            seen = o;
            return quietPty;
        })('cmd.exe', ARGS, opts);
        return seen!;
    }

    it('forwards the flag to open(), with argv untouched', () => {
        const o = opened({ windowsVerbatimArguments: true });
        expect(o.windowsVerbatimArguments).toBe(true);
        // The adapter must not join the line itself: argv stays a list, because
        // fancy-pty still has to know which element is the program.
        expect(o.argv).toEqual(['cmd.exe', ...ARGS]);
    });

    it('is ABSENT by default, so a default spawn is unchanged', () => {
        expect('windowsVerbatimArguments' in opened({})).toBe(false);
    });

    it('declares that it honours the flag', () => {
        expect(createFancyPtySpawn(() => quietPty).honoursWindowsVerbatimArguments).toBe(true);
    });
});

describe('in-process backend: create() -> engine -> open()', () => {
    let opened: FancyPtyOpenOptions[];

    function useFancyPtyEngine(): void {
        configureInProcessBackend({
            settings: { get: () => undefined },
            snapshots: noSnapshots,
            ptySpawn: createFancyPtySpawn((o) => {
                opened.push(o);
                return quietPty;
            }),
        });
    }

    beforeEach(() => {
        opened = [];
        terminalManager().killAll();
        useFancyPtyEngine();
    });

    it('reaches open() when asked for', () => {
        terminalManager().create({
            id: 'v',
            cwd: '/tmp',
            shell: 'cmd.exe',
            args: ARGS,
            windowsVerbatimArguments: true,
        });
        expect(opened[0].windowsVerbatimArguments).toBe(true);
        expect(opened[0].argv).toEqual(['cmd.exe', ...ARGS]);
    });

    it('is absent at open() by default', () => {
        terminalManager().create({ id: 'd', cwd: '/tmp', shell: 'cmd.exe', args: ARGS });
        expect('windowsVerbatimArguments' in opened[0]).toBe(false);
    });

    it('does not append the cwd hook to a line the caller owns', () => {
        // PowerShell's hook appends `-NoExit -Command ...`. On a verbatim line
        // those would land after text only the caller has quoted.
        terminalManager().create({
            id: 'hv',
            cwd: '/tmp',
            shell: 'hooked-shell',
            args: ['-Command', '& "x"'],
            windowsVerbatimArguments: true,
        });
        expect(opened[0].argv).toEqual(['hooked-shell', '-Command', '& "x"']);
    });

    it('still appends the cwd hook to a default spawn', () => {
        terminalManager().create({ id: 'hd', cwd: '/tmp', shell: 'hooked-shell', args: ['-Command', 'x'] });
        expect(opened[0].argv).toEqual(['hooked-shell', '-Command', 'x', '-NoExit', '-Command', ". 'shim'"]);
    });

    describe('an injected engine that does not declare it honours the flag', () => {
        // node-pty's own `spawn` is a supported engine and takes no such option,
        // so forwarding the flag to it would quietly quote the line: the bug this
        // option exists to fix, with nothing to explain it.
        function useRawEngine() {
            const calls: string[][] = [];
            const raw: PtySpawn = (file, args) => {
                calls.push([file, ...args]);
                return { pid: 1, process: file, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
            };
            configureInProcessBackend({ settings: { get: () => undefined }, snapshots: noSnapshots, ptySpawn: raw });
            return calls;
        }

        it('throws on Windows, spawns nothing and lists nothing', () => {
            onPlatform('win32');
            const calls = useRawEngine();
            expect(() =>
                terminalManager().create({
                    id: 'raw',
                    cwd: '/tmp',
                    shell: 'cmd.exe',
                    args: ARGS,
                    windowsVerbatimArguments: true,
                }),
            ).toThrow(/windowsVerbatimArguments/);
            expect(calls).toEqual([]);
            expect(terminalManager().isLive('raw')).toBe(false);
        });

        it('is fine on POSIX, where the option means nothing to any engine', () => {
            onPlatform('linux');
            const calls = useRawEngine();
            terminalManager().create({
                id: 'raw-posix',
                cwd: '/tmp',
                shell: 'sh',
                args: ['-c', 'true'],
                windowsVerbatimArguments: true,
            });
            expect(calls).toEqual([['sh', '-c', 'true']]);
        });

        it('is fine when the flag is not set', () => {
            onPlatform('win32');
            const calls = useRawEngine();
            terminalManager().create({ id: 'raw-off', cwd: '/tmp', shell: 'cmd.exe', args: ['/k'] });
            expect(calls).toEqual([['cmd.exe', '/k']]);
        });
    });

    it('refuses a non-boolean rather than treating it as truthy', () => {
        expect(() =>
            terminalManager().create({
                id: 'bad',
                cwd: '/tmp',
                shell: 'cmd.exe',
                args: [],
                windowsVerbatimArguments: 'yes' as unknown as boolean,
            }),
        ).toThrow(TypeError);
        expect(opened).toEqual([]);
    });
});

describe('HostClient: create() -> the frame the host receives', () => {
    let socketPath: string;
    let server: net.Server;
    let client: HostClient | null = null;
    const sockets = new Set<net.Socket>();
    const received: ClientMessage[] = [];

    function listen(capabilities: string[] | undefined): Promise<void> {
        server = net.createServer((sock) => {
            sockets.add(sock);
            const dec = new FrameDecoder();
            sock.on('data', (buf: Buffer) => {
                for (const f of dec.push(buf)) {
                    const msg = f as ClientMessage;
                    received.push(msg);
                    const send = (m: HostMessage) => sock.write(encodeFrame(m));
                    if (msg.kind === 'hello') {
                        send({
                            kind: 'hello-ok',
                            seq: msg.seq,
                            protocolVersion: PROTOCOL_VERSION,
                            pid: 1,
                            ...(capabilities ? { capabilities } : {}),
                        });
                    } else if (msg.kind === 'list') {
                        send({ kind: 'list-result', seq: msg.seq, terminals: [] });
                    } else if (msg.kind === 'create') {
                        send({
                            kind: 'created',
                            seq: msg.seq,
                            result: { id: msg.opts.id, pid: 3, shell: 'sh', existing: false, scrollback: '' },
                        });
                    }
                }
            });
            sock.on('close', () => sockets.delete(sock));
            sock.on('error', () => sockets.delete(sock));
        });
        return new Promise((r) => server.listen(socketPath, r));
    }

    async function connect(capabilities: string[] | undefined): Promise<HostClient> {
        await listen(capabilities);
        client = await HostClient.connect(socketPath, noSnapshots, 2000, { heartbeatIntervalMs: 0 });
        return client;
    }

    async function frame(): Promise<Extract<ClientMessage, { kind: 'create' }>> {
        for (let i = 0; i < 200 && !received.some((m) => m.kind === 'create'); i++) {
            await new Promise((r) => setTimeout(r, 10));
        }
        return received.find((m) => m.kind === 'create') as Extract<ClientMessage, { kind: 'create' }>;
    }

    beforeEach(() => {
        const tag = crypto.randomBytes(6).toString('hex');
        socketPath =
            process.platform === 'win32'
                ? `\\\\.\\pipe\\fth-verbatim-${tag}`
                : path.join(os.tmpdir(), `fth-verbatim-${tag}.sock`);
        received.length = 0;
    });

    afterEach(async () => {
        client?.disconnect();
        client = null;
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
        if (realPlatform !== 'win32') fs.rmSync(socketPath, { force: true });
    });

    it('carries the flag in the create frame', async () => {
        const c = await connect(['windowsVerbatimArguments']);
        c.create({ id: 'v', cwd: '/tmp', shell: 'cmd.exe', args: ARGS, windowsVerbatimArguments: true });
        expect((await frame()).opts.windowsVerbatimArguments).toBe(true);
    });

    it('leaves it out of the frame by default', async () => {
        const c = await connect(['windowsVerbatimArguments']);
        c.create({ id: 'd', cwd: '/tmp', shell: 'cmd.exe', args: ARGS });
        expect('windowsVerbatimArguments' in (await frame()).opts).toBe(false);
    });

    it('refuses a Windows host that does not advertise it, sending nothing', async () => {
        // An older host ignores an unknown create field, which is fine for
        // scrollbackMax and is the original bug here: the line would be quoted
        // with nothing to explain it.
        const c = await connect(undefined);
        onPlatform('win32');
        expect(() =>
            c.create({ id: 'old', cwd: '/tmp', shell: 'cmd.exe', args: ARGS, windowsVerbatimArguments: true }),
        ).toThrow(/windowsVerbatimArguments/);
        expect(c.isLive('old')).toBe(false);
        onPlatform(realPlatform);
        expect(received.some((m) => m.kind === 'create')).toBe(false);
    });

    it('a default spawn still works against a host that does not advertise it', async () => {
        const c = await connect(undefined);
        onPlatform('win32');
        c.create({ id: 'old-default', cwd: '/tmp', shell: 'cmd.exe', args: ['/k'] });
        onPlatform(realPlatform);
        expect((await frame()).opts.id).toBe('old-default');
    });

    it('does not care on POSIX, where an older host loses nothing by ignoring it', async () => {
        const c = await connect(undefined);
        onPlatform('linux');
        c.create({ id: 'posix', cwd: '/tmp', shell: 'sh', args: [], windowsVerbatimArguments: true });
        onPlatform(realPlatform);
        expect((await frame()).opts.id).toBe('posix');
    });
});


describe('checkVerbatimOption', () => {
    it('accepts absent, false, and true where it is honoured', () => {
        expect(() => checkVerbatimOption(undefined, false, 'x', 'win32')).not.toThrow();
        expect(() => checkVerbatimOption(false, false, 'x', 'win32')).not.toThrow();
        expect(() => checkVerbatimOption(true, true, 'x', 'win32')).not.toThrow();
    });

    it('refuses true on Windows where it is not honoured, naming who', () => {
        expect(() => checkVerbatimOption(true, false, 'the engine', 'win32')).toThrow(/the engine/);
    });

    it('accepts true on POSIX either way', () => {
        expect(() => checkVerbatimOption(true, false, 'x', 'linux')).not.toThrow();
    });

    it('refuses a non-boolean on every platform, as fancy-pty does', () => {
        for (const p of ['win32', 'linux']) {
            expect(() => checkVerbatimOption(1, true, 'x', p)).toThrow(TypeError);
            expect(() => checkVerbatimOption('true', true, 'x', p)).toThrow(TypeError);
        }
    });
});
