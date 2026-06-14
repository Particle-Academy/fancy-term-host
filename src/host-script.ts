import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHostScript } from './host-locate';

/**
 * Absolute path to the bundled detached pty-host script (Tier 3), so a
 * `HostSpawner` can launch it as a detached child without knowing this
 * package's dist layout:
 *
 * ```ts
 * import { spawn } from 'node:child_process';
 * import { ptyHostScriptPath } from '@particle-academy/fancy-term-host';
 *
 * const child = spawn(process.execPath, [ptyHostScriptPath(), userDataDir], {
 *   detached: true, stdio: 'ignore',
 * });
 * child.unref();
 * ```
 *
 * The host script is emitted alongside this module in `dist/` as
 * `pty-host.js`. Works in both the ESM and CJS builds (esbuild fills in
 * `import.meta.url` for the CJS output; `__dirname` is used when present).
 */
export function ptyHostScriptPath(): string {
    const here =
        typeof __dirname !== 'undefined'
            ? __dirname
            : path.dirname(fileURLToPath(import.meta.url));
    // Reuse host-locate's candidate logic (handles dev/packaged layouts); fall
    // back to the expected emitted location if the existence probe misses.
    return resolveHostScript(here) ?? path.join(here, 'pty-host.js');
}
