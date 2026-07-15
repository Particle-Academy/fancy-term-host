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
