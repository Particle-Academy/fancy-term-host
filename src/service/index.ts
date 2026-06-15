/**
 * Per-user OS-service lifecycle for the pty-host. Install / start / stop /
 * status / uninstall + a single `ensureHostService()` that does the
 * install-if-missing-or-stale → start-if-stopped dance.
 *
 * Pairs with the existing detached-host path: the wire protocol, pidfile, and
 * `HostClient` are unchanged, so the consumer connects exactly as today. The
 * difference is WHO launches the host — a per-user service on a standalone Node
 * runtime, not a child of the consumer's Electron binary.
 *
 * Everything here is graceful: `ensureHostService` never throws (inspect `ok`),
 * so a consumer can try the service and, on failure, fall back to
 * `HostSpawner.spawnDetached` (normal-quit survival) → in-process.
 */

import { ptyHostScriptPath } from '../host-script';
import {
    buildServiceDescriptor,
    parseInstalledRevision,
    SERVICE_REVISION,
    servicePlatformFor,
    type ResolvedServiceConfig,
    type ServiceDescriptor,
} from './descriptor';
import { resolveServiceRuntime } from './runtime';
import { nodeServiceIo } from './io';
import type {
    EnsureResult,
    HostServiceConfig,
    ServiceIo,
    ServiceRuntime,
    ServiceStatus,
} from './types';

export { resolveServiceRuntime } from './runtime';
export { nodeServiceIo } from './io';
export {
    buildServiceDescriptor,
    servicePlatformFor,
    parseInstalledRevision,
    SERVICE_REVISION,
} from './descriptor';
export type { ServiceDescriptor, ResolvedServiceConfig } from './descriptor';
export type {
    HostServiceConfig,
    ServiceRuntime,
    ServiceStatus,
    ServiceState,
    ServicePlatform,
    ServiceIo,
    EnsureResult,
    EnsureAction,
} from './types';

/** True when the current OS has a supported service mechanism. */
export function isServiceSupported(): boolean {
    return servicePlatformFor() !== null;
}

/**
 * Fill in every default (host script, runtime, revision, log dir) so the
 * descriptor builder has a complete config. Throws only if no standalone Node
 * runtime can be resolved — callers that want graceful behaviour should use
 * `ensureHostService`, which catches this.
 */
export function resolveServiceConfig(
    config: HostServiceConfig,
): ResolvedServiceConfig {
    const runtime: ServiceRuntime | null =
        config.runtime ?? resolveServiceRuntime();
    if (!runtime) {
        throw new Error(
            'fancy-term-host service: no standalone Node runtime found ' +
                '(set config.runtime or $FANCY_TERM_NODE). Refusing to pin the ' +
                'consumer binary by running on Electron.',
        );
    }
    return {
        label: config.label,
        userDataDir: config.userDataDir,
        hostScript: config.hostScript ?? ptyHostScriptPath(),
        runtime,
        env: config.env ?? {},
        revision: config.revision ?? SERVICE_REVISION,
        logDir: config.logDir ?? config.userDataDir,
    };
}

function descriptorFor(config: HostServiceConfig): ServiceDescriptor {
    return buildServiceDescriptor(resolveServiceConfig(config));
}

/** Run a list of commands in order; throw on the first non-zero exit. */
async function runAll(io: ServiceIo, argvList: string[][]): Promise<void> {
    for (const argv of argvList) {
        const { code, stderr } = await io.run(argv);
        if (code !== 0) {
            throw new Error(
                `command failed (${code}): ${argv.join(' ')}${
                    stderr ? ` — ${stderr.trim()}` : ''
                }`,
            );
        }
    }
}

/** Write the unit file(s) and register + start the service. */
export async function installHostService(
    config: HostServiceConfig,
    io: ServiceIo = nodeServiceIo(),
): Promise<ServiceStatus> {
    const desc = descriptorFor(config);
    await io.mkdirp(config.userDataDir);
    await io.writeFile(desc.unitPath, desc.unitContents, { mode: desc.unitMode });
    await runAll(io, desc.installArgv);
    return serviceStatusFor(desc, io);
}

/** Stop + deregister the service and remove its unit file(s). */
export async function uninstallHostService(
    config: HostServiceConfig,
    io: ServiceIo = nodeServiceIo(),
): Promise<void> {
    const desc = descriptorFor(config);
    // Best-effort: a not-installed service shouldn't make uninstall throw.
    for (const argv of desc.uninstallArgv) {
        await io.run(argv);
    }
    for (const p of desc.removePaths) {
        await io.rm(p);
    }
}

export async function startHostService(
    config: HostServiceConfig,
    io: ServiceIo = nodeServiceIo(),
): Promise<void> {
    await runAll(io, descriptorFor(config).startArgv);
}

export async function stopHostService(
    config: HostServiceConfig,
    io: ServiceIo = nodeServiceIo(),
): Promise<void> {
    await runAll(io, descriptorFor(config).stopArgv);
}

export async function isServiceInstalled(
    config: HostServiceConfig,
    io: ServiceIo = nodeServiceIo(),
): Promise<boolean> {
    return io.exists(descriptorFor(config).unitPath);
}

export async function serviceStatus(
    config: HostServiceConfig,
    io: ServiceIo = nodeServiceIo(),
): Promise<ServiceStatus> {
    return serviceStatusFor(descriptorFor(config), io);
}

async function serviceStatusFor(
    desc: ServiceDescriptor,
    io: ServiceIo,
): Promise<ServiceStatus> {
    const unit = await io.readFile(desc.unitPath);
    const installed = unit !== null;
    const installedRevision = unit ? parseInstalledRevision(unit) ?? undefined : undefined;

    let running = false;
    let detail: string | undefined;
    if (installed) {
        const { code, stdout, stderr } = await io.run(desc.statusArgv);
        detail = (stdout || stderr).trim() || undefined;
        running = isRunningOutput(desc, code, stdout);
    }

    return {
        platform: desc.platform,
        state: !installed ? 'not-installed' : running ? 'running' : 'installed',
        installed,
        running,
        label: desc.label,
        unitPath: desc.unitPath,
        installedRevision,
        detail,
    };
}

/** Interpret each platform's status command output. */
function isRunningOutput(
    desc: ServiceDescriptor,
    code: number,
    stdout: string,
): boolean {
    const out = stdout.toLowerCase();
    switch (desc.platform) {
        case 'systemd':
            // `systemctl --user is-active` → "active" (exit 0) when running.
            return code === 0 && out.includes('active') && !out.includes('inactive');
        case 'launchd':
            // `launchctl print` exits 0 when loaded; "state = running" when up.
            return code === 0 && (out.includes('state = running') || out.includes('pid ='));
        case 'windows-task':
            // `schtasks /Query /FO LIST` → a "Status:" line of "Running".
            return code === 0 && out.includes('running');
    }
}

/**
 * Ensure the service is installed at the current revision AND running.
 *
 *   - already running at this revision   → no-op
 *   - installed (this revision), stopped → start
 *   - installed at a DIFFERENT revision  → uninstall + reinstall + start
 *   - not installed                      → install (+ start)
 *
 * NEVER throws. On any failure (no runtime, unsupported OS, a command error) it
 * returns `{ ok: false, … }` with an `error` so the caller can fall back to the
 * detached-spawn path. Snapshot live sessions before a reinstall if you need
 * history to survive it (a reinstall restarts the host).
 */
export async function ensureHostService(
    config: HostServiceConfig,
    io: ServiceIo = nodeServiceIo(),
): Promise<EnsureResult> {
    if (!isServiceSupported()) {
        return {
            ok: false,
            installed: false,
            running: false,
            action: 'unsupported',
            error: `unsupported platform: ${process.platform}`,
        };
    }

    let resolved: ResolvedServiceConfig;
    try {
        resolved = resolveServiceConfig(config);
    } catch (err) {
        return {
            ok: false,
            installed: false,
            running: false,
            action: 'failed',
            error: (err as Error).message,
        };
    }

    const desc = buildServiceDescriptor(resolved);
    const runtime = resolved.runtime;
    try {
        const status = await serviceStatusFor(desc, io);

        if (status.installed && status.installedRevision === resolved.revision) {
            if (status.running) {
                return { ok: true, installed: true, running: true, action: 'already-running', runtime };
            }
            await runAll(io, desc.startArgv);
            return { ok: true, installed: true, running: true, action: 'started', runtime };
        }

        if (status.installed) {
            // Stale revision → tear down then reinstall fresh.
            for (const argv of desc.uninstallArgv) await io.run(argv);
            for (const p of desc.removePaths) await io.rm(p);
        }

        await io.mkdirp(resolved.userDataDir);
        await io.writeFile(desc.unitPath, desc.unitContents, { mode: desc.unitMode });
        await runAll(io, desc.installArgv);
        // launchd RunAtLoad / systemd --now start on install; nudge to be sure.
        await runAll(io, desc.startArgv).catch(() => {});

        return {
            ok: true,
            installed: true,
            running: true,
            action: status.installed ? 'reinstalled' : 'installed-and-started',
            runtime,
        };
    } catch (err) {
        return {
            ok: false,
            installed: false,
            running: false,
            action: 'failed',
            error: (err as Error).message,
            runtime,
        };
    }
}
