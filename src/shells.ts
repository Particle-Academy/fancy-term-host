import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { SettingsProvider } from './ports';

/**
 * Shell detection + default-shell resolution for the terminal subsystem.
 *
 * Mirrors main/editors.ts: probe well-known install paths, return what's
 * actually present. Ids line up with fancy-term's BUILTIN_SHELLS so the
 * renderer can map detections straight onto ShellProfile entries
 * (cmd · powershell · pwsh · git-bash · bash · zsh · wsl).
 *
 * Default policy (Windows): Git Bash when detected — it's the shell the
 * Tynn toolchain assumes — then pwsh, then Windows PowerShell, then cmd.
 * On macOS/Linux the user's $SHELL wins, falling back to bash.
 */

export interface ShellInfo {
    /** Stable id, matches fancy-term BUILTIN_SHELLS where possible. */
    id: string;
    /** Display label, e.g. "Git Bash". */
    label: string;
    /** Absolute executable path (or bare command when resolved via PATH). */
    command: string;
    /** Default args for an interactive session. */
    args: string[];
}

function firstExisting(paths: string[]): string | null {
    for (const p of paths) {
        try {
            if (p && fs.existsSync(p)) return p;
        } catch {
            /* permission race — treat as absent */
        }
    }
    return null;
}

function windowsCandidates(): Array<Omit<ShellInfo, 'command'> & { paths: string[] }> {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 =
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';

    return [
        {
            id: 'git-bash',
            label: 'Git Bash',
            args: ['--login', '-i'],
            paths: [
                path.join(programFiles, 'Git', 'bin', 'bash.exe'),
                path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
                localAppData
                    ? path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe')
                    : '',
            ],
        },
        {
            id: 'pwsh',
            label: 'PowerShell 7',
            args: ['-NoLogo'],
            paths: [
                path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
                localAppData
                    ? path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe')
                    : '',
            ],
        },
        {
            id: 'powershell',
            label: 'Windows PowerShell',
            args: ['-NoLogo'],
            paths: [
                path.join(
                    systemRoot,
                    'System32',
                    'WindowsPowerShell',
                    'v1.0',
                    'powershell.exe',
                ),
            ],
        },
        {
            id: 'cmd',
            label: 'Command Prompt',
            args: [],
            paths: [process.env.COMSPEC ?? path.join(systemRoot, 'System32', 'cmd.exe')],
        },
        {
            id: 'wsl',
            label: 'WSL',
            args: [],
            paths: [path.join(systemRoot, 'System32', 'wsl.exe')],
        },
    ];
}

function unixCandidates(): Array<Omit<ShellInfo, 'command'> & { paths: string[] }> {
    return [
        {
            id: 'zsh',
            label: 'zsh',
            args: ['-l'],
            paths: ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'],
        },
        {
            id: 'bash',
            label: 'bash',
            args: ['-l'],
            paths: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'],
        },
        {
            id: 'fish',
            label: 'fish',
            args: ['-l'],
            paths: ['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish'],
        },
    ];
}

/** Parse `dscl . -read /Users/<user> UserShell` output → the shell path.
 *  The line reads `UserShell: /bin/zsh`. Returns null when absent/malformed. */
export function parseDsclUserShell(output: string): string | null {
    const m = /UserShell:\s*(\S+)/.exec(output);
    return m ? m[1] : null;
}

/** Read the current user's login shell from macOS Directory Services. Best
 *  effort — returns null on any failure (dscl missing, no entry, timeout). */
function macUserShell(): string | null {
    try {
        const user = os.userInfo().username;
        const out = execFileSync('dscl', ['.', '-read', `/Users/${user}`, 'UserShell'], {
            encoding: 'utf8',
            timeout: 2000,
        });
        return parseDsclUserShell(out);
    } catch {
        return null;
    }
}

/**
 * The user's real login shell.
 *   - `$SHELL` when the launching env carries it (terminals, most launches).
 *   - On macOS a **Dock/Finder-launched** app inherits NO `$SHELL`, and Node's
 *     `os.userInfo().shell` is `null` there, so fall back to Directory Services
 *     (`dscl . -read /Users/<user> UserShell`) to read the actual login shell
 *     instead of blindly defaulting to the zsh-first candidate order.
 * Returns an absolute shell path, or null when it can't be determined. The
 * `env`/`platform`/`macLookup` params are injectable for tests.
 */
export function resolveLoginShell(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
    macLookup: () => string | null = macUserShell,
): string | null {
    if (env.SHELL) return env.SHELL;
    if (platform === 'darwin') return macLookup();
    return null;
}

export function detectShells(): ShellInfo[] {
    const candidates =
        process.platform === 'win32' ? windowsCandidates() : unixCandidates();
    const found: ShellInfo[] = [];
    for (const c of candidates) {
        const command = firstExisting(c.paths);
        if (command) found.push({ id: c.id, label: c.label, command, args: c.args });
    }

    // Unix: the user's real login shell ALWAYS wins (see resolveLoginShell —
    // handles a Dock-launched macOS app with no $SHELL). Move it to the FRONT so
    // defaultShellId picks it, whether it's an exotic path not in the probe list
    // OR a probed shell that isn't first (a bash/fish login shell must not lose
    // to the hardcoded zsh-first candidate order).
    if (process.platform !== 'win32') {
        const login = resolveLoginShell();
        if (login && fs.existsSync(login)) {
            const existing = found.find((s) => s.command === login);
            const rest = found.filter((s) => s.command !== login);
            const head =
                existing ?? {
                    id: path.basename(login),
                    label: path.basename(login),
                    command: login,
                    args: ['-l'],
                };
            found.length = 0;
            found.push(head, ...rest);
        }
    }
    return found;
}

/** Default policy: Git Bash > pwsh > powershell > cmd (win); $SHELL > bash (unix). */
export function defaultShellId(detected: ShellInfo[]): string | null {
    const order =
        process.platform === 'win32'
            ? ['git-bash', 'pwsh', 'powershell', 'cmd']
            : detected.map((s) => s.id); // unix list is already priority-ordered
    for (const id of order) {
        if (detected.some((s) => s.id === id)) return id;
    }
    return detected[0]?.id ?? null;
}

/**
 * Split a manual "executable line" into command + args. Honors double
 * quotes around the executable path ("C:\Program Files\Git\bin\bash.exe"
 * --login -i). Single-token lines pass through untouched.
 */
export function parseCommandLine(line: string): { command: string; args: string[] } {
    const trimmed = line.trim();
    if (!trimmed) return { command: '', args: [] };
    const tokens: string[] = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(trimmed))) tokens.push(m[1] ?? m[2]);
    return { command: tokens[0] ?? '', args: tokens.slice(1) };
}

/** Coarse shell family, derived from the executable name, used to decide which
 *  OSC-7 prompt hook (if any) we can inject. */
export type ShellKind = 'powershell' | 'bash' | 'zsh' | 'fish' | 'cmd' | 'other';

export function shellKind(command: string): ShellKind {
    const base = path.basename(command).toLowerCase();
    if (base.includes('pwsh') || base.includes('powershell')) return 'powershell';
    if (base.startsWith('zsh')) return 'zsh';
    if (base.startsWith('bash')) return 'bash';
    if (base.startsWith('fish')) return 'fish';
    if (base.startsWith('cmd')) return 'cmd';
    return 'other';
}

/** The spawn additions (env + extra args) a shell needs to emit OSC-7 cwd. */
export interface CwdHook {
    /** Extra env entries to merge into the pty's environment. */
    env: Record<string, string>;
    /** Extra args to APPEND to the shell's launch args (PowerShell needs these). */
    args: string[];
}

/** Short, stable per-user dir under the OS temp root that holds generated
 *  prompt shims (zsh rc, fish conf, PowerShell profile). Per-user so two users
 *  on a shared box don't read each other's shims. Created lazily. */
function hookDir(): string {
    const seed = `${os.userInfo().username}|${os.hostname()}`;
    const hash = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
    const dir = path.join(os.tmpdir(), 'fancy-term-host', hash);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Best-effort write; a failed shim just means the shell degrades to static cwd. */
function writeShim(file: string, contents: string): boolean {
    try {
        fs.writeFileSync(file, contents, 'utf8');
        return true;
    } catch {
        return false;
    }
}

/**
 * Build the spawn additions (env + args) that make a shell emit OSC-7 cwd
 * reports on every prompt, so resumed terminals know where they were
 * (Tier 1.5). Gated by the `track_cwd` setting (default ON). Returns an empty
 * hook when tracking is off or the shell genuinely can't be hooked — the
 * manager then degrades to the static cwd.
 *
 * Coverage (all overlay, never clobber the user's own prompt/rc):
 *   - **bash** — prepend an OSC-7 `printf` to `PROMPT_COMMAND` (env only). The
 *     portable, reliable case (Git Bash on Windows, bash on POSIX).
 *   - **zsh** — point `ZDOTDIR` at a generated dir that overlays the FULL login
 *     startup chain (`.zshenv` → `.zprofile` → `.zshrc`), each sourcing the
 *     user's real counterpart, restores `ZDOTDIR` in `.zshrc` (so `~/.zlogin`
 *     loads from the real dir), then registers a `precmd` emitter.
 *   - **fish** — prepend a generated dir to `XDG_DATA_DIRS` carrying a
 *     `fish/vendor_conf.d/osc7.fish` that hooks `--on-event fish_prompt`
 *     (vendor conf overlays the user's config rather than replacing it).
 *   - **PowerShell (pwsh/powershell)** — write a profile shim that wraps any
 *     existing `prompt` and emits OSC-7, dot-sourced via appended
 *     `-NoExit -Command ". '<shim>'"` args (PS has no env-var prompt hook).
 *   - **cmd.exe (best-effort)** — set `PROMPT` to emit OSC-7 via the `$E`
 *     escape before the normal `$P$G`. Renders only where the console honors
 *     VT sequences in the prompt; otherwise degrades to static cwd.
 *
 * The emitted payload is always `file:///<path>` (empty authority, forward
 * slashes / Windows drive) so it round-trips through {@link scanOsc7Cwd}.
 */
export function cwdHookSpawn(command: string, settings: SettingsProvider): CwdHook {
    const empty: CwdHook = { env: {}, args: [] };
    if (settings.get('track_cwd') === 'off') return empty;

    const kind = shellKind(command);
    const host = os.hostname();

    if (kind === 'bash') {
        // Emit from PROMPT_COMMAND; $PWD is absolute → file:///$PWD. PREPEND so
        // any existing PROMPT_COMMAND still runs. Single-quoted → expands at
        // prompt time, not now.
        const emit = `printf '\\033]7;file://${host}%s\\033\\\\' "$PWD"`;
        const prev = process.env.PROMPT_COMMAND ? '; ' + process.env.PROMPT_COMMAND : '';
        return { env: { PROMPT_COMMAND: `${emit}${prev}` }, args: [] };
    }

    if (kind === 'zsh') {
        const orig = process.env.ZDOTDIR || os.homedir();
        const dir = hookDir();
        // Overlay the FULL zsh login startup chain in order, each generated file
        // sourcing the user's real counterpart from `orig`. zsh seeks each file
        // in the CURRENT $ZDOTDIR (this generated dir) until our .zshrc restores
        // it, so we must provide .zprofile here too — omitting it (the old bug,
        // #6) silently skipped a user's ~/.zprofile (PATH / prompt / theme init),
        // breaking themed prompts. Order zsh reads: .zshenv → .zprofile (login)
        // → .zshrc → .zlogin (login).
        //
        // .zshenv runs for every invocation — source the user's first so their
        // environment survives.
        const okEnv = writeShim(
            path.join(dir, '.zshenv'),
            `# fancy-term-host (generated)\n[ -f "${orig}/.zshenv" ] && source "${orig}/.zshenv"\n`,
        );
        // .zprofile runs for LOGIN shells (we spawn with -l) before .zshrc, while
        // $ZDOTDIR is still this generated dir — so we MUST overlay it or the
        // user's ~/.zprofile is skipped entirely.
        const okProfile = writeShim(
            path.join(dir, '.zprofile'),
            `# fancy-term-host (generated)\n[ -f "${orig}/.zprofile" ] && source "${orig}/.zprofile"\n`,
        );
        // .zshrc: restore ZDOTDIR for the user's environment (so their rc sees
        // the real dir AND a later login shell reads ~/.zlogin from `orig`),
        // source their rc, then register the OSC-7 precmd (appended → their
        // prompt survives).
        const okRc = writeShim(
            path.join(dir, '.zshrc'),
            `# fancy-term-host (generated)\n` +
                `ZDOTDIR="${orig}"\n` +
                `[ -f "${orig}/.zshrc" ] && source "${orig}/.zshrc"\n` +
                `__fth_osc7() { printf '\\033]7;file://%s\\033\\\\' "$PWD" }\n` +
                `typeset -ga precmd_functions\n` +
                `precmd_functions+=(__fth_osc7)\n`,
        );
        return okEnv && okProfile && okRc ? { env: { ZDOTDIR: dir }, args: [] } : empty;
    }

    if (kind === 'fish') {
        const dir = hookDir();
        const confDir = path.join(dir, 'fish', 'vendor_conf.d');
        try {
            fs.mkdirSync(confDir, { recursive: true });
        } catch {
            return empty;
        }
        const ok = writeShim(
            path.join(confDir, 'osc7.fish'),
            `# fancy-term-host (generated)\n` +
                `function __fth_osc7 --on-event fish_prompt\n` +
                `    printf '\\x1b]7;file://%s\\x1b\\\\' "$PWD"\n` +
                `end\n`,
        );
        if (!ok) return empty;
        const existing = process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share';
        return { env: { XDG_DATA_DIRS: `${dir}${path.delimiter}${existing}` }, args: [] };
    }

    if (kind === 'powershell') {
        const dir = hookDir();
        const shim = path.join(dir, 'osc7-profile.ps1');
        // Wrap any existing prompt; emit file:///<forward-slashed path>. Use the
        // filesystem ProviderPath so non-filesystem locations don't poison it.
        const ok = writeShim(
            shim,
            `# fancy-term-host (generated)\n` +
                `$global:__fthPrev = $function:prompt\n` +
                `function global:prompt {\n` +
                `    $p = ($PWD.ProviderPath -replace '\\\\','/')\n` +
                `    [Console]::Write("$([char]27)]7;file:///$p$([char]27)\\")\n` +
                `    if ($global:__fthPrev) { & $global:__fthPrev } else { "PS $($PWD.ProviderPath)> " }\n` +
                `}\n`,
        );
        if (!ok) return empty;
        return { env: {}, args: ['-NoExit', '-Command', `. '${shim}'`] };
    }

    if (kind === 'cmd') {
        // Best-effort: $E = ESC in cmd's PROMPT. Emit OSC-7 (file:///$P, the
        // current path) then ST, then the normal $P$G. Only honored where the
        // console interprets VT sequences in the prompt.
        return { env: { PROMPT: `$E]7;file:///$P$E\\$P$G` }, args: [] };
    }

    return empty;
}

/**
 * Back-compat env-only view of {@link cwdHookSpawn} — returns just the env
 * additions. Shells that also need launch args (PowerShell) are only fully
 * hooked via `cwdHookSpawn`; callers using this alone get the env half.
 */
export function cwdHookEnv(
    command: string,
    settings: SettingsProvider,
): Record<string, string> {
    return cwdHookSpawn(command, settings).env;
}

/**
 * Resolve the user's configured default shell to a concrete spawn target.
 * Reads the `terminal_shell` setting (a detected id, or 'custom' paired
 * with `terminal_custom_cmd`). Anything unresolvable falls back to the
 * detection-based default so the terminal always opens SOMETHING.
 */
export function resolveDefaultShell(settings: SettingsProvider): {
    command: string;
    args: string[];
} {
    const detected = detectShells();
    const terminalShell = settings.get('terminal_shell');

    if (terminalShell === 'custom') {
        const parsed = parseCommandLine(settings.get('terminal_custom_cmd') ?? '');
        if (parsed.command) return parsed;
    }

    const pick =
        detected.find((s) => s.id === terminalShell) ??
        detected.find((s) => s.id === defaultShellId(detected));
    if (pick) return { command: pick.command, args: pick.args };

    // Nothing detected (bare container?) — legacy platform fallbacks.
    if (process.platform === 'win32') {
        return { command: process.env.COMSPEC ?? 'cmd.exe', args: [] };
    }
    return { command: process.env.SHELL ?? '/bin/bash', args: [] };
}
