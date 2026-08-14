import net from 'node:net';
import { EventEmitter } from 'node:events';
import type { PtyBackend } from './backend';
import type { CreateTerminalOpts, TerminalInfo, AttachResult } from './types';
import {
    encodeFrame,
    FrameDecoder,
    PROTOCOL_VERSION,
    type ClientMessage,
    type HostMessage,
} from './host-protocol';
import type { SnapshotStore } from './sessions';

/**
 * HostClient — the Tier 3 PtyBackend that proxies every call to the DETACHED
 * pty-host over a local socket (named pipe on Windows, unix domain socket on
 * POSIX). The real node-pty instances live in the host, so they survive a full
 * quit of the Electron app; the client just relays create/write/resize/kill and
 * fans the host's pushed `data`/`exit` messages out to subscribers.
 *
 * Design constraints that shape this:
 *
 *   • ipc.ts calls are SYNCHRONOUS (create returns an AttachResult, write returns
 *     a boolean) because the in-process backend is synchronous. We can't make the
 *     socket round-trip synchronous, so the client keeps a LOCAL MIRROR of host
 *     state — known terminal ids, their pid/shell, retained flags, and a local
 *     scrollback ring fed from pushed `data` — and answers create/list/isLive/
 *     scrollback from that mirror immediately. The actual create request is sent
 *     fire-and-forget AFTER seeding the mirror; the host echoes the real pid via
 *     a `created` reply which we reconcile. This keeps the existing IPC contract
 *     intact without rewriting it async.
 *
 *   • On connect we `hello` (version handshake) then `list` + `get-scrollback`
 *     for each live host pty, seeding the mirror so a reattach-after-quit replays
 *     the host's retained history into the renderer exactly like a warm rejoin.
 *
 * Connection failures surface via the `error` event; the lifecycle layer
 * (background.ts) catches a failed connect/spawn and falls back to the in-process
 * backend with a non-fatal toast.
 */

const SCROLLBACK_MAX = 1_000_000;

/**
 * How long a correlated request waits before giving up. Generous, because a
 * `get-scrollback` on a busy pty is real work — the point is to bound the wait,
 * not to be strict about it.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How often the client pings the host. The host has always answered `ping` with
 * `pong`; nothing ever sent one, so a hung host was undetectable. This is the
 * only signal that distinguishes "host is wedged" from "host is idle", since a
 * wedged host holds its socket open.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

/** Tunables for {@link HostClient.connect}. */
export interface HostClientOptions {
    /** Bound on a correlated request. Default 10s. */
    requestTimeoutMs?: number;
    /** Heartbeat period. Default 5s. Set to 0 to disable the heartbeat. */
    heartbeatIntervalMs?: number;
}

interface MirrorEntry {
    pid: number;
    shell: string;
    scrollback: string;
}

export class HostClient extends EventEmitter implements PtyBackend {
    private socket: net.Socket | null = null;
    private readonly decoder = new FrameDecoder();
    private seq = 0;
    /**
     * In-flight requests. Each carries its rejector and timeout handle, not just
     * a resolver: a request that can only ever be RESOLVED is a request that
     * hangs forever when the host stops answering, which is exactly what a
     * wedged host does (its `uncaughtException` handler is non-fatal, so the
     * socket stays open and no close/error path ever fires).
     */
    private readonly pending = new Map<
        number,
        { resolve: (msg: HostMessage) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
    >();

    private heartbeat: NodeJS.Timeout | null = null;
    private requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;

    private readonly mirror = new Map<string, MirrorEntry>();
    private readonly retained = new Set<string>();
    /** Host pid, learned from hello-ok — surfaced for diagnostics. */
    hostPid = 0;
    private connected = false;

    private constructor(
        private readonly socketPath: string,
        private readonly snapshots: SnapshotStore,
    ) {
        super();
    }

    /**
     * Connect to a running host at `socketPath`, perform the version handshake,
     * and seed the local mirror from the host's live ptys (list + per-pty
     * scrollback). Resolves to a ready client, or rejects on connect failure /
     * version mismatch / timeout — the caller then falls back to in-process.
     *
     * `snapshots` is the injected snapshot store used by cold-create to surface
     * any on-disk previous-session snapshot (was a direct `./sessions` import).
     */
    static connect(
        socketPath: string,
        snapshots: SnapshotStore,
        timeoutMs = 3000,
        options: HostClientOptions = {},
    ): Promise<HostClient> {
        return new Promise<HostClient>((resolve, reject) => {
            const client = new HostClient(socketPath, snapshots);
            client.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
            const heartbeatMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
            const sock = net.createConnection(socketPath);
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try {
                    sock.destroy();
                } catch {
                    /* ignore */
                }
                reject(new Error('pty-host connect timeout'));
            }, timeoutMs);

            sock.on('error', (err) => {
                if (settled) {
                    client.handleSocketError(err);
                    return;
                }
                settled = true;
                clearTimeout(timer);
                reject(err);
            });

            sock.once('connect', async () => {
                client.socket = sock;
                client.wireSocket(sock);
                try {
                    const hello = (await client.request({
                        kind: 'hello',
                        seq: client.nextSeq(),
                        protocolVersion: PROTOCOL_VERSION,
                    })) as Extract<HostMessage, { kind: 'hello-ok' }>;
                    if (hello.protocolVersion !== PROTOCOL_VERSION) {
                        throw new Error(
                            `pty-host protocol mismatch: host=${hello.protocolVersion} client=${PROTOCOL_VERSION}`,
                        );
                    }
                    client.hostPid = hello.pid;
                    client.connected = true;
                    await client.seedFromHost();
                    client.startHeartbeat(heartbeatMs);
                    settled = true;
                    clearTimeout(timer);
                    resolve(client);
                } catch (err) {
                    settled = true;
                    clearTimeout(timer);
                    try {
                        sock.destroy();
                    } catch {
                        /* ignore */
                    }
                    reject(err as Error);
                }
            });
        });
    }

    private wireSocket(sock: net.Socket): void {
        sock.on('data', (chunk: Buffer) => {
            const frames = this.decoder.push(chunk);
            if (this.decoder.desynced) {
                this.handleSocketError(new Error('pty-host stream desync'));
                return;
            }
            for (const frame of frames) this.handleHostMessage(frame as HostMessage);
        });
        sock.on('close', () => {
            this.stopHeartbeat();
            // In-flight requests can never be answered now; fail them rather
            // than leaving each to time out against a socket that is gone.
            this.rejectAllPending(new Error('pty-host connection closed'));
            if (this.connected) {
                this.connected = false;
                this.emit('error', new Error('pty-host connection closed'));
            }
        });
    }

    private handleSocketError(err: Error): void {
        if (!this.connected) return;
        this.connected = false;
        this.stopHeartbeat();
        this.rejectAllPending(err);
        this.emit('error', err);
    }

    private handleHostMessage(msg: HostMessage): void {
        switch (msg.kind) {
            case 'data': {
                const entry = this.mirror.get(msg.id);
                if (entry) {
                    const next = entry.scrollback + msg.data;
                    entry.scrollback =
                        next.length > SCROLLBACK_MAX ? next.slice(-SCROLLBACK_MAX) : next;
                }
                this.emit('data', msg.id, msg.data);
                return;
            }
            case 'exit': {
                this.mirror.delete(msg.id);
                this.retained.delete(msg.id);
                this.emit('exit', msg.id, {
                    exitCode: msg.exitCode,
                    signal: msg.signal,
                });
                return;
            }
            default: {
                // Replies carry a seq — resolve the matching pending request.
                const seq = (msg as { seq?: number }).seq;
                if (seq != null) {
                    const entry = this.pending.get(seq);
                    if (entry) {
                        this.clearPending(seq);
                        entry.resolve(msg);
                    }
                }
            }
        }
    }

    private nextSeq(): number {
        return ++this.seq;
    }

    /** Send a request and await the correlated reply. */
    private request(msg: ClientMessage & { seq: number }): Promise<HostMessage> {
        return new Promise<HostMessage>((resolve, reject) => {
            if (!this.socket) {
                reject(new Error('pty-host not connected'));
                return;
            }
            // Bounded. Without this a wedged host — socket open, answering
            // nothing — left `create` / `list` / `get-scrollback` pending
            // forever, and the caller had no way to tell that from slow.
            const timer = setTimeout(() => {
                this.pending.delete(msg.seq);
                reject(new Error(`pty-host request "${msg.kind}" timed out after ${this.requestTimeoutMs}ms`));
            }, this.requestTimeoutMs);
            timer.unref?.();

            this.pending.set(msg.seq, { resolve, reject, timer });
            try {
                this.socket.write(encodeFrame(msg));
            } catch (err) {
                this.clearPending(msg.seq);
                reject(err as Error);
            }
        });
    }

    private clearPending(seq: number): void {
        const entry = this.pending.get(seq);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(seq);
    }

    /**
     * Fail every in-flight request. Called when the connection is known to be
     * gone, so callers hear about it immediately instead of waiting out each
     * individual timeout on a socket that can no longer answer.
     */
    private rejectAllPending(err: Error): void {
        const entries = [...this.pending.entries()];
        this.pending.clear();
        for (const [, entry] of entries) {
            clearTimeout(entry.timer);
            entry.reject(err);
        }
    }

    /**
     * Ping the host on an interval and treat a missed pong as a host loss.
     *
     * This is what makes a HUNG host detectable at all. A cleanly-dying host
     * closes its socket and the existing `'close'` handler fires; a wedged one
     * does not, so without an active probe there is no event to bind to and the
     * consumer just sees every terminal stop responding.
     *
     * The ping rides `request()`, so the bounded request timeout is also the
     * liveness timeout — one mechanism, not two that can disagree.
     */
    private startHeartbeat(intervalMs: number): void {
        if (intervalMs <= 0) return;
        this.stopHeartbeat();
        this.heartbeat = setInterval(() => {
            if (!this.connected || !this.socket) return;
            void this.request({ kind: 'ping', seq: this.nextSeq() }).catch((err: Error) => {
                // Only a live client can be "lost"; handleSocketError is a no-op
                // once disconnected, so a late rejection during teardown is safe.
                this.handleSocketError(
                    new Error(`pty-host heartbeat failed: ${err.message}`),
                );
            });
        }, intervalMs);
        this.heartbeat.unref?.();
    }

    private stopHeartbeat(): void {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
    }

    /** Fire-and-forget send for messages with no reply (write/resize/kill/…). */
    private send(msg: ClientMessage): void {
        if (!this.socket) return;
        try {
            this.socket.write(encodeFrame(msg));
        } catch {
            /* surfaced via the socket error/close handlers */
        }
    }

    /** Seed the local mirror from the host's live ptys after a (re)connect. */
    private async seedFromHost(): Promise<void> {
        const listed = (await this.request({
            kind: 'list',
            seq: this.nextSeq(),
        })) as Extract<HostMessage, { kind: 'list-result' }>;
        for (const t of listed.terminals) {
            const sb = (await this.request({
                kind: 'get-scrollback',
                seq: this.nextSeq(),
                id: t.id,
            })) as Extract<HostMessage, { kind: 'scrollback-result' }>;
            this.mirror.set(t.id, {
                pid: t.pid,
                shell: t.shell,
                scrollback: sb.scrollback ?? '',
            });
        }
    }

    /** Ids the host currently has live — used by the lifecycle layer to drive
     *  the reattach (renderer remounts these specs, replaying host scrollback). */
    liveIds(): string[] {
        return Array.from(this.mirror.keys());
    }

    isConnected(): boolean {
        return this.connected;
    }

    /**
     * Gracefully shut the host DOWN — the deliberate counterpart to
     * `disconnect()` (which leaves the host running). Asks the host to kill its
     * ptys, remove its pidfile/socket, and exit cleanly, then drops the local
     * socket. Use this when a consumer needs the host genuinely gone — e.g.
     * before an Electron auto-update whose installer must overwrite the binary
     * the host runs on — INSTEAD of SIGKILLing by pidfile pid, which skips the
     * host's own cleanup.
     *
     * The client mirror already holds the live scrollback, so snapshot via the
     * SnapshotStore BEFORE calling this if you want T1 history to survive.
     *
     * Resolves once the host acknowledges (`shutdown-ok`) or the connection
     * closes (the host exited), whichever comes first; never rejects — a host
     * that's already gone is a successful shutdown.
     */
    shutdownHost(timeoutMs = 2000): Promise<void> {
        if (!this.socket || !this.connected) {
            this.disconnect();
            return Promise.resolve();
        }
        // Mark not-connected up front so the host's imminent socket close (it
        // exits right after acking) doesn't surface as a spurious `error`.
        this.connected = false;
        return new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                this.disconnect();
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            // The host exits right after acking, so the socket close races the
            // reply — either one means the host is down. Resolve on both.
            this.socket?.once('close', finish);
            this.request({ kind: 'shutdown', seq: this.nextSeq() })
                .then(finish)
                .catch(finish);
        });
    }

    /** Disconnect WITHOUT killing host ptys (before-quit leave-running). */
    disconnect(): void {
        this.connected = false;
        this.stopHeartbeat();
        this.rejectAllPending(new Error('pty-host client disconnected'));
        if (this.socket) {
            try {
                this.socket.end();
            } catch {
                /* ignore */
            }
            this.socket = null;
        }
    }

    // --- PtyBackend ---------------------------------------------------------

    create(opts: CreateTerminalOpts): AttachResult {
        const existing = this.mirror.get(opts.id);
        if (existing) {
            // Warm rejoin from the mirror — the host already runs this pty and we
            // hold its replayed scrollback. No new spawn request.
            return {
                id: opts.id,
                pid: existing.pid,
                shell: existing.shell,
                existing: true,
                scrollback: existing.scrollback,
            };
        }
        // Cold create: seed the mirror immediately (pid 0 until the host echoes
        // the real one), fire the create request, and surface any on-disk
        // snapshot exactly like the in-process backend does on a cold spawn.
        this.mirror.set(opts.id, { pid: 0, shell: opts.shell ?? '', scrollback: '' });
        this.request({ kind: 'create', seq: this.nextSeq(), opts })
            .then((reply) => {
                if (reply.kind !== 'created') return;
                const entry = this.mirror.get(opts.id);
                if (entry) {
                    entry.pid = reply.result.pid;
                    entry.shell = reply.result.shell;
                }
            })
            .catch(() => {
                /* connection error surfaces via the error event → fallback */
            });
        const snap = this.snapshots.readSnapshot(opts.id);
        return {
            id: opts.id,
            pid: 0,
            shell: opts.shell ?? '',
            existing: false,
            scrollback: '',
            snapshot: snap ?? undefined,
        };
    }

    write(id: string, data: string): boolean {
        if (!this.mirror.has(id)) return false;
        this.send({ kind: 'write', id, data });
        return true;
    }

    resize(id: string, cols: number, rows: number): boolean {
        if (!this.mirror.has(id)) return false;
        this.send({
            kind: 'resize',
            id,
            cols: Math.max(1, cols | 0),
            rows: Math.max(1, rows | 0),
        });
        return true;
    }

    kill(id: string): boolean {
        const had = this.mirror.delete(id);
        this.retained.delete(id);
        this.send({ kind: 'kill', id });
        return had;
    }

    /**
     * NO-OP for the host backend. The whole point of Tier 3 is that ptys survive
     * a full quit, so the before-quit teardown must NOT kill them. The lifecycle
     * layer disconnects the client and leaves the host running instead.
     */
    killAll(): void {
        /* intentionally empty — host ptys survive quit */
    }

    list(): TerminalInfo[] {
        return Array.from(this.mirror.entries()).map(([id, e]) => ({
            id,
            pid: e.pid,
            shell: e.shell,
        }));
    }

    isLive(id: string): boolean {
        return this.mirror.has(id);
    }

    setRetained(id: string, retained: boolean): void {
        if (retained) this.retained.add(id);
        else this.retained.delete(id);
        this.send({ kind: 'set-retained', id, retained });
    }

    isRetained(id: string): boolean {
        return this.retained.has(id);
    }

    retainedCount(): number {
        return this.retained.size;
    }

    retainedIds(): string[] {
        return Array.from(this.retained);
    }

    getScrollback(id: string): string | undefined {
        return this.mirror.get(id)?.scrollback;
    }
}
