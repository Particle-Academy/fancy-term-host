/**
 * Per-user OS-service layer (Tier 3+) — run the pty-host as a launchd
 * LaunchAgent / systemd --user unit / Windows per-user scheduled task, on its
 * OWN standalone Node runtime instead of the consumer's Electron binary.
 *
 * Why: the detached host launched via `process.execPath` (Electron-as-node)
 * PINS the consumer's executable, so an Electron auto-update can't overwrite it
 * without killing live sessions. A service on its own runtime is never pinned —
 * terminals survive both quits AND updates.
 *
 * The wire protocol, `HostClient`, pidfile, and socket path are all UNCHANGED;
 * only the host's launch + lifecycle move here. See docs/persistence.md.
 */

/** The per-OS service mechanism. */
export type ServicePlatform = 'launchd' | 'systemd' | 'windows-task';

/**
 * The standalone runtime the service runs the host on. MUST NOT be the
 * consumer's Electron binary (that reintroduces the pin) — a plain Node.
 */
export interface ServiceRuntime {
    /** Absolute path to a standalone `node` (never `electron`). */
    nodePath: string;
    /**
     * Directory holding an ABI-matched `node-pty` build for `nodePath` (added to
     * the service's `NODE_PATH`). Omit if node-pty resolves normally from the
     * host script's own `node_modules`.
     */
    nodePtyDir?: string;
    /** How this runtime was resolved (diagnostics only). */
    source: string;
}

/** Inputs describing the service to install for this user. */
export interface HostServiceConfig {
    /**
     * Reverse-DNS-ish service label, stable per app + user, e.g.
     * `"academy.particle.genie.ptyhost"`. Used as the launchd Label, the
     * systemd unit name, and the Windows task name.
     */
    label: string;
    /** User-data dir the host uses for its pidfile / socket / snapshots. */
    userDataDir: string;
    /** Path to the pty-host script. Defaults to `ptyHostScriptPath()`. */
    hostScript?: string;
    /** The standalone runtime. Defaults to `resolveServiceRuntime()`. */
    runtime?: ServiceRuntime;
    /** Extra environment variables for the host process. */
    env?: Record<string, string>;
    /**
     * Service revision. Bump (or rely on the default, which encodes the host
     * protocol version) to force a reinstall on upgrade so a stale unit doesn't
     * keep running an incompatible host.
     */
    revision?: string;
    /** Directory for the service's stdout/stderr logs. Defaults to userDataDir. */
    logDir?: string;
}

export type ServiceState =
    | 'running'
    | 'installed'
    | 'not-installed'
    | 'unsupported'
    | 'unknown';

/** A snapshot of the installed service's state. */
export interface ServiceStatus {
    platform: ServicePlatform | 'unsupported';
    state: ServiceState;
    installed: boolean;
    running: boolean;
    label: string;
    /** Path to the written unit/plist/launcher, when applicable. */
    unitPath?: string;
    /** The revision recorded in the installed unit, if any. */
    installedRevision?: string;
    /** Free-text diagnostic (last command output / error). */
    detail?: string;
}

/** What `ensureHostService()` did. */
export type EnsureAction =
    | 'already-running'
    | 'started'
    | 'installed-and-started'
    | 'reinstalled'
    | 'failed'
    | 'unsupported';

/** Result of `ensureHostService()` — never throws; inspect `ok`. */
export interface EnsureResult {
    /** True when the service is installed AND running at the matching revision. */
    ok: boolean;
    installed: boolean;
    running: boolean;
    action: EnsureAction;
    runtime?: ServiceRuntime;
    /** Set when `ok` is false — the reason, so the caller can fall back. */
    error?: string;
}

/**
 * Injected IO so the orchestration is unit-testable without touching the real
 * OS. `nodeServiceIo()` is the production implementation.
 */
export interface ServiceIo {
    /** Run a command; resolves with the exit code + captured output. */
    run(
        argv: string[],
    ): Promise<{ code: number; stdout: string; stderr: string }>;
    writeFile(path: string, contents: string, opts?: { mode?: number }): Promise<void>;
    readFile(path: string): Promise<string | null>;
    mkdirp(dir: string): Promise<void>;
    rm(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
}
