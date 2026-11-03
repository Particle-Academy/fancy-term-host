// Runs one real spawn through the BUILT package and prints the outcome as one
// JSON line. Driven by verbatim-live.test.ts, in a child process so the singleton
// backend, the host and any crash stay out of the test worker.
//
//   node verbatim-drive.mjs <spec.json>
//   spec: { dist, backend: 'in-process' | 'host', userData?, create }

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRIVATE_PIPE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'private-pipe.cjs');
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const mod = await import(pathToFileURL(path.join(spec.dist, 'index.js')).href);

const snapshots = {
    readSnapshot: () => null,
    writeSnapshot: () => 1,
    deleteSnapshot: () => undefined,
    encrypting: () => false,
};

let hostProcess;
let hostBacked = false;
let result = {};

try {
    if (spec.backend === 'host') {
        mod.configureHostLifecycle({
            settings: { get: (k) => (k === 'detached_terminals' ? 'on' : undefined) },
            snapshots,
            onHostStatus: (s) => {
                result.hostStatus = s.message;
            },
            spawner: {
                userDataDir: () => spec.userData,
                resolveHostScript: () => path.join(spec.dist, 'pty-host.js'),
                // Not `detached`: the driver ends the host itself, and a hidden
                // child of a hidden process can never open a window.
                //
                // The preload gives it a pipe of its own, because the default
                // Windows pipe is machine-wide and belongs to whatever real host
                // an app on this machine is running.
                spawnDetached: (script, env) => {
                    hostProcess = spawn(process.execPath, ['--require', PRIVATE_PIPE, script], {
                        stdio: 'ignore',
                        windowsHide: true,
                        env: {
                            ...process.env,
                            ...env,
                            FTH_TEST_PIPE_TAG: `verbatim-${process.pid}`,
                        },
                    });
                },
            },
        });
        const init = await mod.initTerminalBackend();
        hostBacked = init.host;
        if (!hostBacked) throw new Error(`no detached host: ${result.hostStatus}`);
        const pf = mod.readPidfile(spec.userData);
        if (process.platform === 'win32' && pf?.socketPath === mod.socketPathFor(spec.userData)) {
            throw new Error('the test host is on the machine-wide default pipe');
        }
    } else {
        mod.configureInProcessBackend({ settings: { get: () => undefined }, snapshots });
    }

    const backend = mod.terminalManager();
    let output = '';
    backend.on('data', (_id, d) => {
        output += d;
    });
    const exited = new Promise((r) => backend.on('exit', (_id, p) => r(p)));
    backend.create(spec.create);
    const exit = await Promise.race([
        exited,
        new Promise((r) => setTimeout(() => r('TIMEOUT'), 30_000)),
    ]);
    // Output racing the exit across a socket still counts as output.
    await new Promise((r) => setTimeout(r, 400));
    result = { ...result, exit, output, hostBacked };
} catch (err) {
    result = { ...result, error: String((err && err.message) || err), hostBacked };
}

if (spec.backend === 'host') {
    await mod.shutdownHost().catch(() => {});
    hostProcess?.kill();
}
console.log(JSON.stringify(result));
process.exit(0);
