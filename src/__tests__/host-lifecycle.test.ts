import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, type ClientMessage, type HostMessage } from '../host-protocol';

/**
 * Tier 3 — host-lifecycle connect-or-spawn recovery (#8).
 *
 * The transport is single-instance, so a wedged/old incumbent that still owns it
 * would deadlock every fresh spawn and swallow every client `hello`. The
 * lifecycle must therefore (a) connect to a genuinely-responsive host, (b) reap
 * a "usable-looking" but unresponsive incumbent and respawn a working host, and
 * (c) fall back to in-process when no host can be brought up. We drive
 * initTerminalBackend through configureHostLifecycle with REAL protocol-speaking
 * mock hosts + a fake spawner (no separate process needed).
 */

// node-pty fake so the in-process fallback backend can be constructed if touched.
vi.mock('node-pty', () => ({
    spawn: () => ({
        pid: 1,
        process: 'fake',
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill: () => {},
    }),
}));

import { initTerminalBackend, isHostBacked, configureHostLifecycle } from '../host-lifecycle';
import { configureInProcessBackend } from '../manager';
import { readPidfile, writePidfile } from '../host-locate';
import type { HostSpawner, SettingsProvider } from '../ports';
import type { SnapshotStore } from '../sessions';
import type { HostStatus } from '../backend';

const noSnapshots: SnapshotStore = {
    readSnapshot: () => null,
    writeSnapshot: () => 1,
    deleteSnapshot: () => undefined,
};

function ephemeralSocket(): string {
    const tag = crypto.randomBytes(6).toString('hex');
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\genie-lifecycle-${tag}`
        : path.join(os.tmpdir(), `genie-lifecycle-${tag}.sock`);
}

/** A minimal protocol host: answers hello + an empty list (enough for connect+seed). */
function startMockHost(socketPath: string) {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => {
        sockets.add(sock);
        const dec = new FrameDecoder();
        sock.on('data', (chunk: Buffer) => {
            for (const f of dec.push(chunk)) {
                const msg = f as ClientMessage;
                if (msg.kind === 'hello') {
                    reply(sock, { kind: 'hello-ok', seq: msg.seq, protocolVersion: PROTOCOL_VERSION, pid: 4242 });
                } else if (msg.kind === 'list') {
                    reply(sock, { kind: 'list-result', seq: msg.seq, terminals: [] });
                }
            }
        });
        sock.on('close', () => sockets.delete(sock));
        sock.on('error', () => sockets.delete(sock));
    });
    function reply(sock: net.Socket, msg: HostMessage) {
        try { sock.write(encodeFrame(msg)); } catch { /* ignore */ }
    }
    return {
        listen: () => new Promise<void>((r) => server.listen(socketPath, r)),
        close: () => {
            for (const s of sockets) s.destroy();
            return new Promise<void>((r) => server.close(() => r()));
        },
    };
}

let userData: string;
let settings: Record<string, string>;
const statuses: HostStatus[] = [];
const settingsProvider: SettingsProvider = { get: (k) => settings[k] };
const openHosts: Array<{ close: () => Promise<void> }> = [];

beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-lifecycle-'));
    settings = { detached_terminals: 'on' };
    statuses.length = 0;
    configureInProcessBackend({ settings: settingsProvider, snapshots: noSnapshots });
});

afterEach(async () => {
    for (const h of openHosts.splice(0)) {
        try { await h.close(); } catch { /* ignore */ }
    }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
});

function configure(spawner: HostSpawner) {
    configureHostLifecycle({
        spawner,
        settings: settingsProvider,
        snapshots: noSnapshots,
        onHostStatus: (s) => statuses.push(s),
    });
}

describe('connect-or-spawn recovery (#8)', () => {
    it('connects to a genuinely-responsive existing host (no spawn)', async () => {
        const socketPath = ephemeralSocket();
        const host = startMockHost(socketPath);
        openHosts.push(host);
        await host.listen();
        writePidfile(userData, { pid: process.pid, socketPath, protocolVersion: PROTOCOL_VERSION, startedAt: Date.now() });

        let spawned = false;
        configure({
            resolveHostScript: () => 'pty-host.js',
            userDataDir: () => userData,
            spawnDetached: () => { spawned = true; },
        });

        const res = await initTerminalBackend();
        expect(res.host).toBe(true);
        expect(isHostBacked()).toBe(true);
        expect(spawned).toBe(false); // a live incumbent must NOT trigger a respawn
    });

    it('reaps a usable-looking but UNRESPONSIVE incumbent and respawns a working host', async () => {
        // Incumbent: pidfile looks usable (alive pid + right version) but its
        // socket has NO listener → the handshake times out → it must be reaped.
        const deadSocket = ephemeralSocket();
        writePidfile(userData, { pid: process.pid, socketPath: deadSocket, protocolVersion: PROTOCOL_VERSION, startedAt: Date.now() });

        // The "spawn" brings up a real, responsive host on a fresh socket and
        // writes a fresh pidfile — exactly what a healthy detached host does.
        let spawned = false;
        configure({
            resolveHostScript: () => 'pty-host.js',
            userDataDir: () => userData,
            spawnDetached: () => {
                spawned = true;
                const socketPath = ephemeralSocket();
                const host = startMockHost(socketPath);
                openHosts.push(host);
                void host.listen().then(() =>
                    writePidfile(userData, { pid: process.pid, socketPath, protocolVersion: PROTOCOL_VERSION, startedAt: Date.now() }),
                );
            },
        });

        const res = await initTerminalBackend();
        expect(spawned).toBe(true);
        expect(res.host).toBe(true);
        expect(isHostBacked()).toBe(true);
    });

    it('falls back to in-process (with a toast) when no host script is available', async () => {
        const deadSocket = ephemeralSocket();
        writePidfile(userData, { pid: process.pid, socketPath: deadSocket, protocolVersion: PROTOCOL_VERSION, startedAt: Date.now() });

        configure({
            resolveHostScript: () => null, // packaging risk — can't spawn
            userDataDir: () => userData,
            spawnDetached: () => { throw new Error('should not spawn with a null script'); },
        });

        const res = await initTerminalBackend();
        expect(res.host).toBe(false);
        expect(isHostBacked()).toBe(false);
        expect(statuses.some((s) => /in-process/i.test(s.message))).toBe(true);
        // The stale pidfile was reaped/cleared.
        expect(readPidfile(userData)).toBeNull();
    });
});
