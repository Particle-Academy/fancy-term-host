import path from 'node:path';
import os from 'node:os';
import { PROTOCOL_VERSION } from '../host-protocol';
import type { HostServiceConfig, ServicePlatform, ServiceRuntime } from './types';

/**
 * Default service revision. Encodes the host PROTOCOL_VERSION so that a protocol
 * bump (which makes an old host incompatible) forces a reinstall — the installed
 * unit carries this marker and `ensureHostService` reinstalls on a mismatch.
 */
export const SERVICE_REVISION = `svc1+proto${PROTOCOL_VERSION}`;

/** The marker line embedded in every generated unit, parsed back on upgrade. */
export const REVISION_MARKER = 'fancy-term-service-revision';

/** A fully-resolved, per-OS description of the service to install. */
export interface ServiceDescriptor {
    platform: ServicePlatform;
    label: string;
    revision: string;
    /** The file we write + own (plist / unit / launcher .cmd). */
    unitPath: string;
    unitContents: string;
    /** POSIX file mode for the unit (e.g. 0o600 plist, 0o700 launcher). */
    unitMode: number;
    /** Commands (after the file is written) to register + start the service. */
    installArgv: string[][];
    /** Commands to stop + deregister. */
    uninstallArgv: string[][];
    startArgv: string[][];
    stopArgv: string[][];
    /** Single command whose output tells us installed/running. */
    statusArgv: string[];
    /** Files to remove on uninstall (unit + any logs we created). */
    removePaths: string[];
}

export interface DescriptorContext {
    /** Override the platform (tests). Defaults to the current OS. */
    platform?: ServicePlatform;
    /** Home dir (tests). Defaults to `os.homedir()`. */
    home?: string;
    /** Numeric uid for launchd domain targets (tests / non-posix). */
    uid?: number;
}

/** Map `process.platform` to a service mechanism, or null when unsupported. */
export function servicePlatformFor(
    platform: NodeJS.Platform = process.platform,
): ServicePlatform | null {
    switch (platform) {
        case 'darwin':
            return 'launchd';
        case 'linux':
            return 'systemd';
        case 'win32':
            return 'windows-task';
        default:
            return null;
    }
}

/**
 * Build the per-OS descriptor for a service config. PURE — no fs, no spawning —
 * so the generated units + command argv are fully unit-testable.
 */
export function buildServiceDescriptor(
    config: ResolvedServiceConfig,
    ctx: DescriptorContext = {},
): ServiceDescriptor {
    const platform =
        ctx.platform ?? servicePlatformFor() ?? unsupported(config);
    const home = ctx.home ?? os.homedir();
    switch (platform) {
        case 'launchd':
            return launchd(config, home, ctx.uid ?? safeUid());
        case 'systemd':
            return systemd(config, home);
        case 'windows-task':
            return windowsTask(config);
    }
}

function unsupported(config: ResolvedServiceConfig): never {
    throw new Error(
        `fancy-term-host service: unsupported platform for "${config.label}"`,
    );
}

function safeUid(): number {
    const getuid = (process as { getuid?: () => number }).getuid;
    return typeof getuid === 'function' ? getuid() : 0;
}

/**
 * A config with all defaults filled in — produced by `resolveServiceConfig`
 * (see index.ts) and consumed by the descriptor builder.
 */
export interface ResolvedServiceConfig {
    label: string;
    userDataDir: string;
    hostScript: string;
    runtime: ServiceRuntime;
    env: Record<string, string>;
    revision: string;
    logDir: string;
}

/** The environment every platform injects (user-data dir, NODE_PATH, revision). */
function serviceEnv(config: ResolvedServiceConfig): Record<string, string> {
    const env: Record<string, string> = {
        ...config.env,
        // GENIE_USERDATA is the var the existing detached-spawn path already uses
        // (see host-lifecycle.spawnDetached); keep it so the host finds its data.
        GENIE_USERDATA: config.userDataDir,
        FANCY_TERM_SERVICE_REVISION: config.revision,
    };
    if (config.runtime.nodePtyDir) {
        env.NODE_PATH = config.runtime.nodePtyDir;
    }
    return env;
}

// ── macOS: launchd LaunchAgent ──────────────────────────────────────────────

function launchd(
    config: ResolvedServiceConfig,
    home: string,
    uid: number,
): ServiceDescriptor {
    const label = config.label;
    // launchd targets macOS — always POSIX paths, even if generated elsewhere.
    const plistPath = path.posix.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    const env = serviceEnv(config);
    const outLog = path.posix.join(config.logDir, 'ptyhost.out.log');
    const errLog = path.posix.join(config.logDir, 'ptyhost.err.log');

    const envXml = Object.entries(env)
        .map(
            ([k, v]) =>
                `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`,
        )
        .join('\n');

    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${REVISION_MARKER}: ${config.revision} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(config.runtime.nodePath)}</string>
      <string>${xml(config.hostScript)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(outLog)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(errLog)}</string>
  </dict>
</plist>
`;

    const domain = `gui/${uid}`;
    const target = `${domain}/${label}`;
    return {
        platform: 'launchd',
        label,
        revision: config.revision,
        unitPath: plistPath,
        unitContents: contents,
        unitMode: 0o600,
        // bootstrap loads + (RunAtLoad) starts it.
        installArgv: [['launchctl', 'bootstrap', domain, plistPath]],
        uninstallArgv: [['launchctl', 'bootout', target]],
        startArgv: [['launchctl', 'kickstart', '-k', target]],
        stopArgv: [['launchctl', 'kill', 'SIGTERM', target]],
        statusArgv: ['launchctl', 'print', target],
        removePaths: [plistPath],
    };
}

// ── Linux: systemd --user unit ──────────────────────────────────────────────

function systemd(config: ResolvedServiceConfig, home: string): ServiceDescriptor {
    const unit = `${config.label}.service`;
    // systemd --user targets Linux — always POSIX paths.
    const unitPath = path.posix.join(home, '.config', 'systemd', 'user', unit);
    const env = serviceEnv(config);
    const envLines = Object.entries(env)
        .map(([k, v]) => `Environment=${k}=${systemdEnvValue(v)}`)
        .join('\n');

    const contents = `# ${REVISION_MARKER}: ${config.revision}
[Unit]
Description=fancy-term pty-host (${config.label})
After=default.target

[Service]
Type=simple
ExecStart=${quoteForExec(config.runtime.nodePath)} ${quoteForExec(config.hostScript)}
${envLines}
Restart=no

[Install]
WantedBy=default.target
`;

    return {
        platform: 'systemd',
        label: config.label,
        revision: config.revision,
        unitPath,
        unitContents: contents,
        unitMode: 0o644,
        installArgv: [
            ['systemctl', '--user', 'daemon-reload'],
            ['systemctl', '--user', 'enable', '--now', unit],
        ],
        uninstallArgv: [['systemctl', '--user', 'disable', '--now', unit]],
        startArgv: [['systemctl', '--user', 'start', unit]],
        stopArgv: [['systemctl', '--user', 'stop', unit]],
        statusArgv: ['systemctl', '--user', 'is-active', unit],
        removePaths: [unitPath],
    };
}

// ── Windows: per-user scheduled task (ONLOGON, no elevation) ─────────────────

function windowsTask(config: ResolvedServiceConfig): ServiceDescriptor {
    const env = serviceEnv(config);
    // A launcher .cmd sets env then runs the host — schtasks can't carry rich
    // env cleanly, and the .cmd also records the revision marker.
    const cmdPath = path.win32.join(config.userDataDir, `${sanitizeFileName(config.label)}.cmd`);
    const setLines = Object.entries(env)
        .map(([k, v]) => `set "${k}=${v}"`)
        .join('\r\n');
    const contents = [
        '@echo off',
        `rem ${REVISION_MARKER}: ${config.revision}`,
        setLines,
        `"${config.runtime.nodePath}" "${config.hostScript}"`,
        '',
    ].join('\r\n');

    const taskName = config.label;
    // /RL LIMITED = run with the user's normal (non-elevated) rights.
    // /SC ONLOGON = start at this user's logon. /F = overwrite if present.
    const tr = `cmd /c "${cmdPath}"`;
    return {
        platform: 'windows-task',
        label: config.label,
        revision: config.revision,
        unitPath: cmdPath,
        unitContents: contents,
        unitMode: 0o700,
        installArgv: [
            ['schtasks', '/Create', '/TN', taskName, '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'],
        ],
        uninstallArgv: [['schtasks', '/Delete', '/TN', taskName, '/F']],
        startArgv: [['schtasks', '/Run', '/TN', taskName]],
        stopArgv: [['schtasks', '/End', '/TN', taskName]],
        statusArgv: ['schtasks', '/Query', '/TN', taskName, '/FO', 'LIST'],
        removePaths: [cmdPath],
    };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function xml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** systemd `Environment=` values: wrap in quotes if they contain whitespace. */
function systemdEnvValue(v: string): string {
    return /\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

/** Quote a path for a systemd ExecStart token. */
function quoteForExec(p: string): string {
    return /\s/.test(p) ? `"${p}"` : p;
}

function sanitizeFileName(label: string): string {
    return label.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** Read the revision marker out of an installed unit's contents, or null. */
export function parseInstalledRevision(unitContents: string): string | null {
    const m = unitContents.match(
        new RegExp(`${REVISION_MARKER}:\\s*(\\S+)`),
    );
    return m ? m[1] : null;
}
