/**
 * Spawn-cwd normalization (Tier 1.5 companion to osc7.ts).
 *
 * Git Bash / MSYS reports `$PWD` in MSYS form (`/c/Users/me`), not native
 * Windows (`C:\Users\me`). The OSC-7 hook emits that raw, and `parseFileUrl`
 * only converts the drive-colon form (`/C:/...`), so an MSYS path flows through
 * unchanged. Handing `/c/Users/me` to node-pty as a working dir makes Windows
 * fail with ERROR_DIRECTORY (error code 267) — terminal creation crashes.
 *
 * Two small, OS-agnostic helpers fix this at the source:
 *   - `toNativeCwd` converts an MSYS path to native Windows form (no-op on
 *     POSIX, or when already native).
 *   - `resolveSpawnCwd` native-converts the requested dir AND validates it,
 *     falling back to the home directory so a stale/foreign/deleted cwd can
 *     never crash spawn.
 *
 * Used at both spawn sites (manager.ts, pty-host.ts) and at the OSC-7 capture
 * so the persisted `live_cwd` is already a valid native path.
 */

import { existsSync, statSync } from 'node:fs';
import os from 'node:os';

/**
 * Convert an MSYS/Git-Bash cwd to a native Windows path.
 *   /c/Users/me  -> C:\Users\me
 *   /d/work      -> D:\work
 *   /c           -> C:\        (bare drive root)
 * No-op on non-win32, on an empty string, or on an already-native path.
 */
export function toNativeCwd(p: string): string {
    if (process.platform !== 'win32' || !p) return p;
    const m = /^\/([A-Za-z])\/(.*)$/.exec(p);
    if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
    const root = /^\/([A-Za-z])\/?$/.exec(p);
    if (root) return `${root[1].toUpperCase()}:\\`;
    return p;
}

/**
 * Resolve the directory a pty should actually spawn in. Prefer the requested
 * dir (native-converted); if it isn't an existing directory, fall back to the
 * home directory — so a stale, foreign, or deleted cwd can't crash spawn.
 */
export function resolveSpawnCwd(requested: string | undefined | null): string {
    if (requested) {
        const native = toNativeCwd(requested);
        try {
            if (existsSync(native) && statSync(native).isDirectory()) return native;
        } catch {
            /* fall through to home */
        }
    }
    return os.homedir();
}
