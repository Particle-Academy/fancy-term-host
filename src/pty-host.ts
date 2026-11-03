/**
 * Genie detached pty-host (Tier 3).
 *
 * A HEADLESS Node process — NO electron import — that owns the real ptys so they
 * survive a full quit of the Electron app. The in-app HostClient connects over a
 * local socket (named pipe on Windows, unix domain socket on POSIX) and proxies
 * create/write/resize/kill; the host pushes back `data`/`exit`. The host keeps its
 * OWN scrollback ring buffer per pty so a reattach AFTER a full quit can replay
 * history.
 *
 * Launched detached by background.ts:
 *   spawn(process.execPath, [hostScript], {
 *     detached: true, stdio: 'ignore',
 *     env: { ELECTRON_RUN_AS_NODE: '1', GENIE_USERDATA: <userData>, … }
 *   }).unref()
 *
 * Each pty is a fancy-pty helper process of its own, so an exited terminal cannot
 * retain anything in this long-lived process (#14), and nothing here depends on the
 * runtime's ABI: any Node of the supported version can run this script. Both are
 * why it no longer runs on node-pty, and so is the program lookup: node-pty hands a
 * bare name to the OS, which on Windows searches this process's own folders first.
 *
 * WINDOWS CONSOLES. This process has no console when it is truly detached, and a
 * console app it started without care would get a new, visible one. The only thing
 * it starts is the helper, which fancy-pty spawns with `detached` and `windowsHide`
 * (DETACHED_PROCESS, so no console at all), and whose only child runs on the
 * pseudoconsole. So there is no per-shell console and no agent process, which is
 * what node-pty's `useConptyDll` was set here to avoid (#4).
 *
 * Self-terminates after an idle period with zero live ptys AND no connected
 * client, so a host can never become a forever-orphan.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { open } from '@particle-academy/fancy-pty';
import { createFancyPtySpawn, type FancyAdaptedPty, type FancyPtyOpen } from './fancy-pty';
import {
    encodeFrame,
    FrameDecoder,
    HOST_CAPABILITIES,
    PROTOCOL_VERSION,
    type ClientMessage,
    type HostMessage,
} from './host-protocol';
import { socketPathFor, pidfilePath } from './host-locate';
import { resolveSpawnCwd } from './cwd';
import { PtyRegistry } from './pty-registry';
import { Scrollback } from './scrollback';
import { checkVerbatimOption } from './verbatim';

/**
 * The one adapter the in-process backend's default engine uses too, so the two
 * cannot drift. A static import here, unlike `manager.ts`, because this script
 * exists only to run ptys: if the engine cannot load, the host fails to start and
 * the client falls back to in-process with a status message.
 */
const spawnPty = createFancyPtySpawn(open as FancyPtyOpen);

/** Self-exit after this long with no ptys AND no connected client. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_CHECK_MS = 60 * 1000;

const userData = process.env.GENIE_USERDATA;
if (!userData) {
    // Without a userData path we can't write a pidfile the client can find.
    process.exit(2);
}

enableCrashReports(userData);

/**
 * Write a diagnostic report if this process dies of a FATAL error (#13).
 *
 * This host died once with `0xC0000005` — a native access violation in the pty
 * layer — taking all 22 terminals on the machine with it, and **the only evidence
 * was an exit code in somebody else's log.** Windows Error Reporting produced
 * nothing usable and there were no Crashpad reports for the process, so there was
 * no stack: a fault that killed every terminal was undiagnosable after the fact.
 *
 * `reportOnFatalError` is the one knob that covers a NATIVE fault. A JS
 * `try/catch` cannot — an access violation is not an exception, which is why
 * wrapping the `spawn` call would not have contained the crash this answers.
 *
 * Set at runtime rather than via an argv flag because the detached host is
 * launched by the embedding app through the `spawnDetached` port, so this package
 * does not control its own command line.
 *
 * Best-effort by design: a host that will not start because it could not arrange
 * its own crash reporting is strictly worse than one that starts without it.
 */
function enableCrashReports(dir: string): void {
    try {
        const reports = path.join(dir, 'pty-host', 'reports');
        fs.mkdirSync(reports, { recursive: true });
        process.report!.directory = reports;
        process.report!.reportOnFatalError = true;
    } catch (err) {
        console.error('[pty-host] could not enable crash reports:', err);
    }
}

interface HostPty {
    pty: FancyAdaptedPty;
    shell: string;
    scrollback: Scrollback;
}

const ptys = new PtyRegistry<FancyAdaptedPty>();
const clients = new Set<net.Socket>();
let lastActivity = Date.now();
/** The listening server, set once startServer binds — used by graceful shutdown. */
let activeServer: net.Server | null = null;

function broadcast(msg: HostMessage): void {
    const frame = encodeFrame(msg);
    for (const sock of clients) {
        try {
            sock.write(frame);
        } catch {
            /* dropped client — close handler cleans it up */
        }
    }
}

async function createPty(opts: {
    id: string;
    cwd: string;
    shell?: string;
    args?: string[];
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
    scrollbackMax?: number;
    windowsVerbatimArguments?: boolean;
}): Promise<{ pid: number; shell: string; existing: boolean; scrollback: string }> {
    // Attach-or-spawn is the registry's decision, not this function's. It returns
    // a live pty unchanged, and for a free id calls `make` -- but NEVER while a
    // previous pty for the same id is still being torn down (#13), which is the
    // window a create used to slip through into a second native pseudoconsole.
    const { entry, existing } = await ptys.create(opts.id, () => makePty(opts));

    return {
        pid: entry.pty.pid,
        shell: entry.shell,
        existing,
        scrollback: existing ? entry.scrollback.toString() : '',
    };
}

/** Spawn a pty and wire its streams. Called only for an id the registry says is free. */
function makePty(opts: {
    id: string;
    cwd: string;
    shell?: string;
    args?: string[];
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
    scrollbackMax?: number;
    windowsVerbatimArguments?: boolean;
}): HostPty {
    // Honoured below, so only the boolean check can fire. The client checks too,
    // but anything can write to this socket.
    checkVerbatimOption(opts.windowsVerbatimArguments, true, 'the pty-host');
    const shell = opts.shell ?? defaultShell();
    const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
    // fancy-pty has no `name` to override this, so the resolved TERM is what the
    // shell gets. Most TUIs key their capabilities off it, including the OSC 52
    // clipboard cap.
    env.TERM = env.TERM || 'xterm-256color';

    // Throws for what is refused up front (a batch argument cmd.exe would act on, no
    // helper for this platform), and the `create` case answers that.
    const pty = spawnPty(shell, opts.args ?? [], {
        // Native-convert + validate the requested dir; a stale/foreign/MSYS cwd
        // (e.g. Git Bash's /c/Users/me) would otherwise crash spawn with Windows
        // ERROR_DIRECTORY (267). Falls back to home if unusable.
        cwd: resolveSpawnCwd(opts.cwd),
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        env,
        ...(opts.windowsVerbatimArguments === undefined
            ? {}
            : { windowsVerbatimArguments: opts.windowsVerbatimArguments }),
    });

    const entry: HostPty = { pty, shell, scrollback: new Scrollback(opts.scrollbackMax) };

    pty.onData((data) => {
        entry.scrollback.append(data);
        broadcast({ kind: 'data', id: opts.id, data });
    });
    // What the helper could not start (a program it cannot find, a batch argument
    // only it could judge) arrives after `open()` returned, so after `created` was
    // sent. The adapter has already put the words in the data stream, and the exit
    // follows; this tells the client it was a failed start, not a shell that ended.
    pty.onError((err) => {
        if (pty.childPid === undefined) {
            broadcast({ kind: 'create-failed', id: opts.id, message: err.message });
        }
    });
    pty.onExit(({ exitCode, signal }) => {
        // Teardown confirmed. Until this fires the id stays reserved, which is
        // what keeps a create from overlapping a dispose (#13).
        ptys.settle(opts.id);
        broadcast({ kind: 'exit', id: opts.id, exitCode, signal });
        lastActivity = Date.now();
    });

    return entry;
}

function defaultShell(): string {
    if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
    return process.env.SHELL ?? '/bin/bash';
}

async function handleClientMessage(sock: net.Socket, msg: ClientMessage): Promise<void> {
    lastActivity = Date.now();
    switch (msg.kind) {
        case 'hello':
            reply(sock, {
                kind: 'hello-ok',
                seq: msg.seq,
                protocolVersion: PROTOCOL_VERSION,
                pid: process.pid,
                capabilities: [...HOST_CAPABILITIES],
            });
            break;
        case 'create': {
            let r: Awaited<ReturnType<typeof createPty>>;
            try {
                r = await createPty(msg.opts);
            } catch (err) {
                // Through 0.12.0 this was only logged, to a stderr nobody reads, and
                // the client was left holding a terminal at pid 0 that never exits.
                const message = err instanceof Error ? err.message : String(err);
                console.error('[pty-host] create failed:', message);
                reply(sock, { kind: 'create-failed', seq: msg.seq, id: msg.opts.id, message });
                break;
            }
            reply(sock, {
                kind: 'created',
                seq: msg.seq,
                result: {
                    id: msg.opts.id,
                    pid: r.pid,
                    shell: r.shell,
                    existing: r.existing,
                    scrollback: r.scrollback,
                },
            });
            break;
        }
        case 'write': {
            const e = ptys.get(msg.id);
            if (e) e.pty.write(msg.data);
            break;
        }
        case 'resize': {
            const e = ptys.get(msg.id);
            if (e) {
                e.pty.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0));
            }
            break;
        }
        case 'kill': {
            // Marks the id disposing and kills; the slot is released by onExit
            // (or a bounded watchdog), never synchronously. See PtyRegistry.
            ptys.dispose(msg.id);
            break;
        }
        case 'list':
            reply(sock, {
                kind: 'list-result',
                seq: msg.seq,
                terminals: ptys.entries().map(([id, e]) => ({
                    id,
                    pid: e.pty.pid,
                    shell: e.shell,
                })),
            });
            break;
        case 'set-retained':
            // The host keeps EVERYTHING alive across quit regardless; the
            // retained flag is meaningful to the client (fallback/UX). The host
            // only needs to not-die, which it doesn't. Acknowledge by no-op.
            break;
        case 'get-scrollback':
            reply(sock, {
                kind: 'scrollback-result',
                seq: msg.seq,
                scrollback: ptys.get(msg.id)?.scrollback.toString() ?? null,
            });
            break;
        case 'ping':
            reply(sock, { kind: 'pong', seq: msg.seq });
            break;
        case 'shutdown':
            // Graceful teardown: ack first so the client can finalize (it has
            // already snapshotted from its mirror), then kill every pty, remove
            // the pidfile/socket, and exit promptly. This is the clean path the
            // SIGKILL-by-pidfile interim fix can't take — it lets a consumer
            // bring the host down deterministically (e.g. before an auto-update)
            // instead of waiting on the 10-min idle timeout.
            reply(sock, { kind: 'shutdown-ok', seq: msg.seq });
            shutdown();
            break;
    }
}

function reply(sock: net.Socket, msg: HostMessage): void {
    try {
        sock.write(encodeFrame(msg));
    } catch {
        /* client gone */
    }
}

function startServer(socketPath: string): void {
    // On POSIX a stale socket file blocks bind; remove it first. (On Windows the
    // pipe namespace handles this.)
    if (process.platform !== 'win32') {
        try {
            fs.rmSync(socketPath, { force: true });
        } catch {
            /* ignore */
        }
        try {
            fs.mkdirSync(path.dirname(socketPath), { recursive: true });
        } catch {
            /* ignore */
        }
    }

    const server = net.createServer((sock) => {
        clients.add(sock);
        lastActivity = Date.now();
        const decoder = new FrameDecoder();
        let inOrder = Promise.resolve();
        sock.on('data', (chunk: Buffer) => {
            const frames = decoder.push(chunk);
            if (decoder.desynced) {
                try {
                    sock.destroy();
                } catch {
                    /* ignore */
                }
                return;
            }
            // One at a time, per connection: `create` is async (it may wait for a
            // dispose of the same id), and a frame run beside it finds no pty yet,
            // so a write or kill in the same read as its create was silently lost.
            for (const f of frames) {
                inOrder = inOrder
                    .then(() => handleClientMessage(sock, f as ClientMessage))
                    .catch((err: unknown) => {
                        console.error('[pty-host] client message failed:', err);
                    });
            }
        });
        const drop = () => {
            clients.delete(sock);
            lastActivity = Date.now();
        };
        sock.on('close', drop);
        sock.on('error', drop);
    });
    activeServer = server;

    server.on('error', (err) => {
        // EADDRINUSE: another host beat us to it. Exit quietly — the client will
        // connect to the winner.
        // eslint-disable-next-line no-console
        console.error('[pty-host] server error:', (err as Error).message);
        process.exit(3);
    });

    server.listen(socketPath, () => {
        try {
            writePidfileLocal(socketPath);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[pty-host] pidfile write failed:', (err as Error).message);
        }
    });

    // Idle watchdog: exit when nothing is running and nobody is connected.
    const idle = setInterval(() => {
        if (ptys.size() === 0 && clients.size === 0 && Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
            cleanupAndExit(socketPath, server);
        }
    }, IDLE_CHECK_MS);
    if (typeof idle.unref === 'function') idle.unref();
}

function writePidfileLocal(socketPath: string): void {
    const target = pidfilePath(userData!);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(
        tmp,
        JSON.stringify({
            pid: process.pid,
            socketPath,
            protocolVersion: PROTOCOL_VERSION,
            startedAt: Date.now(),
        }),
    );
    fs.renameSync(tmp, target);
}

function cleanupAndExit(socketPath: string, server: net.Server): void {
    try {
        // Only remove the pidfile if it still points at US (avoid clobbering a
        // successor host that took over the socket).
        const pf = JSON.parse(fs.readFileSync(pidfilePath(userData!), 'utf8'));
        if (pf?.pid === process.pid) fs.rmSync(pidfilePath(userData!), { force: true });
    } catch {
        /* ignore */
    }
    if (process.platform !== 'win32') {
        try {
            fs.rmSync(socketPath, { force: true });
        } catch {
            /* ignore */
        }
    }
    try {
        server.close();
    } catch {
        /* ignore */
    }
    process.exit(0);
}

/**
 * Graceful host shutdown — the clean counterpart to the idle watchdog and to a
 * SIGKILL-by-pidfile. Kills every live pty (so no orphaned shells linger), then
 * removes the pidfile/socket, closes the server, and exits. Triggered by a
 * `shutdown` client request; the client has already snapshotted its mirror, so
 * tearing down the host here loses nothing.
 */
function shutdown(): void {
    for (const [id] of ptys.entries()) {
        ptys.dispose(id);
    }
    if (activeServer) {
        cleanupAndExit(socketPath, activeServer);
    } else {
        process.exit(0);
    }
}

// --- main ------------------------------------------------------------------

const socketPath = socketPathFor(userData);

// A dead-mans-switch so we don't keep a host with no shells AND no client when
// the parent vanished without a clean disconnect: covered by the idle watchdog.
process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[pty-host] uncaught:', err);
});

startServer(socketPath);
