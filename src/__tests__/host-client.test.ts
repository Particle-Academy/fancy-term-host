import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
    encodeFrame,
    FrameDecoder,
    PROTOCOL_VERSION,
    type ClientMessage,
    type HostMessage,
} from '../host-protocol';

/**
 * Tier 3 — HostClient proxying. We stand up a REAL net.Server speaking the host
 * protocol on an ephemeral transport (a unix socket on POSIX, a named pipe on
 * Windows) and assert the client: handshakes, proxies create/write, surfaces
 * pushed data/exit, and seeds its mirror from a list+scrollback on connect.
 *
 * Inversion: the snapshot store is now an INJECTED PORT passed to
 * HostClient.connect — a no-op in-memory test double — so create()'s on-disk
 * snapshot probe never touches the filesystem and the client never imports
 * `../sessions` directly.
 */

import { HostClient } from '../host-client';
import type { SnapshotStore } from '../sessions';

/** No-op snapshot store double — readSnapshot always returns null. */
const noSnapshots: SnapshotStore = {
    readSnapshot: () => null,
    writeSnapshot: () => 1,
    deleteSnapshot: () => undefined,
        encrypting: () => false,
};

function ephemeralPath(): string {
    const tag = crypto.randomBytes(6).toString('hex');
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\genie-test-${tag}`;
    }
    return path.join(os.tmpdir(), `genie-test-${tag}.sock`);
}

interface MockHostOptions {
    /** Pre-seed live ptys the client should discover on connect. */
    seed?: Array<{ id: string; pid: number; shell: string; scrollback: string }>;
    /** Override the protocol version reported in hello-ok (for mismatch tests). */
    helloVersion?: number;
    /** When set, the host ACKs shutdown but never closes the socket (timeout test). */
    shutdownNoClose?: boolean;
    /** Replace the answer to `create`. Null answers nothing, as a host before 0.13.0 did. */
    createReply?: (msg: Extract<ClientMessage, { kind: 'create' }>) => HostMessage | null;
    /** What hello-ok advertises. */
    capabilities?: string[];
}

/** A minimal protocol-speaking server. Returns control handles for the test. */
function startMockHost(socketPath: string, opts: MockHostOptions = {}) {
    const sockets = new Set<net.Socket>();
    const received: ClientMessage[] = [];
    // A WEDGED host: still connected, still holding the socket open, but no
    // longer answering anything. This is the failure mode issue #11 is about --
    // the host's `uncaughtException` handler is non-fatal, so a hung host never
    // closes its socket and every close/error path stays silent.
    let wedged = false;
    const seed = new Map(
        (opts.seed ?? []).map((s) => [s.id, s] as const),
    );

    const server = net.createServer((sock) => {
        sockets.add(sock);
        const dec = new FrameDecoder();
        sock.on('data', (chunk: Buffer) => {
            for (const f of dec.push(chunk)) {
                const msg = f as ClientMessage;
                received.push(msg);
                handle(sock, msg);
            }
        });
        sock.on('close', () => sockets.delete(sock));
        sock.on('error', () => sockets.delete(sock));
    });

    function send(sock: net.Socket, msg: HostMessage) {
        sock.write(encodeFrame(msg));
    }

    function handle(sock: net.Socket, msg: ClientMessage) {
        if (wedged) return; // socket stays open; nothing is ever answered
        switch (msg.kind) {
            case 'hello':
                send(sock, {
                    kind: 'hello-ok',
                    seq: msg.seq,
                    protocolVersion: opts.helloVersion ?? PROTOCOL_VERSION,
                    pid: 9999,
                    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
                });
                break;
            case 'list':
                send(sock, {
                    kind: 'list-result',
                    seq: msg.seq,
                    terminals: Array.from(seed.values()).map((s) => ({
                        id: s.id,
                        pid: s.pid,
                        shell: s.shell,
                    })),
                });
                break;
            case 'get-scrollback':
                send(sock, {
                    kind: 'scrollback-result',
                    seq: msg.seq,
                    scrollback: seed.get(msg.id)?.scrollback ?? null,
                });
                break;
            case 'create':
                if (opts.createReply) {
                    const r = opts.createReply(msg);
                    if (r) send(sock, r);
                    break;
                }
                send(sock, {
                    kind: 'created',
                    seq: msg.seq,
                    result: {
                        id: msg.opts.id,
                        pid: 1234,
                        shell: msg.opts.shell ?? 'sh',
                        existing: false,
                        scrollback: '',
                    },
                });
                break;
            case 'ping':
                send(sock, { kind: 'pong', seq: msg.seq });
                break;
            case 'shutdown':
                send(sock, { kind: 'shutdown-ok', seq: msg.seq });
                // Real host exits right after acking, closing the socket. The
                // no-close variant lets us exercise the client's ack path / timeout.
                if (!opts.shutdownNoClose) {
                    setImmediate(() => {
                        try {
                            sock.end();
                        } catch {
                            /* ignore */
                        }
                    });
                }
                break;
            default:
                break;
        }
    }

    return {
        server,
        received,
        /** Stop answering anything, without closing the socket. */
        wedge() {
            wedged = true;
        },
        /** Push a data/exit message to all connected clients. */
        push(msg: HostMessage) {
            for (const s of sockets) s.write(encodeFrame(msg));
        },
        listen() {
            return new Promise<void>((resolve) => server.listen(socketPath, resolve));
        },
        close() {
            for (const s of sockets) s.destroy();
            return new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

let socketPath: string;
let host: ReturnType<typeof startMockHost>;
let client: HostClient | null = null;

beforeEach(async () => {
    socketPath = ephemeralPath();
});

afterEach(async () => {
    try {
        client?.disconnect();
    } catch {
        /* ignore */
    }
    client = null;
    if (host) await host.close();
    if (process.platform !== 'win32') {
        try {
            fs.rmSync(socketPath, { force: true });
        } catch {
            /* ignore */
        }
    }
});

describe('HostClient.connect', () => {
    it('handshakes and reports connected', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);
        expect(client.isConnected()).toBe(true);
        expect(client.hostPid).toBe(9999);
    });

    it('rejects on protocol-version mismatch', async () => {
        host = startMockHost(socketPath, { helloVersion: PROTOCOL_VERSION + 99 });
        await host.listen();
        await expect(HostClient.connect(socketPath, noSnapshots, 2000)).rejects.toThrow(/mismatch/);
    });

    it('rejects on connect timeout when nothing is listening', async () => {
        // No server started → connection fails fast (ENOENT/ECONNREFUSED) or times out.
        await expect(HostClient.connect(socketPath, noSnapshots, 800)).rejects.toBeTruthy();
    });

    it('seeds its mirror from the host list + scrollback on connect', async () => {
        host = startMockHost(socketPath, {
            seed: [
                { id: 'srv', pid: 42, shell: '/bin/bash', scrollback: 'listening :3000\r\n' },
            ],
        });
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);

        expect(client.liveIds()).toContain('srv');
        expect(client.isLive('srv')).toBe(true);
        expect(client.getScrollback('srv')).toContain('listening :3000');

        // create() on a seeded id is a warm rejoin (no respawn), returning the
        // replayed scrollback — exactly the reattach-after-quit path.
        const res = client.create({ id: 'srv', cwd: '/tmp' });
        expect(res.existing).toBe(true);
        expect(res.scrollback).toContain('listening :3000');
    });
});

describe('HostClient proxying', () => {
    it('proxies create + write to the host', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);

        const res = client.create({ id: 'a', cwd: '/tmp', shell: 'sh' });
        expect(res.existing).toBe(false);
        expect(client.isLive('a')).toBe(true);

        expect(client.write('a', 'echo hi\n')).toBe(true);

        // Let the create + write frames land on the host.
        await new Promise((r) => setTimeout(r, 50));
        const kinds = host.received.map((m) => m.kind);
        expect(kinds).toContain('create');
        expect(kinds).toContain('write');
    });

    it('surfaces pushed data + exit events to subscribers', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);
        client.create({ id: 'a', cwd: '/tmp' });

        const datas: Array<{ id: string; data: string }> = [];
        const exits: Array<{ id: string; exitCode: number }> = [];
        client.on('data', (id, data) => datas.push({ id, data }));
        client.on('exit', (id, p) => exits.push({ id, exitCode: p.exitCode }));

        host.push({ kind: 'data', id: 'a', data: 'output line\r\n' });
        host.push({ kind: 'exit', id: 'a', exitCode: 0 });

        await new Promise((r) => setTimeout(r, 50));
        expect(datas).toEqual([{ id: 'a', data: 'output line\r\n' }]);
        expect(exits).toEqual([{ id: 'a', exitCode: 0 }]);
        // Exit removes the pty from the mirror.
        expect(client.isLive('a')).toBe(false);
    });

    it('killAll is a no-op (host ptys survive quit)', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);
        client.create({ id: 'a', cwd: '/tmp' });
        client.killAll();
        // Still live locally — killAll must NOT tear down host ptys.
        expect(client.isLive('a')).toBe(true);
    });
});

describe('HostClient.shutdownHost', () => {
    it('sends a shutdown request and resolves once the host acks + closes', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);

        // Should NOT emit a spurious error when the host closes after acking.
        let errored = false;
        client.on('error', () => {
            errored = true;
        });

        await client.shutdownHost(2000);

        expect(host.received.map((m) => m.kind)).toContain('shutdown');
        expect(client.isConnected()).toBe(false);
        expect(errored).toBe(false);
    });

    it('resolves on the ack even if the host never closes (timeout fallback)', async () => {
        host = startMockHost(socketPath, { shutdownNoClose: true });
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);

        // Host acks but holds the socket open; shutdownHost must still resolve
        // (on the ack here, well before the timeout) and disconnect locally.
        await client.shutdownHost(1000);
        expect(client.isConnected()).toBe(false);
        expect(host.received.map((m) => m.kind)).toContain('shutdown');
    });

    it('is a no-op that resolves when not connected', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);
        client.disconnect();
        // No host round-trip; resolves immediately without throwing.
        await expect(client.shutdownHost(500)).resolves.toBeUndefined();
    });
});

/**
 * Issue #11 — liveness of a HUNG host.
 *
 * The pty-host is one process backing every terminal in a consumer's session,
 * and the package had no active liveness detection of it. Two things made a
 * wedged host completely invisible:
 *
 *   - the host's `uncaughtException` handler is non-fatal, so a wedged host
 *     keeps its socket OPEN — no 'close', no 'error', nothing for a consumer
 *     to bind to;
 *   - `request()` registered a pending resolver with no timeout, so a `list` /
 *     `get-scrollback` / `create` against that host hung FOREVER.
 *
 * The downstream shape is "all terminals froze at once, no sign of a crash".
 *
 * A ping/pong protocol already existed on both sides — the host answers `ping`
 * with `pong` — and the client simply never sent one. So the detection here is
 * not new protocol, it is using what was already there.
 */
describe('liveness — a hung host is detectable', () => {
    it('sends heartbeat pings once connected', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000, {
            heartbeatIntervalMs: 40,
            requestTimeoutMs: 500,
        });

        await new Promise((r) => setTimeout(r, 200));

        expect(host.received.some((m) => m.kind === 'ping')).toBe(true);
    });

    it('emits error when the host stops answering pings but holds the socket open', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000, {
            heartbeatIntervalMs: 40,
            requestTimeoutMs: 150,
        });

        const lost = new Promise<Error>((resolve) => {
            client!.once('error', resolve);
        });

        host.wedge(); // socket stays open; nothing is answered ever again

        const err = await lost;
        expect(err).toBeInstanceOf(Error);
        expect(client!.isConnected()).toBe(false);
    });

    it('fails the connect when a host accepts the socket but never answers', async () => {
        // Wedged before the handshake: the socket connects, so a plain
        // connection check says "fine", and `hello` is never answered.
        host = startMockHost(socketPath);
        await host.listen();
        host.wedge();

        await expect(
            HostClient.connect(socketPath, noSnapshots, 400, { requestTimeoutMs: 200 }),
        ).rejects.toBeTruthy();
    });

    it('still resolves shutdownHost against a wedged host', async () => {
        // `shutdownHost` resolves on ack OR socket close, and now also has its
        // in-flight request rejected during teardown. That rejection must not
        // escape as an unhandled error or re-settle the promise -- a host that
        // is already unreachable is a SUCCESSFUL shutdown by contract.
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000, {
            heartbeatIntervalMs: 10_000,
            requestTimeoutMs: 150,
        });

        host.wedge();

        await expect(client.shutdownHost(400)).resolves.toBeUndefined();
        expect(client.isConnected()).toBe(false);
    });
});

/**
 * A create the host could not carry out. Through 0.12.0 the host answered nothing,
 * the client swallowed the timeout, and the caller was left with a terminal listed
 * at pid 0 that accepted writes and never fired `exit`.
 */
describe('HostClient: a create that fails', () => {
    /** Everything a consumer can hear, in order. */
    function listen(c: HostClient) {
        const heard: Array<[string, unknown]> = [];
        c.on('create-error', (id: string, e: { message: string }) => heard.push(['create-error', [id, e.message]]));
        c.on('data', (id: string, d: string) => heard.push(['data', [id, d]]));
        c.on('exit', (id: string, e: { exitCode: number }) => heard.push(['exit', [id, e.exitCode]]));
        return heard;
    }
    const settled = (fn: () => boolean) => vi.waitFor(() => expect(fn()).toBe(true), { timeout: 2000 });

    it('a refusal from the host reaches the caller, in the data too, and leaves nothing listed', async () => {
        host = startMockHost(socketPath, {
            createReply: (m) => ({ kind: 'create-failed', seq: m.seq, id: m.opts.id, message: 'refused: no' }),
        });
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);
        const heard = listen(client);

        client.setRetained('t', true);
        client.create({ id: 't', cwd: '.', shell: 'x' });
        await settled(() => heard.length === 3);

        expect(heard[0]).toEqual(['create-error', ['t', 'refused: no']]);
        // An app wired only to `data` and `exit` has no other way to see why.
        expect(heard[1][0]).toBe('data');
        expect((heard[1][1] as string[])[1]).toContain('refused: no');
        expect(heard[2]).toEqual(['exit', ['t', 1]]);

        expect(client.list()).toEqual([]);
        expect(client.isLive('t')).toBe(false);
        expect(client.write('t', 'x')).toBe(false);
        expect(client.isRetained('t')).toBe(false);
    });

    it('a listener that throws does not cost the exit', async () => {
        host = startMockHost(socketPath, {
            createReply: (m) => ({ kind: 'create-failed', seq: m.seq, id: m.opts.id, message: 'no' }),
        });
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);
        const exits: string[] = [];
        client.on('exit', (id: string) => exits.push(id));
        client.on('create-error', () => {
            throw new Error('a listener broke');
        });

        client.create({ id: 't', cwd: '.', shell: 'x' });
        await settled(() => exits.length === 1);
        expect(client.isLive('t')).toBe(false);
    });

    it('a pushed failure, from a pty that started and then could not, reports without ending it twice', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);
        const heard = listen(client);

        client.create({ id: 't', cwd: '.', shell: 'x' });
        await settled(() => client!.list()[0]?.pid === 1234);
        host.push({ kind: 'create-failed', id: 't', message: 'program not found' });
        host.push({ kind: 'data', id: 't', data: '[fancy-pty] program not found' });
        host.push({ kind: 'exit', id: 't', exitCode: 1 });
        await settled(() => heard.length === 3);

        expect(heard.map((h) => h[0])).toEqual(['create-error', 'data', 'exit']);
        expect(heard[0][1]).toEqual(['t', 'program not found']);
        expect(client.list()).toEqual([]);
    });

    it('a host that never answers, as one before this release does, fails the create at the timeout', async () => {
        host = startMockHost(socketPath, { createReply: () => null });
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000, {
            requestTimeoutMs: 150,
            heartbeatIntervalMs: 0,
        });
        const heard = listen(client);

        client.create({ id: 't', cwd: '.', shell: 'x' });
        expect(client.isLive('t'), 'control: listed while the create is in flight').toBe(true);
        await settled(() => heard.length === 3);

        expect(heard[0][0]).toBe('create-error');
        expect((heard[0][1] as string[])[1]).toMatch(/timed out/);
        expect(heard[2]).toEqual(['exit', ['t', 1]]);
        expect(client.list()).toEqual([]);
        // It may yet start over there, so it is told to stop rather than left running unlisted.
        await settled(() => host.received.some((m) => m.kind === 'kill' && m.id === 't'));
    });

    it('a late failure does not touch a terminal since replaced under the same id', async () => {
        const replies: Array<Extract<ClientMessage, { kind: 'create' }>> = [];
        host = startMockHost(socketPath, {
            createReply: (m) => {
                replies.push(m);
                return replies.length === 1
                    ? null
                    : {
                          kind: 'created',
                          seq: m.seq,
                          result: { id: m.opts.id, pid: 55, shell: 'x', existing: false, scrollback: '' },
                      };
            },
        });
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000, {
            requestTimeoutMs: 200,
            heartbeatIntervalMs: 0,
        });
        const heard = listen(client);

        client.create({ id: 't', cwd: '.', shell: 'x' });
        client.kill('t');
        client.create({ id: 't', cwd: '.', shell: 'x' });
        await settled(() => client!.list()[0]?.pid === 55);
        await new Promise((r) => setTimeout(r, 300)); // Past the first one's timeout.

        expect(heard).toEqual([]);
        expect(client.isLive('t')).toBe(true);
    });

    it('losing the connection stays a connection error, not one create error per terminal', async () => {
        host = startMockHost(socketPath, { createReply: () => null });
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000, {
            requestTimeoutMs: 5000,
            heartbeatIntervalMs: 0,
        });
        const heard = listen(client);
        const errors: Error[] = [];
        client.on('error', (e: Error) => errors.push(e));

        client.create({ id: 't', cwd: '.', shell: 'x' });
        await host.close();
        await settled(() => errors.length === 1);
        await new Promise((r) => setTimeout(r, 50));

        expect(heard).toEqual([]);
    });
});

describe('HostClient: which engine the running host is on', () => {
    it('reads a host that advertises fancy-pty', async () => {
        host = startMockHost(socketPath, { capabilities: ['windowsVerbatimArguments', 'fancy-pty'] });
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);
        expect(client.hostEngine()).toBe('fancy-pty');
    });

    it('reads a host from before the move as node-pty, including one that sends no list', async () => {
        host = startMockHost(socketPath, { capabilities: ['windowsVerbatimArguments'] });
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);
        expect(client.hostEngine()).toBe('node-pty');
        client.disconnect();
        await host.close();

        socketPath = ephemeralPath();
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000);
        expect(client.hostEngine()).toBe('node-pty');
    });
});
