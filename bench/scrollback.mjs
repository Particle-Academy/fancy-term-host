#!/usr/bin/env node
// Scrollback throughput benchmark.
//
//   node --expose-gc bench/scrollback.mjs <distDir> [--mb 100] [--chunk 4096] [--label name]
//
// Pushes <mb> MiB of terminal-shaped output through ONE pty's onData path in
// the BUILT in-process backend (`<distDir>/index.js`), with an injected fake
// pty, and prints CPU time, wall time, peak JS heap and max RSS as one JSON
// line. Driving the built artifact rather than src is what lets the SAME
// script measure an old release and the new code on the same runner: build the
// old tag into one directory, the new code into another, point this at each.
//
// What it measures is the whole onData path a consumer's main thread pays for
// per chunk -- scrollback append + trim, the OSC-7 scan, and the `data` emit --
// because that is the cost a chatty process actually imposes. The OSC-7 scan
// and the emit are identical in both builds, so a difference is the scrollback.
//
// The final scrollback is checked against the last N code units of the stream,
// so a fast-but-wrong implementation reports ok:false rather than a good number.
//
// Run under CI, not on a desktop: `.github/workflows/bench.yml`.

import path from 'node:path';
import v8 from 'node:v8';
import { pathToFileURL } from 'node:url';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const distDir = process.argv[2];
if (!distDir || distDir.startsWith('--')) {
    console.error('usage: node --expose-gc bench/scrollback.mjs <distDir> [--mb 100] [--chunk 4096] [--label name]');
    process.exit(2);
}
const MB = Number(arg('mb', '100'));
const CHUNK = Number(arg('chunk', '4096'));
const LABEL = arg('label', distDir);
const CAP = 1_000_000;
const SAMPLE_EVERY = 16;

const mod = await import(pathToFileURL(path.resolve(distDir, 'index.js')).href);

// A pool of distinct, flat, terminal-shaped chunks: printable text, CRLF and
// SGR colour sequences, so the content resembles a build log rather than one
// repeated character (which some string representations special-case).
const ESC = String.fromCharCode(0x1b);
const POOL = 64;
const pool = [];
let seed = 12345;
for (let p = 0; p < POOL; p++) {
    let s = '';
    while (s.length < CHUNK) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const r = seed % 100;
        if (r < 3) s += `${ESC}[3${seed % 8}m`;
        else if (r < 6) s += String.fromCharCode(13, 10);
        else s += String.fromCharCode(32 + (seed % 95));
    }
    // Flatten: a rope here would make the first trim pay for building the pool.
    pool.push(Buffer.from(s.slice(0, CHUNK), 'latin1').toString('latin1'));
}

let onData = null;
mod.configureInProcessBackend({
    ptySpawn: () => ({
        pid: 1,
        process: 'bench',
        onData(cb) {
            onData = cb;
        },
        onExit() {},
        write() {},
        resize() {},
        kill() {},
    }),
    settings: { get: () => undefined },
    snapshots: {
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => {},
        encrypting: () => false,
    },
});
const backend = mod.inProcessBackend();
backend.create({ id: 'bench', cwd: process.cwd(), shell: 'bench', args: [] });
let emitted = 0;
backend.on('data', () => {
    emitted++;
});

const total = Math.floor((MB * 1024 * 1024) / CHUNK);

if (typeof globalThis.gc === 'function') globalThis.gc();
const heapBase = v8.getHeapStatistics().used_heap_size;
let heapPeak = heapBase;

const cpu0 = process.cpuUsage();
const t0 = process.hrtime.bigint();
for (let i = 0; i < total; i++) {
    onData(pool[i % POOL]);
    if (i % SAMPLE_EVERY === 0) {
        const h = v8.getHeapStatistics().used_heap_size;
        if (h > heapPeak) heapPeak = h;
    }
}
// One read at the end -- what a quit-time snapshot or a late attach costs.
const sb = backend.getScrollback('bench');
const t1 = process.hrtime.bigint();
const cpu = process.cpuUsage(cpu0);
const h = v8.getHeapStatistics().used_heap_size;
if (h > heapPeak) heapPeak = h;

// Reference: the last CAP code units of the stream, rebuilt from the pool.
let tail = '';
for (let i = total - 1; i >= 0 && tail.length < CAP; i--) tail = pool[i % POOL] + tail;
const expected = tail.length > CAP ? tail.slice(tail.length - CAP) : tail;

const result = {
    label: LABEL,
    mib: MB,
    chunk: CHUNK,
    chunks: total,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
    cpuTotalMs: Math.round((cpu.user + cpu.system) / 1000),
    wallMs: Math.round(Number(t1 - t0) / 1e6),
    peakHeapMiB: +((heapPeak / 1048576).toFixed(1)),
    peakHeapAboveBaseMiB: +(((heapPeak - heapBase) / 1048576).toFixed(1)),
    maxRssMiB: +((process.resourceUsage().maxRSS / 1024).toFixed(1)),
    scrollbackLen: sb.length,
    emitted,
    ok: sb === expected && emitted === total,
};
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
