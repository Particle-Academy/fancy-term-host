import path from 'node:path';
import fs from 'node:fs';
import type { ServiceRuntime } from './types';

/**
 * Locate a STANDALONE Node runtime to run the host service on — explicitly NOT
 * the consumer's Electron binary, whose whole problem is that running the host
 * on it pins the executable across auto-updates.
 *
 * Precedence:
 *   1. An explicit `nodePath` (the consumer ships/locates its own node).
 *   2. `$FANCY_TERM_NODE` (a deploy-time override).
 *   3. `process.execPath` — but ONLY if the current process is plain Node, not
 *      Electron (`process.versions.electron`), and the binary is named `node`.
 *   4. A `node` / `node.exe` found on `$PATH`.
 *
 * Returns null when no safe standalone runtime is found — the caller should then
 * fall back to the existing detached-spawn (which works for a normal quit) or
 * in-process. Never throws.
 */
export interface ResolveRuntimeOptions {
    /** Explicit standalone node path (wins). */
    nodePath?: string;
    /** Directory with an ABI-matched node-pty for that runtime. */
    nodePtyDir?: string;
    /** Environment to read overrides from. Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Current process binary. Defaults to `process.execPath`. */
    execPath?: string;
    /** Whether the current process is Electron. Defaults to detecting it. */
    isElectron?: boolean;
    /** PATH lookup probe (injectable for tests). Defaults to an fs probe. */
    pathProbe?: (binNames: string[], env: NodeJS.ProcessEnv) => string | null;
}

export function resolveServiceRuntime(
    opts: ResolveRuntimeOptions = {},
): ServiceRuntime | null {
    const env = opts.env ?? process.env;
    const execPath = opts.execPath ?? process.execPath;
    const isElectron =
        opts.isElectron ?? Boolean((process as { versions?: Record<string, string> }).versions?.electron);
    const nodePtyDir = opts.nodePtyDir ?? env.FANCY_TERM_NODE_PTY ?? undefined;
    const probe = opts.pathProbe ?? defaultPathProbe;

    const finish = (nodePath: string, source: string): ServiceRuntime => ({
        nodePath,
        ...(nodePtyDir ? { nodePtyDir } : {}),
        source,
    });

    // 1) Explicit.
    if (opts.nodePath) return finish(opts.nodePath, 'explicit');

    // 2) Env override.
    if (env.FANCY_TERM_NODE) return finish(env.FANCY_TERM_NODE, 'env:FANCY_TERM_NODE');

    // 3) The current process — only if it's a real standalone node.
    if (!isElectron && looksLikeNode(execPath)) {
        return finish(execPath, 'process.execPath');
    }

    // 4) PATH lookup.
    const onPath = probe(nodeBinNames(), env);
    if (onPath) return finish(onPath, 'PATH');

    return null;
}

function nodeBinNames(): string[] {
    return process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
}

function looksLikeNode(execPath: string): boolean {
    const base = path.basename(execPath).toLowerCase();
    return base === 'node' || base === 'node.exe';
}

/** Walk `$PATH`, returning the first existing `node`/`node.exe`. */
function defaultPathProbe(
    binNames: string[],
    env: NodeJS.ProcessEnv,
): string | null {
    const PATH = env.PATH ?? env.Path ?? '';
    const dirs = PATH.split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        for (const bin of binNames) {
            const candidate = path.join(dir, bin);
            try {
                if (fs.existsSync(candidate)) return candidate;
            } catch {
                /* keep looking */
            }
        }
    }
    return null;
}
