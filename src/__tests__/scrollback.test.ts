import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * The chunk-list Scrollback (0.11.0) and the per-pty cap.
 *
 * `scrollback-contract.test.ts` is the equivalence proof against 0.10.0 and is
 * deliberately left untouched by this change. This file covers what is NEW:
 * the class on its own (differentially, against the dumbest correct model,
 * across caps that straddle its internal coalescing size) and the
 * `scrollbackMax` option on each backend.
 */

import { Scrollback, DEFAULT_SCROLLBACK_MAX, resolveScrollbackMax } from '../scrollback';
import { terminalManager, configureInProcessBackend } from '../manager';
import { HostClient } from '../host-client';
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, type ClientMessage, type HostMessage } from '../host-protocol';
import type { SnapshotStore } from '../sessions';

function reference(chunks: string[], cap: number): string {
    const all = chunks.join('');
    return all.length > cap ? all.slice(all.length - cap) : all;
}

function lcg(seed: number) {
    let x = seed >>> 0;
    return () => {
        x = (x * 1103515245 + 12345) >>> 0;
        return x;
    };
}

function text(rand: () => number, n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(33 + (rand() % 90));
    return s;
}

describe('Scrollback', { timeout: 60_000 }, () => {
    it('defaults to 1,000,000', () => {
        expect(DEFAULT_SCROLLBACK_MAX).toBe(1_000_000);
        expect(new Scrollback().cap).toBe(1_000_000);
    });

    it('resolves caps: finite >= 0 is floored, anything else is the default', () => {
        expect(resolveScrollbackMax(undefined)).toBe(1_000_000);
        expect(resolveScrollbackMax(Number.NaN)).toBe(1_000_000);
        expect(resolveScrollbackMax(-1)).toBe(1_000_000);
        expect(resolveScrollbackMax(Number.POSITIVE_INFINITY)).toBe(1_000_000);
        expect(resolveScrollbackMax(2.7)).toBe(2);
        expect(resolveScrollbackMax(0)).toBe(0);
    });

    it('cap 0 keeps nothing', () => {
        const sb = new Scrollback(0);
        sb.append('abc');
        sb.append('x'.repeat(10_000));
        expect(sb.toString()).toBe('');
        expect(sb.length).toBe(0);
    });

    for (const cap of [1, 5, 100, 8191, 8192, 8193, 50_000]) {
        it(`matches the reference model at cap ${cap}, read after every append`, () => {
            const rand = lcg(cap);
            const sb = new Scrollback(cap);
            const chunks: string[] = [];
            const sizes = [0, 1, 2, 7, 100, 4096, 8191, 8192, 9000, cap - 1, cap, cap + 1, 3 * cap];
            for (let i = 0; i < 300; i++) {
                const n = Math.max(0, sizes[rand() % sizes.length]);
                const c = text(rand, Math.min(n, 30_000));
                chunks.push(c);
                sb.append(c);
                // Reads interleaved with writes exercise the read-compaction path.
                const ref = reference(chunks, cap);
                if (rand() % 3 === 0) expect(sb.toString()).toBe(ref);
                expect(sb.length).toBe(ref.length);
            }
            expect(sb.toString()).toBe(reference(chunks, cap));
        });
    }

    it('matches the reference with no reads until the end', () => {
        const rand = lcg(99);
        const sb = new Scrollback(20_000);
        const chunks: string[] = [];
        for (let i = 0; i < 5000; i++) {
            const c = text(rand, rand() % 64);
            chunks.push(c);
            sb.append(c);
        }
        expect(sb.toString()).toBe(reference(chunks, 20_000));
    });

    it('repeated reads with no write between them return the same value', () => {
        const sb = new Scrollback(10);
        sb.append('0123456789abc');
        const a = sb.toString();
        expect(a).toBe('3456789abc');
        expect(sb.toString()).toBe(a);
        sb.append('Z');
        expect(sb.toString()).toBe('456789abcZ');
    });

    it('takes an initial value, trimmed to the cap', () => {
        expect(new Scrollback(4, 'abcdef').toString()).toBe('cdef');
        expect(new Scrollback(100, 'abc').toString()).toBe('abc');
    });
});

// ── Per-pty cap: in-process backend ─────────────────────────────────────────

type DataCb = (d: string) => void;
const spawned: Array<{ emit: DataCb }> = [];

configureInProcessBackend({
    ptySpawn: () => {
        let onData: DataCb | null = null;
        let onExit: ((e: { exitCode: number }) => void) | null = null;
        const p = {
            pid: 1,
            process: 'fake',
            onData(cb: DataCb) {
                onData = cb;
            },
            onExit(cb: (e: { exitCode: number }) => void) {
                onExit = cb;
            },
            write() {},
            resize() {},
            kill() {
                onExit?.({ exitCode: 0 });
            },
            emit(d: string) {
                onData?.(d);
            },
        };
        spawned.push(p);
        return p as never;
    },
    settings: { get: () => undefined },
    snapshots: {
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
        encrypting: () => false,
    },
});

describe('scrollbackMax — in-process backend', () => {
    beforeEach(() => {
        spawned.length = 0;
        terminalManager().killAll();
    });

    it('caps one pty without touching another', () => {
        const m = terminalManager();
        m.create({ id: 'small', cwd: '/tmp', shell: 'x', args: [], scrollbackMax: 100 });
        const small = spawned[spawned.length - 1];
        m.create({ id: 'big', cwd: '/tmp', shell: 'x', args: [] });
        const big = spawned[spawned.length - 1];
        const payload = 'abcdefghij'.repeat(1000);
        small.emit(payload);
        big.emit(payload);
        expect(m.getScrollback('small')).toBe(payload.slice(-100));
        expect(m.getScrollback('big')).toBe(payload);
        const attach = m.create({ id: 'small', cwd: '/tmp' });
        expect(attach.scrollback).toBe(payload.slice(-100));
    });

    it('is fixed at spawn: an attach asking for a different cap changes nothing', () => {
        const m = terminalManager();
        m.create({ id: 'fixed', cwd: '/tmp', shell: 'x', args: [], scrollbackMax: 10 });
        const p = spawned[spawned.length - 1];
        m.create({ id: 'fixed', cwd: '/tmp', scrollbackMax: 1000 });
        p.emit('0123456789ABCDEFGHIJ');
        expect(m.getScrollback('fixed')).toBe('ABCDEFGHIJ');
    });

    it('scrollbackMax: 0 keeps nothing but still streams every chunk', () => {
        const m = terminalManager();
        const seen: string[] = [];
        const onData = (id: string, d: string) => {
            if (id === 'none') seen.push(d);
        };
        m.on('data', onData);
        m.create({ id: 'none', cwd: '/tmp', shell: 'x', args: [], scrollbackMax: 0 });
        spawned[spawned.length - 1].emit('hello');
        expect(m.getScrollback('none')).toBe('');
        expect(seen).toEqual(['hello']);
    });
});

// ── Per-pty cap: HostClient (forwarded to the host, and applied to the mirror)

const noSnapshots: SnapshotStore = {
    readSnapshot: () => null,
    writeSnapshot: () => 1,
    deleteSnapshot: () => undefined,
    encrypting: () => false,
};

function ephemeralPath(): string {
    const tag = crypto.randomBytes(6).toString('hex');
    if (process.platform === 'win32') return `\\\\.\\pipe\\fth-sbmax-${tag}`;
    return path.join(os.tmpdir(), `fth-sbmax-${tag}.sock`);
}

describe('scrollbackMax — HostClient', () => {
    let socketPath: string;
    let server: net.Server | null = null;
    const sockets = new Set<net.Socket>();
    const received: ClientMessage[] = [];
    let seed: Array<{ id: string; scrollback: string }> = [];
    let client: HostClient | null = null;

    beforeEach(async () => {
        socketPath = ephemeralPath();
        received.length = 0;
        seed = [];
        server = net.createServer((sock) => {
            sockets.add(sock);
            const dec = new FrameDecoder();
            sock.on('data', (buf: Buffer) => {
                for (const f of dec.push(buf)) {
                    const msg = f as ClientMessage;
                    received.push(msg);
                    const send = (m: HostMessage) => sock.write(encodeFrame(m));
                    if (msg.kind === 'hello') {
                        send({ kind: 'hello-ok', seq: msg.seq, protocolVersion: PROTOCOL_VERSION, pid: 1 });
                    } else if (msg.kind === 'list') {
                        send({
                            kind: 'list-result',
                            seq: msg.seq,
                            terminals: seed.map((s) => ({ id: s.id, pid: 2, shell: 'sh' })),
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
                            result: { id: msg.opts.id, pid: 3, shell: 'sh', existing: false, scrollback: '' },
                        });
                    }
                }
            });
            sock.on('close', () => sockets.delete(sock));
            sock.on('error', () => sockets.delete(sock));
        });
    });

    afterEach(async () => {
        client?.disconnect();
        client = null;
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => server!.close(() => r()));
        if (process.platform !== 'win32') fs.rmSync(socketPath, { force: true });
    });

    async function connect() {
        await new Promise<void>((r) => server!.listen(socketPath, r));
        client = await HostClient.connect(socketPath, noSnapshots, 2000, { heartbeatIntervalMs: 0 });
    }

    it('forwards scrollbackMax to the host and trims the mirror to it', async () => {
        await connect();
        client!.create({ id: 'c', cwd: '/tmp', scrollbackMax: 5 });
        const got = new Promise<void>((r) => client!.once('data', () => r()));
        for (const s of sockets) s.write(encodeFrame({ kind: 'data', id: 'c', data: '0123456789' } as HostMessage));
        await got;
        expect(client!.getScrollback('c')).toBe('56789');
        const create = received.find((m) => m.kind === 'create');
        expect(create && create.kind === 'create' && create.opts.scrollbackMax).toBe(5);
    });

    it('never trims a seeded mirror below what the host already holds', async () => {
        const big = 'q'.repeat(DEFAULT_SCROLLBACK_MAX + 10);
        seed = [{ id: 'wide', scrollback: big }];
        await connect();
        expect(client!.getScrollback('wide')).toBe(big);
    });
});
