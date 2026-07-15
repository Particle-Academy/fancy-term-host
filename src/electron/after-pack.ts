/**
 * electron-builder `afterPack` helper (Tier 0 — packaging).
 *
 * fancy-term-host wraps `node-pty`, a NATIVE addon. `electron-builder`
 * (via `install-app-deps`) rebuilds it, but the rebuild output is left
 * unusable per-OS, so a standard packaged app spawns NO terminal until each
 * consumer discovers + patches it. This helper performs the three known fixes
 * in one call so consumers don't have to hand-roll them (#7):
 *
 *   • **Windows** — node-pty's `conpty.node` `LoadLibrary`s a `conpty.dll` from a
 *     `build/Release/conpty/` SUBDIR that the rebuild doesn't create; the dll +
 *     `OpenConsole.exe` ship only under `prebuilds/<plat>/conpty/` (or
 *     `third_party/conpty/`). Runtime error otherwise:
 *     `Cannot find conpty.dll at .../build/Release/conpty/conpty.dll`. We copy
 *     them into place.
 *   • **macOS** — node-pty's `spawn-helper` ships UNSIGNED, so Apple Silicon
 *     SIGKILLs it on exec (all arm64 code must be at least ad-hoc signed) and the
 *     shell child never starts. We ad-hoc sign it (`codesign --force --sign -`).
 *   • **Linux** — `spawn-helper` must stay executable after packaging. We
 *     `chmod +x` it.
 *
 * Usage (electron-builder config):
 * ```js
 * const { fancyTermAfterPack } = require('@particle-academy/fancy-term-host/electron');
 * module.exports = { afterPack: (context) => fancyTermAfterPack(context) };
 * ```
 *
 * The IO is injected (see {@link AfterPackIo}) so the decision logic is unit
 * testable without touching the filesystem or spawning `codesign`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** The subset of electron-builder's AfterPackContext this helper reads. */
export interface AfterPackContext {
    /** The per-OS output dir being packed (e.g. `dist/mac-arm64`, `dist/win-unpacked`). */
    appOutDir: string;
    /** `'darwin' | 'win32' | 'linux'` — the platform being packed. */
    electronPlatformName: string;
}

export interface AfterPackOptions {
    /** Override the platform (defaults to `context.electronPlatformName`). */
    platform?: string;
    /** Explicit node-pty package dir; skips the search under `appOutDir`. */
    nodePtyDir?: string;
}

export type AfterPackAction = 'fixed' | 'already-present' | 'skipped' | 'failed';

export interface AfterPackResult {
    platform: string;
    action: AfterPackAction;
    /** True when the terminal should now work (fixed / already-ok / nothing-to-do). */
    ok: boolean;
    detail?: string;
}

/** Injected IO so the orchestration is unit-testable. `nodeAfterPackIo()` is prod. */
export interface AfterPackIo {
    exists(p: string): boolean;
    /** Directory entries, or [] on any failure. */
    readdir(dir: string): string[];
    mkdirp(dir: string): void;
    copyFile(src: string, dest: string): void;
    /** Make a file executable (0o755). */
    chmodExec(p: string): void;
    /** Run a command; resolves the exit code + captured stderr. */
    run(cmd: string, args: string[]): { code: number; stderr: string };
}

/** Production {@link AfterPackIo}: real fs + child_process. */
export function nodeAfterPackIo(): AfterPackIo {
    return {
        exists: (p) => {
            try {
                return fs.existsSync(p);
            } catch {
                return false;
            }
        },
        readdir: (d) => {
            try {
                return fs.readdirSync(d);
            } catch {
                return [];
            }
        },
        mkdirp: (d) => {
            fs.mkdirSync(d, { recursive: true });
        },
        copyFile: (s, d) => {
            fs.copyFileSync(s, d);
        },
        chmodExec: (p) => {
            fs.chmodSync(p, 0o755);
        },
        run: (cmd, args) => {
            const r = spawnSync(cmd, args, { encoding: 'utf8' });
            return {
                code: r.status ?? -1,
                stderr: (r.stderr ?? '') + (r.error ? String(r.error) : ''),
            };
        },
    };
}

/** Resources dir(s) inside a packed app where `app.asar.unpacked` lives. */
function resourcesDirs(appOutDir: string, platform: string, io: AfterPackIo): string[] {
    if (platform === 'darwin') {
        // <appOutDir>/<Product>.app/Contents/Resources — the .app name varies.
        return io
            .readdir(appOutDir)
            .filter((n) => n.endsWith('.app'))
            .map((a) => path.join(appOutDir, a, 'Contents', 'Resources'));
    }
    // Windows / Linux: <appOutDir>/resources
    return [path.join(appOutDir, 'resources')];
}

/** Candidate node-pty package dirs under a resources dir (asar-unpacked or plain). */
function nodePtyCandidates(resources: string): string[] {
    return [
        path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty'),
        path.join(resources, 'app', 'node_modules', 'node-pty'),
    ];
}

/** Locate the packaged node-pty dir under `appOutDir`, or null. */
export function resolveNodePtyDir(
    appOutDir: string,
    platform: string,
    io: AfterPackIo,
): string | null {
    for (const res of resourcesDirs(appOutDir, platform, io)) {
        for (const dir of nodePtyCandidates(res)) {
            if (io.exists(dir)) return dir;
        }
    }
    return null;
}

/** Find the conpty asset source dir (`prebuilds/<plat>/conpty` or `third_party/conpty`). */
function findConptySource(nodePty: string, io: AfterPackIo): string | null {
    const prebuilds = path.join(nodePty, 'prebuilds');
    for (const name of io.readdir(prebuilds)) {
        const c = path.join(prebuilds, name, 'conpty');
        if (io.exists(path.join(c, 'conpty.dll'))) return c;
    }
    const tp = path.join(nodePty, 'third_party', 'conpty');
    if (io.exists(path.join(tp, 'conpty.dll'))) return tp;
    return null;
}

const CONPTY_ASSETS = ['conpty.dll', 'OpenConsole.exe'];

function winFixConpty(nodePty: string, release: string, io: AfterPackIo): AfterPackResult {
    const destDir = path.join(release, 'conpty');
    if (CONPTY_ASSETS.every((f) => io.exists(path.join(destDir, f)))) {
        return { platform: 'win32', action: 'already-present', ok: true };
    }
    const src = findConptySource(nodePty, io);
    if (!src) {
        return {
            platform: 'win32',
            action: 'failed',
            ok: false,
            detail: 'conpty source not found (prebuilds/*/conpty or third_party/conpty)',
        };
    }
    io.mkdirp(destDir);
    const copied: string[] = [];
    for (const f of CONPTY_ASSETS) {
        const s = path.join(src, f);
        if (io.exists(s)) {
            io.copyFile(s, path.join(destDir, f));
            copied.push(f);
        }
    }
    const ok = CONPTY_ASSETS.every((f) => io.exists(path.join(destDir, f)));
    return {
        platform: 'win32',
        action: ok ? 'fixed' : 'failed',
        ok,
        detail: `copied [${copied.join(', ')}] into build/Release/conpty from ${src}`,
    };
}

function macSignSpawnHelper(release: string, io: AfterPackIo): AfterPackResult {
    const helper = path.join(release, 'spawn-helper');
    if (!io.exists(helper)) {
        return { platform: 'darwin', action: 'skipped', ok: true, detail: 'spawn-helper not present' };
    }
    const { code, stderr } = io.run('codesign', ['--force', '--sign', '-', helper]);
    return code === 0
        ? { platform: 'darwin', action: 'fixed', ok: true, detail: 'ad-hoc signed spawn-helper' }
        : { platform: 'darwin', action: 'failed', ok: false, detail: `codesign failed: ${stderr.trim()}` };
}

function linuxChmodSpawnHelper(release: string, io: AfterPackIo): AfterPackResult {
    const helper = path.join(release, 'spawn-helper');
    if (!io.exists(helper)) {
        return { platform: 'linux', action: 'skipped', ok: true, detail: 'spawn-helper not present' };
    }
    io.chmodExec(helper);
    return { platform: 'linux', action: 'fixed', ok: true, detail: 'chmod +x spawn-helper' };
}

/**
 * Make a packaged node-pty spawn a working terminal on the platform being packed.
 * Call from electron-builder's `afterPack`. NEVER throws for the expected
 * outcomes; returns a result describing what it did (inspect `ok`). Idempotent —
 * safe to run on every build.
 */
export async function fancyTermAfterPack(
    context: AfterPackContext,
    opts: AfterPackOptions = {},
    io: AfterPackIo = nodeAfterPackIo(),
): Promise<AfterPackResult> {
    const platform = opts.platform ?? context.electronPlatformName;
    const nodePty = opts.nodePtyDir ?? resolveNodePtyDir(context.appOutDir, platform, io);
    if (!nodePty) {
        return {
            platform,
            action: 'skipped',
            ok: false,
            detail: 'node-pty not found under appOutDir (adjust asarUnpack or pass nodePtyDir)',
        };
    }
    const release = path.join(nodePty, 'build', 'Release');
    switch (platform) {
        case 'win32':
            return winFixConpty(nodePty, release, io);
        case 'darwin':
            return macSignSpawnHelper(release, io);
        case 'linux':
            return linuxChmodSpawnHelper(release, io);
        default:
            return { platform, action: 'skipped', ok: true, detail: 'no packaging fix needed' };
    }
}
