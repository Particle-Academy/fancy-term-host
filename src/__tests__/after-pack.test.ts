import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
    fancyTermAfterPack,
    resolveNodePtyDir,
    type AfterPackIo,
} from '../electron/after-pack';

/**
 * Tier 0 — the electron-builder afterPack node-pty fix-ups (#7). We drive the
 * helper with a fully in-memory {@link AfterPackIo} so the per-OS decision +
 * file operations are asserted without touching the disk or spawning codesign.
 */

/** An in-memory IO: `files` is the set of existing paths; dirs maps a dir → its
 *  entries. `runs` records commands; `copies`/`chmods` record mutations. */
function fakeIo(init: {
    files?: string[];
    dirs?: Record<string, string[]>;
    runResult?: { code: number; stderr: string };
}) {
    const files = new Set(init.files ?? []);
    const dirs = init.dirs ?? {};
    const runs: Array<{ cmd: string; args: string[] }> = [];
    const copies: Array<{ src: string; dest: string }> = [];
    const chmods: string[] = [];
    const mkdirs: string[] = [];
    const io: AfterPackIo = {
        exists: (p) => files.has(p),
        readdir: (d) => dirs[d] ?? [],
        mkdirp: (d) => {
            mkdirs.push(d);
        },
        copyFile: (src, dest) => {
            copies.push({ src, dest });
            files.add(dest); // the copied file now exists
        },
        chmodExec: (p) => {
            chmods.push(p);
        },
        run: (cmd, args) => {
            runs.push({ cmd, args });
            return init.runResult ?? { code: 0, stderr: '' };
        },
    };
    return { io, runs, copies, chmods, mkdirs, files };
}

const CTX = { appOutDir: '/out', electronPlatformName: 'linux' };

describe('resolveNodePtyDir', () => {
    it('finds node-pty under app.asar.unpacked (win/linux resources)', () => {
        // path.join so the expectation matches the host OS separator.
        const dir = path.join('/out', 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty');
        const { io } = fakeIo({ files: [dir] });
        expect(resolveNodePtyDir('/out', 'linux', io)).toBe(dir);
    });

    it('finds node-pty inside the .app bundle on darwin', () => {
        const dir = path.join(
            '/out',
            'My App.app',
            'Contents',
            'Resources',
            'app.asar.unpacked',
            'node_modules',
            'node-pty',
        );
        const { io } = fakeIo({ files: [dir], dirs: { '/out': ['My App.app'] } });
        expect(resolveNodePtyDir('/out', 'darwin', io)).toBe(dir);
    });

    it('returns null when node-pty is not packaged', () => {
        const { io } = fakeIo({ files: [] });
        expect(resolveNodePtyDir('/out', 'linux', io)).toBeNull();
    });
});

describe('fancyTermAfterPack — win32 conpty subdir', () => {
    const nodePty = '/np';
    const release = path.join(nodePty, 'build', 'Release');
    const srcDir = path.join(nodePty, 'prebuilds', 'win32-x64', 'conpty');

    it('copies conpty.dll + OpenConsole.exe into build/Release/conpty', async () => {
        const { io, copies, mkdirs } = fakeIo({
            files: [path.join(srcDir, 'conpty.dll'), path.join(srcDir, 'OpenConsole.exe')],
            dirs: { [path.join(nodePty, 'prebuilds')]: ['win32-x64'] },
        });
        const res = await fancyTermAfterPack(
            { appOutDir: '/out', electronPlatformName: 'win32' },
            { nodePtyDir: nodePty },
            io,
        );
        expect(res.action).toBe('fixed');
        expect(res.ok).toBe(true);
        expect(mkdirs).toContain(path.join(release, 'conpty'));
        expect(copies.map((c) => c.dest)).toEqual([
            path.join(release, 'conpty', 'conpty.dll'),
            path.join(release, 'conpty', 'OpenConsole.exe'),
        ]);
    });

    it('is a no-op when the conpty subdir is already populated', async () => {
        const { io, copies } = fakeIo({
            files: [
                path.join(release, 'conpty', 'conpty.dll'),
                path.join(release, 'conpty', 'OpenConsole.exe'),
            ],
        });
        const res = await fancyTermAfterPack(
            { appOutDir: '/out', electronPlatformName: 'win32' },
            { nodePtyDir: nodePty },
            io,
        );
        expect(res.action).toBe('already-present');
        expect(copies).toHaveLength(0);
    });

    it('reports failure when no conpty source exists', async () => {
        const { io } = fakeIo({ files: [] });
        const res = await fancyTermAfterPack(
            { appOutDir: '/out', electronPlatformName: 'win32' },
            { nodePtyDir: nodePty },
            io,
        );
        expect(res.ok).toBe(false);
        expect(res.action).toBe('failed');
    });
});

describe('fancyTermAfterPack — win32 conpty arch selection (#9)', () => {
    const nodePty = '/np';
    const release = path.join(nodePty, 'build', 'Release');
    const prebuilds = path.join(nodePty, 'prebuilds');
    const x64 = path.join(prebuilds, 'win32-x64', 'conpty');
    const arm64 = path.join(prebuilds, 'win32-arm64', 'conpty');

    /** A node-pty that ships BOTH arch prebuilds; arm64 sorts first in readdir. */
    function multiArchIo() {
        return fakeIo({
            files: [
                path.join(arm64, 'conpty.dll'),
                path.join(arm64, 'OpenConsole.exe'),
                path.join(x64, 'conpty.dll'),
                path.join(x64, 'OpenConsole.exe'),
            ],
            // arm64 first — the ordering that regressed x64 builds.
            dirs: { [prebuilds]: ['win32-arm64', 'win32-x64'] },
        });
    }

    it('picks the x64 prebuild for an x64 target even though arm64 sorts first', async () => {
        const { io, copies } = multiArchIo();
        const res = await fancyTermAfterPack(
            { appOutDir: '/out', electronPlatformName: 'win32', arch: 1 /* Arch.x64 */ },
            { nodePtyDir: nodePty },
            io,
        );
        expect(res.action).toBe('fixed');
        expect(copies.map((c) => c.src)).toEqual([
            path.join(x64, 'conpty.dll'),
            path.join(x64, 'OpenConsole.exe'),
        ]);
        expect(res.detail).toContain('win32-x64');
    });

    it('picks the arm64 prebuild for an arm64 target', async () => {
        const { io, copies } = multiArchIo();
        const res = await fancyTermAfterPack(
            { appOutDir: '/out', electronPlatformName: 'win32', arch: 3 /* Arch.arm64 */ },
            { nodePtyDir: nodePty },
            io,
        );
        expect(res.ok).toBe(true);
        expect(copies.every((c) => c.src.startsWith(arm64))).toBe(true);
    });

    it('honors an opts.arch string override', async () => {
        const { io, copies } = multiArchIo();
        const res = await fancyTermAfterPack(
            { appOutDir: '/out', electronPlatformName: 'win32' /* no context.arch */ },
            { nodePtyDir: nodePty, arch: 'x64' },
            io,
        );
        expect(res.ok).toBe(true);
        expect(copies.every((c) => c.src.startsWith(x64))).toBe(true);
    });

    it('honors an explicit opts.conptySource override', async () => {
        const custom = path.join(nodePty, 'third_party', 'conpty');
        const { io, copies } = fakeIo({
            files: [path.join(custom, 'conpty.dll'), path.join(custom, 'OpenConsole.exe')],
        });
        const res = await fancyTermAfterPack(
            { appOutDir: '/out', electronPlatformName: 'win32', arch: 1 },
            { nodePtyDir: nodePty, conptySource: custom },
            io,
        );
        expect(res.ok).toBe(true);
        expect(copies.every((c) => c.src.startsWith(custom))).toBe(true);
    });

    it('falls back to the first prebuild when the target arch dir is absent', async () => {
        // Only arm64 shipped; x64 target has no matching prebuild → best-effort first match.
        const { io, copies } = fakeIo({
            files: [path.join(arm64, 'conpty.dll'), path.join(arm64, 'OpenConsole.exe')],
            dirs: { [prebuilds]: ['win32-arm64'] },
        });
        const res = await fancyTermAfterPack(
            { appOutDir: '/out', electronPlatformName: 'win32', arch: 1 },
            { nodePtyDir: nodePty },
            io,
        );
        expect(res.ok).toBe(true);
        expect(copies.every((c) => c.src.startsWith(arm64))).toBe(true);
    });

    it('still works for a single-arch install with no arch hint', async () => {
        const { io, copies } = fakeIo({
            files: [path.join(x64, 'conpty.dll'), path.join(x64, 'OpenConsole.exe')],
            dirs: { [prebuilds]: ['win32-x64'] },
        });
        const res = await fancyTermAfterPack(
            { appOutDir: '/out', electronPlatformName: 'win32' },
            { nodePtyDir: nodePty },
            io,
        );
        expect(res.ok).toBe(true);
        expect(copies.map((c) => c.dest)).toEqual([
            path.join(release, 'conpty', 'conpty.dll'),
            path.join(release, 'conpty', 'OpenConsole.exe'),
        ]);
    });
});

describe('fancyTermAfterPack — darwin spawn-helper signing', () => {
    const nodePty = '/np';
    const helper = path.join(nodePty, 'build', 'Release', 'spawn-helper');

    it('ad-hoc signs spawn-helper via codesign', async () => {
        const { io, runs } = fakeIo({ files: [helper] });
        const res = await fancyTermAfterPack(
            { appOutDir: '/out', electronPlatformName: 'darwin' },
            { nodePtyDir: nodePty },
            io,
        );
        expect(res.action).toBe('fixed');
        expect(runs).toEqual([{ cmd: 'codesign', args: ['--force', '--sign', '-', helper] }]);
    });

    it('surfaces a codesign failure', async () => {
        const { io } = fakeIo({ files: [helper], runResult: { code: 1, stderr: 'boom' } });
        const res = await fancyTermAfterPack(
            { appOutDir: '/out', electronPlatformName: 'darwin' },
            { nodePtyDir: nodePty },
            io,
        );
        expect(res.ok).toBe(false);
        expect(res.detail).toContain('boom');
    });
});

describe('fancyTermAfterPack — linux spawn-helper +x', () => {
    it('chmod +x the spawn-helper', async () => {
        const nodePty = '/np';
        const helper = path.join(nodePty, 'build', 'Release', 'spawn-helper');
        const { io, chmods } = fakeIo({ files: [helper] });
        const res = await fancyTermAfterPack(
            { appOutDir: '/out', electronPlatformName: 'linux' },
            { nodePtyDir: nodePty },
            io,
        );
        expect(res.action).toBe('fixed');
        expect(chmods).toEqual([helper]);
    });
});

describe('fancyTermAfterPack — no node-pty found', () => {
    it('skips (not ok) when node-pty is absent from the packaged app', async () => {
        const { io } = fakeIo({ files: [] });
        const res = await fancyTermAfterPack(CTX, {}, io);
        expect(res.ok).toBe(false);
        expect(res.action).toBe('skipped');
    });
});
