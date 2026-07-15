import {
    readPidfile,
    pidfileUsable,
    deletePidfile,
    isPidAlive,
    terminateHost,
    awaitPidGone,
    type Pidfile,
} from './host-locate';
import { HostClient } from './host-client';
import { setActiveBackend, inProcessBackend } from './manager';
import type { SettingsProvider, HostSpawner } from './ports';
import type { SnapshotStore } from './sessions';
import type { HostStatus } from './backend';

/**
 * Tier 3 lifecycle: decide the backend at app-ready, manage the detached
 * pty-host, and handle graceful fallback.
 *
 * The flow (initTerminalBackend):
 *   1. If the `detached_terminals` setting is OFF (the default — see below) →
 *      use the in-process backend. Done. This is today's T1/T2 behaviour.
 *   2. ON → try to CONNECT to an existing host (pidfile alive + version match +
 *      socket reachable). Success → HostClient, reattach existing ptys.
 *   3. No usable host → SPAWN one detached, await its pidfile, then connect.
 *   4. Any failure (spawn, timeout, version mismatch, socket error) → fall back
 *      to the in-process backend and surface a NON-FATAL toast. The app stays
 *      fully functional.
 *
 * SETTING DEFAULT — `detached_terminals` defaults OFF.
 *   Rationale: T3 is the heaviest tier and its #1 risk is the dev-vs-packaged
 *   host-script path. Shipping it default-ON would put every user on an
 *   unproven detached process the first launch after upgrade. Default-OFF means
 *   the proven in-process T1/T2 path remains the out-of-box experience; users
 *   opt in via Settings → Terminal → "Keep terminals running after quit".
 *
 * RUNTIME-AGNOSTIC: this module imports neither `electron` nor `../db`. The
 * connect-or-spawn-or-fallback LOGIC is core; the Electron specifics are
 * injected:
 *   - HostSpawner       — resolveHostScript / spawnDetached / userDataDir
 *                         (was app.getPath + child_process.spawn with execPath +
 *                          ELECTRON_RUN_AS_NODE).
 *   - SettingsProvider  — the `detached_terminals` read (was getAllSettings).
 *   - SnapshotStore     — passed to HostClient for cold-create snapshot probe.
 *   - onHostStatus      — the fallback toast sink, emits `host-status` instead of
 *                         a direct BrowserWindow broadcast.
 * Genie's adapter (genie-adapter.ts) supplies all four via configureHostLifecycle.
 */

interface HostLifecycleDeps {
    spawner: HostSpawner;
    settings: SettingsProvider;
    snapshots: SnapshotStore;
    onHostStatus: (status: HostStatus) => void;
}

let deps: HostLifecycleDeps | null = null;

/**
 * Wire the host lifecycle's injected ports. Called once by the adapter at
 * app-ready, before initTerminalBackend. NEVER configured = in-process only
 * (detachedEnabled below returns false defensively).
 */
export function configureHostLifecycle(d: HostLifecycleDeps): void {
    deps = d;
}

let client: HostClient | null = null;
let usingHost = false;

/** Emit the fallback host-status (was a direct BrowserWindow broadcast). */
function status(message: string, level: 'info' | 'warn' = 'warn'): void {
    deps?.onHostStatus({ message, level });
}

function detachedEnabled(): boolean {
    try {
        return deps?.settings.get('detached_terminals') === 'on';
    } catch {
        return false;
    }
}

/** True when the active backend is the detached host (diagnostics + before-quit). */
export function isHostBacked(): boolean {
    return usingHost && !!client && client.isConnected();
}

export function getHostClient(): HostClient | null {
    return client;
}

/** Poll for the pidfile to appear + become usable, up to `timeoutMs`. */
async function awaitUsableHost(userData: string, timeoutMs = 4000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pf = readPidfile(userData);
        if (pidfileUsable(pf)) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return false;
}

/**
 * Reap a stale/wedged host so its SINGLE-INSTANCE transport (Windows named pipe
 * / POSIX socket) frees up, then clear the pidfile. If the recorded pid is still
 * alive we terminate it and wait for it to exit before returning, so a fresh
 * host won't race it for the transport. Best-effort — never throws. (#8)
 */
async function reapHost(userData: string, pf: Pidfile | null): Promise<void> {
    if (pf && isPidAlive(pf.pid) && terminateHost(pf.pid)) {
        await awaitPidGone(pf.pid, 2000);
    }
    deletePidfile(userData);
}

/**
 * Connect to a healthy detached host, spawning one (and reaping any stale or
 * wedged incumbent) as needed. Returns a connected HostClient, or null when no
 * host could be brought up (the caller then falls back to in-process). Only the
 * post-spawn connect can throw out; the incumbent-liveness connect is caught and
 * recovered from here.
 *
 * Why the reap matters (#8): the transport is single-instance, so a wedged or
 * old-version incumbent that still owns it deadlocks EVERY fresh spawn
 * (EADDRINUSE) and EVERY client — it accepts the socket but never answers
 * `hello`, so the client just times out, forever. A "usable-looking" pidfile
 * (alive pid + matching protocol version) is therefore NOT trusted on its own:
 * the only real proof of life is a completed handshake, and a host that fails it
 * is reaped so a fresh one can take the transport.
 */
async function connectOrSpawnHost(
    userData: string,
    spawner: HostSpawner,
    snapshots: SnapshotStore,
): Promise<HostClient | null> {
    let pf = readPidfile(userData);

    if (pidfileUsable(pf)) {
        // Looks good — but only a completed handshake proves the host is alive.
        // A wedged host (accepts the socket, never answers hello — the #8 zombie)
        // rejects here on timeout.
        try {
            return await HostClient.connect(pf!.socketPath, snapshots);
        } catch {
            // Usable-looking but unresponsive → reap it, then respawn below.
            await reapHost(userData, pf);
            pf = null;
        }
    } else if (pf) {
        // Present but unusable (dead pid, or a version-mismatched host still
        // running). If its pid is ALIVE it still owns the transport and would
        // EADDRINUSE a fresh spawn — reap it first.
        await reapHost(userData, pf);
        pf = null;
    }

    // No usable host → spawn a fresh one.
    deletePidfile(userData);
    const hostScript = spawner.resolveHostScript();
    if (!hostScript) return null; // packaging risk — caller toasts.
    spawner.spawnDetached(hostScript, { GENIE_USERDATA: userData });
    const up = await awaitUsableHost(userData);
    if (!up) return null;
    pf = readPidfile(userData);
    if (!pf) return null;
    return await HostClient.connect(pf.socketPath, snapshots);
}

/**
 * Initialise the terminal backend at app-ready. Returns the list of host pty ids
 * that should be reattached by the renderer (empty for the in-process path or a
 * cold host). NEVER throws — every failure degrades to in-process.
 */
export async function initTerminalBackend(): Promise<{
    host: boolean;
    reattachIds: string[];
}> {
    // Ensure the in-process backend is the active default before anything.
    setActiveBackend(inProcessBackend());

    if (!deps || !detachedEnabled()) {
        return { host: false, reattachIds: [] };
    }
    const { spawner, snapshots } = deps;
    const userData = spawner.userDataDir();

    try {
        const c = await connectOrSpawnHost(userData, spawner, snapshots);
        if (!c) {
            // Couldn't bring up a host — make sure no stale host state lingers.
            client = null;
            usingHost = false;
            setActiveBackend(inProcessBackend());
            status(
                'Detached terminals unavailable — using in-process. Sessions won\'t survive a full quit.',
            );
            return { host: false, reattachIds: [] };
        }
        client = c;
        client.on('error', onHostError);
        setActiveBackend(client);
        usingHost = true;
        return { host: true, reattachIds: client.liveIds() };
    } catch (err) {
        // Any failure → fall back to in-process, app stays functional.
        // eslint-disable-next-line no-console
        console.error('[host-lifecycle] falling back to in-process:', err);
        try {
            client?.disconnect();
        } catch {
            /* ignore */
        }
        client = null;
        usingHost = false;
        setActiveBackend(inProcessBackend());
        status(
            'Detached terminals unavailable — using in-process. Sessions won\'t survive a full quit.',
        );
        return { host: false, reattachIds: [] };
    }
}

/**
 * Host connection dropped mid-session (host crashed / was killed). Fall back to
 * the in-process backend so future create()s work, and toast. Existing windows'
 * ptys are gone, but the app keeps running; a remount spawns fresh in-process.
 */
function onHostError(err: Error): void {
    if (!usingHost) return;
    // eslint-disable-next-line no-console
    console.error('[host-lifecycle] host connection lost:', err.message);
    usingHost = false;
    client = null;
    setActiveBackend(inProcessBackend());
    status(
        'Detached terminal host stopped — switched to in-process. Open terminals may need reopening.',
    );
}

/**
 * before-quit, host-backed: DO NOT kill the host ptys. Snapshot (T1) already ran
 * via the normal before-quit path; here we just disconnect the client and leave
 * the host running so the next launch reattaches.
 */
export function disconnectHostLeaveRunning(): void {
    if (client) {
        try {
            client.disconnect();
        } catch {
            /* ignore */
        }
    }
}

/**
 * Gracefully STOP the detached host (the opposite of leave-running): ask it to
 * kill its ptys, clean up its pidfile/socket, and exit, then drop our client and
 * revert to the in-process backend so any later create() still works.
 *
 * Intended for the case where a consumer needs the host genuinely gone — most
 * notably before an Electron auto-update whose installer must overwrite the
 * binary the detached host is running on. Snapshot first (the normal before-quit
 * T1 path) if you want history to survive; this is a clean shutdown, NOT a
 * SIGKILL-by-pidfile, so the host runs its own cleanup. No-op (resolves) when no
 * host is active. NEVER throws.
 */
export async function shutdownHost(timeoutMs = 2000): Promise<void> {
    const c = client;
    usingHost = false;
    client = null;
    setActiveBackend(inProcessBackend());
    if (!c) return;
    try {
        await c.shutdownHost(timeoutMs);
    } catch {
        /* a host that's already gone is a successful shutdown */
    }
}
