#!/usr/bin/env node
// Lost-exit stress for the IN-PROCESS backend (the one Genie uses).
//
// Opens N real ptys one after another (or --concurrency at a time), lets each
// run a short command to its NATURAL exit, waits for the backend's `exit`
// event with a timeout, and counts (a) the ptys whose exit never arrived and
// (b) the backend's live count (`list().length`) after the run. Also counts
// process warnings, because fancy-pty reports a throwing listener as one --
// which is how an exit is swallowed without anything crashing.
//
//   node bench/exit-stress.mjs [--from <dir>] [--n 120] [--runs 5]
//        [--timeout 15000] [--mode argv|typed|typednow] [--shell <exe>]
//        [--concurrency 1]
//
// --from     a directory whose node_modules resolves
//            @particle-academy/fancy-term-host (and through it fancy-pty) --
//            e.g. a consumer's app dir, or a scratch install of a release.
//            Absent: this repo's own built dist/ (run `npm run build` first).
// --mode     argv     : the command is in argv (`cmd /d /c echo hi`,
//                       `pwsh -Command Write-Output hi`, `sh -c 'echo hi'`)
//            typed    : an interactive shell; `echo hi` and `exit` are TYPED
//                       after its first output
//            typednow : the same, typed immediately after create()
// --shell    defaults to %COMSPEC% on Windows, /bin/sh elsewhere.
//
// One JSON line per run, then a summary line. Exit 1 if any exit was lost, any
// pty was still listed, or any warning was emitted.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const from = arg('from', undefined);
const N = Number(arg('n', '120'));
const RUNS = Number(arg('runs', '5'));
const TIMEOUT = Number(arg('timeout', '15000'));
const MODE = arg('mode', 'argv');
const CONC = Number(arg('concurrency', '1'));

const warnings = [];
process.on('warning', (w) => warnings.push(String(w && w.message)));

let mod;
let versions = {};
if (from) {
    const req = createRequire(path.resolve(from, 'package.json'));
    const entry = req.resolve('@particle-academy/fancy-term-host');
    mod = await import(pathToFileURL(entry.replace(/index\.cjs$/, 'index.js')).href);
    for (const p of ['@particle-academy/fancy-term-host', '@particle-academy/fancy-pty']) {
        const short = p.split('/')[1];
        try {
            versions[short] = req(`${p}/package.json`).version;
        } catch {
            try {
                // fancy-pty is resolved FROM term-host, so ask it.
                versions[short] = createRequire(entry)(`${p}/package.json`).version;
            } catch {
                versions[short] = 'absent';
            }
        }
    }
} else {
    const here = path.dirname(fileURLToPath(import.meta.url));
    mod = await import(pathToFileURL(path.resolve(here, '..', 'dist', 'index.js')).href);
    const req = createRequire(path.resolve(here, '..', 'package.json'));
    versions = {
        'fancy-term-host': `${req('./package.json').version} (repo dist)`,
        'fancy-pty': req('@particle-academy/fancy-pty/package.json').version,
    };
}

const backend = mod.inProcessBackend();
const win = process.platform === 'win32';
const shell = arg('shell', win ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh');
const isPwsh = /pwsh|powershell/i.test(shell);

const pending = new Map(); // id -> resolve
backend.on('exit', (id, payload) => {
    const r = pending.get(id);
    if (r) r(payload);
});
const firstData = new Map();
backend.on('data', (id) => {
    const f = firstData.get(id);
    if (f) {
        firstData.delete(id);
        f();
    }
});

async function cycle(id) {
    const exited = new Promise((resolve) => pending.set(id, resolve));
    if (MODE === 'typed' || MODE === 'typednow') {
        const ready = new Promise((resolve) => firstData.set(id, resolve));
        backend.create({ id, shell, args: [] });
        if (MODE === 'typed') await Promise.race([ready, new Promise((r) => setTimeout(r, 2000))]);
        backend.write(id, win ? 'echo hi\r' : 'echo hi\n');
        backend.write(id, win ? 'exit\r' : 'exit\n');
    } else {
        const args = isPwsh
            ? ['-NoLogo', '-NoProfile', '-Command', 'Write-Output hi']
            : win
              ? ['/d', '/c', 'echo hi']
              : ['-c', 'echo hi'];
        backend.create({ id, shell, args });
    }
    let timer;
    const ok = await Promise.race([
        exited.then(() => true),
        new Promise((r) => (timer = setTimeout(() => r(false), TIMEOUT))),
    ]);
    clearTimeout(timer);
    pending.delete(id);
    firstData.delete(id);
    return ok;
}

let totalLost = 0;
let totalLive = 0;
for (let run = 0; run < RUNS; run++) {
    const t0 = Date.now();
    const lostCycles = [];
    let next = 0;
    async function worker() {
        while (next < N) {
            const i = next++;
            if (!(await cycle(`stress-${process.pid}-${run}-${i}`))) lostCycles.push(i);
        }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    const live = backend.list().length;
    console.log(JSON.stringify({ run, n: N, lost: lostCycles.length, lostCycles, live, ms: Date.now() - t0 }));
    totalLost += lostCycles.length;
    totalLive += live;
    // A lost pty stays listed; clear it so the next run starts from zero.
    backend.killAll();
}

console.log(
    JSON.stringify({
        summary: true,
        versions,
        platform: `${process.platform}-${process.arch}`,
        shell,
        mode: MODE,
        concurrency: CONC,
        runs: RUNS,
        opened: RUNS * N,
        lost: totalLost,
        liveAtEndSum: totalLive,
        warnings,
    }),
);
setTimeout(() => process.exit(totalLost || totalLive || warnings.length ? 1 : 0), 200);
