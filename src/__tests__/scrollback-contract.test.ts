import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * The scrollback's OBSERVABLE CONTRACT, pinned before its storage is replaced.
 *
 * Written against the 0.10.0 implementation (`buf + data`, then
 * `slice(-1_000_000)` on every chunk) and run green against it FIRST, so that
 * the replacement is held to exactly what consumers already receive rather
 * than to what its author meant. Every assertion here goes through a public
 * reader: `create()` on an existing id (the warm-attach replay),
 * `getScrollback()` (what a consumer serialises into a T1/T2 snapshot), and the
 * HostClient mirror (the T3 replay source).
 *
 * The reference model is deliberately the dumbest correct thing: concatenate
 * every chunk, keep the last N code units. Trimming per chunk is equivalent
 * (the last N of the last N of X, plus d, is the last N of X + d), so if the
 * implementation agrees with this on every reader, it agrees with 0.10.0.
 *
 * NOTE: no character escapes appear in this file on purpose. Surrogates and ESC
 * are built with `String.fromCharCode`, because an editor or shell layer that
 * decodes backslash escapes would otherwise change what is being tested.
 */

import { terminalManager, inProcessBackend, configureInProcessBackend } from '../manager';
import { HostClient } from '../host-client';
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, type ClientMessage, type HostMessage } from '../host-protocol';
import type { SnapshotStore } from '../sessions';

const CAP = 1_000_000;
const ESC = String.fromCharCode(0x1b);
const HIGH = String.fromCharCode(0xd83d); // first half of U+1F600
const LOW = String.fromCharCode(0xde00); // second half of U+1F600

/** Last `cap` code units of the concatenation — the 0.10.0 semantics. */
function reference(chunks: string[], cap = CAP): string {
    const all = chunks.join('');
    return all.length > cap ? all.slice(all.length - cap) : all;
}

/** Deterministic, position-revealing content: a wrong offset cannot pass. */
function chunkOf(i: number, size: number): string {
    const head = `<${i}>`;
    let body = '';
    let x = (i * 2654435761) >>> 0;
    while (head.length + body.length < size) {
        x = (x * 1103515245 + 12345) >>> 0;
        body += String.fromCharCode(33 + (x % 90));
    }
    return (head + body).slice(0, size);
}

// ── In-process backend, driven through an injected fake pty ─────────────────

interface FakePty {
    pid: number;
    process: string;
    _onData: ((d: string) => void) | null;
    _onExit: ((e: { exitCode: number; signal?: number }) => void) | null;
    onData: (cb: (d: string) => void) => void;
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
    write: (d: string) => void;
    resize: (c: number, r: number) => void;
    kill: () => void;
}

const spawned: FakePty[] = [];
let nextPid = 5000;

configureInProcessBackend({
    ptySpawn: () => {
        const p: FakePty = {
            pid: nextPid++,
            process: 'fake-shell',
            _onData: null,
            _onExit: null,
            onData(cb) {
                this._onData = cb;
            },
            onExit(cb) {
                this._onExit = cb;
            },
            write() {},
            resize() {},
            kill() {
                this._onExit?.({ exitCode: 0 });
            },
        };
        spawned.push(p);
        return p as never;
    },
    settings: { get: (k) => (k === 'track_cwd' ? 'off' : undefined) },
    snapshots: {
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
        encrypting: () => false,
    },
});

const mgr = () => terminalManager();

function open(id: string) {
    const res = mgr().create({ id, cwd: '/tmp', shell: '/bin/fake', args: [] });
    return { res, pty: spawned[spawned.length - 1] };
}

function feed(pty: FakePty, chunks: string[]) {
    for (const c of chunks) pty._onData?.(c);
}

/** Every reader must agree with the reference, and with each other. */
function expectReaders(id: string, expected: string) {
    expect(mgr().getScrollback(id)).toBe(expected);
    const attach = mgr().create({ id, cwd: '/tmp', shell: '/bin/fake', args: [] });
    expect(attach.existing).toBe(true);
    expect(attach.scrollback).toBe(expected);
}

beforeEach(() => {
    spawned.length = 0;
    mgr().killAll();
});

describe('scrollback contract — in-process backend', { timeout: 60_000 }, () => {
    it('a cold create replays nothing, and a fresh pty has an empty scrollback', () => {
        const { res } = open('fresh');
        expect(res.existing).toBe(false);
        expect(res.scrollback).toBe('');
        expect(mgr().getScrollback('fresh')).toBe('');
    });

    it('under the cap, keeps every chunk verbatim and in order', () => {
        const { pty } = open('under');
        const chunks = [chunkOf(0, 10), chunkOf(1, 4096), '', chunkOf(2, 1), chunkOf(3, 777)];
        feed(pty, chunks);
        expectReaders('under', chunks.join(''));
    });

    it('exactly at the cap, trims nothing', () => {
        const { pty } = open('at');
        const chunks = [chunkOf(0, CAP - 1000), chunkOf(1, 1000)];
        feed(pty, chunks);
        expect(mgr().getScrollback('at')!.length).toBe(CAP);
        expectReaders('at', chunks.join(''));
    });

    it('one code unit over the cap drops exactly the first code unit', () => {
        const { pty } = open('over1');
        const chunks = [chunkOf(0, CAP), 'Z'];
        feed(pty, chunks);
        expectReaders('over1', reference(chunks));
        expect(mgr().getScrollback('over1')!.endsWith('Z')).toBe(true);
    });

    it('past the cap, keeps exactly the last 1,000,000 code units across many mixed chunks', () => {
        const { pty } = open('many');
        const chunks: string[] = [];
        const sizes = [1, 3, 4096, 65536, 17, 1, 1, 200_000, 12, 8191, 8192, 8193];
        for (let i = 0; i < 400; i++) chunks.push(chunkOf(i, sizes[i % sizes.length]));
        expect(chunks.join('').length).toBeGreaterThan(3 * CAP);
        feed(pty, chunks);
        const got = mgr().getScrollback('many')!;
        expect(got.length).toBe(CAP);
        expectReaders('many', reference(chunks));
    });

    it('a single chunk larger than the cap keeps its own last 1,000,000 code units', () => {
        const { pty } = open('huge');
        const chunks = [chunkOf(0, 50), chunkOf(1, CAP + 123_456)];
        feed(pty, chunks);
        expectReaders('huge', reference(chunks));
    });

    it('a stream of one-character chunks past the cap trims exactly', () => {
        const { pty } = open('tiny');
        const chunks: string[] = [];
        // Kept small past the cap: 0.10.0 copies ~1 MB per chunk once full, so
        // a long tail here measures the old cost rather than the contract.
        for (let i = 0; i < CAP + 300; i++) chunks.push(String.fromCharCode(97 + (i % 26)));
        feed(pty, chunks);
        expectReaders('tiny', reference(chunks));
    });

    it('a surrogate pair split ACROSS chunks is rejoined, not altered', () => {
        const { pty } = open('pair');
        const chunks = ['before ' + HIGH, LOW + ' after'];
        feed(pty, chunks);
        expectReaders('pair', 'before ' + HIGH + LOW + ' after');
    });

    it('PINS 0.10.0: trimming counts UTF-16 code units, so it can leave a lone low surrogate first', () => {
        // Not a design goal -- it is what 0.10.0 does, and changing it is a
        // separate decision. xterm renders a lone surrogate as a replacement
        // glyph in the first cell of a replay that is already mid-line.
        const { pty } = open('cutpair');
        const filler = chunkOf(0, CAP - 1);
        const chunks = ['x' + HIGH, LOW + filler];
        feed(pty, chunks);
        const got = mgr().getScrollback('cutpair')!;
        expect(got.length).toBe(CAP);
        expect(got.charCodeAt(0)).toBe(0xde00);
        expectReaders('cutpair', reference(chunks));
    });

    it('PINS 0.10.0: trimming is not escape-aware, so a replay can begin mid-sequence', () => {
        const { pty } = open('cutesc');
        const sgr = ESC + '[38;5;196m';
        const filler = chunkOf(0, CAP - 6);
        const chunks = [sgr, filler];
        feed(pty, chunks);
        const got = mgr().getScrollback('cutesc')!;
        expect(got.startsWith('5;196m')).toBe(true);
        expectReaders('cutesc', reference(chunks));
    });

    it('the default cap is 1,000,000 code units', () => {
        const { pty } = open('default');
        feed(pty, [chunkOf(0, CAP + 1), chunkOf(1, CAP + 1)]);
        expect(mgr().getScrollback('default')!.length).toBe(1_000_000);
    });

    it('an exited pty has no scrollback, and neither does a killed one', () => {
        const a = open('exited');
        feed(a.pty, ['hello']);
        a.pty._onExit?.({ exitCode: 0 });
        expect(mgr().getScrollback('exited')).toBeUndefined();

        open('killed');
        feed(spawned[spawned.length - 1], ['hello']);
        mgr().kill('killed');
        expect(mgr().getScrollback('killed')).toBeUndefined();
    });

    it('a recreated id starts from empty, not from the previous pty', () => {
        const a = open('again');
        feed(a.pty, ['old output']);
        mgr().kill('again');
        const b = open('again');
        expect(b.res.existing).toBe(false);
        feed(b.pty, ['new']);
        expectReaders('again', 'new');
    });

    it('ptys do not share a scrollback', () => {
        const a = open('a');
        const b = open('b');
        feed(a.pty, ['AAA']);
        feed(b.pty, ['BBB']);
        expect(mgr().getScrollback('a')).toBe('AAA');
        expect(mgr().getScrollback('b')).toBe('BBB');
    });

    it('the emitted data stream is every chunk, untrimmed, regardless of the scrollback', () => {
        const seen: string[] = [];
        const onData = (id: string, d: string) => {
            if (id === 'stream') seen.push(d);
        };
        inProcessBackend().on('data', onData);
        try {
            const { pty } = open('stream');
            const chunks = [chunkOf(0, CAP), chunkOf(1, 10)];
            feed(pty, chunks);
            expect(seen).toEqual(chunks);
        } finally {
            inProcessBackend().off('data', onData);
        }
    });
});

// ── HostClient mirror (the T3 replay source) ────────────────────────────────

const noSnapshots: SnapshotStore = {
    readSnapshot: () => null,
    writeSnapshot: () => 1,
    deleteSnapshot: () => undefined,
    encrypting: () => false,
};

function ephemeralPath(): string {
    const tag = crypto.randomBytes(6).toString('hex');
    if (process.platform === 'win32') return `\\\\.\\pipe\\fth-sb-${tag}`;
    return path.join(os.tmpdir(), `fth-sb-${tag}.sock`);
}

function mockHost(socketPath: string, seed: Array<{ id: string; scrollback: string }> = []) {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => {
        sockets.add(sock);
        const dec = new FrameDecoder();
        sock.on('data', (buf: Buffer) => {
            for (const f of dec.push(buf)) {
                const msg = f as ClientMessage;
                const send = (m: HostMessage) => sock.write(encodeFrame(m));
                if (msg.kind === 'hello') {
                    send({ kind: 'hello-ok', seq: msg.seq, protocolVersion: PROTOCOL_VERSION, pid: 1 });
                } else if (msg.kind === 'list') {
                    send({
                        kind: 'list-result',
                        seq: msg.seq,
                        terminals: seed.map((s) => ({ id: s.id, pid: 7, shell: 'sh' })),
                    });
                } else if (msg.kind === 'get-scrollback') {
                    send({
                        kind: 'scrollback-result',
                        seq: msg.seq,
                        scrollback: seed.find((s) => s.id === msg.id)?.scrollback ?? null,
                    });
                } else if (msg.kind === 'create') {
                    send({
                        kind: 'created',
                        seq: msg.seq,
                        result: { id: msg.opts.id, pid: 8, shell: 'sh', existing: false, scrollback: '' },
                    });
                } else if (msg.kind === 'ping') {
                    send({ kind: 'pong', seq: msg.seq });
                }
            }
        });
        sock.on('close', () => sockets.delete(sock));
        sock.on('error', () => sockets.delete(sock));
    });
    return {
        listen: () => new Promise<void>((r) => server.listen(socketPath, r)),
        push: (m: HostMessage) => {
            for (const s of sockets) s.write(encodeFrame(m));
        },
        close: () => {
            for (const s of sockets) s.destroy();
            return new Promise<void>((r) => server.close(() => r()));
        },
    };
}

describe('scrollback contract — HostClient mirror', { timeout: 60_000 }, () => {
    let socketPath: string;
    let host: ReturnType<typeof mockHost> | null = null;
    let client: HostClient | null = null;

    beforeEach(() => {
        socketPath = ephemeralPath();
    });

    afterEach(async () => {
        client?.disconnect();
        client = null;
        if (host) await host.close();
        host = null;
        if (process.platform !== 'win32') fs.rmSync(socketPath, { force: true });
    });

    async function pushAll(id: string, chunks: string[]) {
        let n = 0;
        const done = new Promise<void>((resolve) => {
            client!.on('data', (gotId: string) => {
                if (gotId === id && ++n === chunks.length) resolve();
            });
        });
        for (const data of chunks) host!.push({ kind: 'data', id, data });
        await done;
    }

    it('trims the mirror to exactly the last 1,000,000 code units, and replays it on attach', async () => {
        host = mockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000, { heartbeatIntervalMs: 0 });
        client.create({ id: 'm', cwd: '/tmp' });
        const chunks = [chunkOf(0, 600_000), chunkOf(1, 3), HIGH, LOW, chunkOf(2, 500_000), chunkOf(3, 4096)];
        await pushAll('m', chunks);
        const expected = reference(chunks);
        expect(client.getScrollback('m')).toBe(expected);
        const attach = client.create({ id: 'm', cwd: '/tmp' });
        expect(attach.existing).toBe(true);
        expect(attach.scrollback).toBe(expected);
    });

    it('seeds the mirror verbatim from the host on connect, then appends to it', async () => {
        const seeded = chunkOf(0, 1234);
        host = mockHost(socketPath, [{ id: 's', scrollback: seeded }]);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000, { heartbeatIntervalMs: 0 });
        expect(client.getScrollback('s')).toBe(seeded);
        await pushAll('s', ['more']);
        expect(client.getScrollback('s')).toBe(seeded + 'more');
    });

    it('an exited pty leaves no mirror scrollback', async () => {
        host = mockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, noSnapshots, 2000, { heartbeatIntervalMs: 0 });
        client.create({ id: 'x', cwd: '/tmp' });
        await pushAll('x', ['hi']);
        const exited = new Promise<void>((r) => client!.once('exit', () => r()));
        host.push({ kind: 'exit', id: 'x', exitCode: 0 });
        await exited;
        expect(client.getScrollback('x')).toBeUndefined();
    });
});
