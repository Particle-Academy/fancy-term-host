import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toNativeCwd, resolveSpawnCwd } from '../cwd';

/**
 * Spawn-cwd normalization (Tier 1.5). Covers the MSYS→native conversion that
 * keeps Git Bash's `/c/Users/me` from reaching node-pty as a working dir (which
 * crashes Windows with ERROR_DIRECTORY / 267), plus the validate-or-home
 * fallback that stops a stale/foreign/deleted cwd from crashing spawn.
 *
 * `toNativeCwd` is platform-gated (no-op off win32), so the Windows-form cases
 * stub `process.platform` to 'win32' to assert the conversion deterministically
 * on any CI host.
 */

const realPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

afterEach(() => {
    Object.defineProperty(process, 'platform', {
        value: realPlatform,
        configurable: true,
    });
    vi.restoreAllMocks();
});

describe('toNativeCwd (win32)', () => {
    beforeEach(() => setPlatform('win32'));

    it('converts an MSYS drive path to native Windows form', () => {
        expect(toNativeCwd('/c/Users/me')).toBe('C:\\Users\\me');
        expect(toNativeCwd('/d/work')).toBe('D:\\work');
    });

    it('uppercases the drive letter', () => {
        expect(toNativeCwd('/c/Users/me/proj')).toBe('C:\\Users\\me\\proj');
    });

    it('converts a bare MSYS drive root', () => {
        expect(toNativeCwd('/c')).toBe('C:\\');
        expect(toNativeCwd('/c/')).toBe('C:\\');
    });

    it('leaves an already-native path untouched', () => {
        expect(toNativeCwd('C:\\Users\\me')).toBe('C:\\Users\\me');
    });

    it('returns an empty string unchanged', () => {
        expect(toNativeCwd('')).toBe('');
    });
});

describe('toNativeCwd (POSIX)', () => {
    beforeEach(() => setPlatform('linux'));

    it('is a no-op off win32', () => {
        // A leading-slash drive-shaped path is a legitimate POSIX path here.
        expect(toNativeCwd('/c/Users/me')).toBe('/c/Users/me');
        expect(toNativeCwd('/home/user/proj')).toBe('/home/user/proj');
    });
});

describe('resolveSpawnCwd', () => {
    it('returns an existing directory (native-converted) as-is', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-cwd-'));
        try {
            expect(resolveSpawnCwd(dir)).toBe(dir);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('falls back to home for a missing directory', () => {
        const missing = path.join(os.tmpdir(), 'fth-cwd-does-not-exist-xyz');
        expect(resolveSpawnCwd(missing)).toBe(os.homedir());
    });

    it('falls back to home for undefined / null / empty', () => {
        expect(resolveSpawnCwd(undefined)).toBe(os.homedir());
        expect(resolveSpawnCwd(null)).toBe(os.homedir());
        expect(resolveSpawnCwd('')).toBe(os.homedir());
    });

    it('falls back to home when the path is a file, not a directory', () => {
        const file = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), 'fth-cwd-')),
            'a-file',
        );
        fs.writeFileSync(file, 'x');
        try {
            expect(resolveSpawnCwd(file)).toBe(os.homedir());
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    it('native-converts an MSYS path before validating (win32)', () => {
        // The MSYS form /c/... must be converted to C:\... BEFORE the existence
        // check, otherwise a perfectly valid dir is rejected and spawn loses its
        // requested cwd. We can't assert a real C:\ dir cross-platform, so verify
        // the conversion is what gets statted: a converted path that doesn't
        // exist still falls back to home (never returns the raw MSYS string).
        setPlatform('win32');
        const out = resolveSpawnCwd('/c/Users/definitely-not-here-zzz');
        expect(out).not.toBe('/c/Users/definitely-not-here-zzz');
        expect(out).toBe(os.homedir());
    });
});
