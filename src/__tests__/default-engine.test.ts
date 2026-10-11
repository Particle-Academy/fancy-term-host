import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The DEFAULT pty engine, exercised against both BUILT halves.
 *
 * WHY THIS FILE EXISTS. Every other test in this suite injects `ptySpawn`, so
 * none of them ever walks the branch that resolves the real engine — and a bug
 * lived exactly there: `engineFor` used a bare `require()`, which works in the
 * CJS output and **throws** in the ESM one, because esbuild rewrites it to a
 * stub raising `Dynamic require of "…" is not supported`. 187 tests passed. The
 * default engine was reachable from `dist/index.cjs` and dead from
 * `dist/index.js` — and the ESM entry is the one an Electron main bundle uses.
 *
 * It took running a real terminal through the built output to see it. So this
 * does that, in both halves, because the asymmetry between them IS the defect
 * class: a dual build has two module systems, and a test against source
 * exercises neither.
 *
 * Two deliberate choices, each of which the first draft of this file got wrong:
 *
 * - **It drives the repo's OWN `dist/`, and writes its driver scripts INSIDE
 *   the repo.** The first version built to `os.tmpdir()`, and every case failed
 *   for an unrelated reason: Node resolves `@particle-academy/fancy-pty` by
 *   walking up from the FILE's directory, so a driver under `%TEMP%` finds no
 *   `node_modules` at all. A test for "does the external dependency resolve"
 *   must not relocate the thing doing the resolving.
 * - **It spawns a real shell.** A mocked engine here would re-create the exact
 *   blind spot the file exists to close.
 */

const root = path.resolve(__dirname, '..', '..');
/**
 * Inside the repo, so module resolution reaches `root/node_modules` — and NOT
 * the shared `dist/`, because `ipc-entry.test.ts` also invokes tsup and
 * `clean: true` means one build wipes the directory the other is reading.
 * Vitest runs files in parallel, so the two raced and both failed
 * intermittently. A scratch dir under the repo satisfies both constraints at
 * once.
 */
const scratch = path.join(root, '.tmp-default-engine');
const dist = path.join(scratch, 'dist');

const isWindows = process.platform === 'win32';
/** The product never appears in the input, so finding it proves the SHELL RAN. */
const ORACLE = '7006652';
const shell = isWindows ? 'cmd.exe' : '/bin/sh';
const feed = isWindows ? 'set /a 1234*5678\r\nexit\r\n' : 'expr 1234 \\* 5678\nexit\n';

/** ESM driver: top-level await, dynamic import of the ESM entry. */
const esmDriver = (entry: string) => `
// pathToFileURL: an absolute Windows path is not a valid ESM specifier, so a
// dynamic import of a drive-letter path fails in the ESM loader while the same
// path resolves fine through require. Another asymmetry between the two halves,
// found the same way as the one this file exists for.
const { terminalManager, configureInProcessBackend } = await import(${JSON.stringify(pathToFileURL(entry).href)});
${body(entry)}
`;

/** CJS driver: plain require inside an async IIFE. */
const cjsDriver = (entry: string) => `
const { terminalManager, configureInProcessBackend } = require(${JSON.stringify(entry)});
(async () => {
${body(entry)}
})().catch((e) => { console.log(JSON.stringify({ error: String((e && e.message) || e) })); process.exit(0); });
`;

function body(_entry: string): string {
    return `
configureInProcessBackend({
    settings: { get: () => undefined },
    snapshots: {
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
        encrypting: () => false,
    },
});
const mgr = terminalManager();
let out = '';
mgr.on('data', (_id, d) => { out += d; });
const exited = new Promise((r) => mgr.on('exit', (_id, p) => r(p)));
await mgr.create({ id: 't', shell: ${JSON.stringify(shell)}, cols: 90, rows: 30 });
await new Promise((r) => setTimeout(r, 600));
mgr.write('t', ${JSON.stringify(feed)});
const res = await Promise.race([exited, new Promise((r) => setTimeout(() => r('TIMEOUT'), 20000))]);
console.log(JSON.stringify({ exit: res, ran: out.includes(${JSON.stringify(ORACLE)}) }));
process.exit(0);
`;
}

beforeAll(() => {
    fs.mkdirSync(scratch, { recursive: true });
    // Build the same output a consumer receives, into our own scratch dir.
    execFileSync(
        process.execPath,
        [
            path.join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js'),
            '--no-dts',
            '--out-dir',
            dist,
        ],
        { cwd: root, stdio: 'ignore' },
    );
}, 180_000);

afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
});

function run(file: string, src: string): { exit?: unknown; ran?: boolean; error?: string } {
    const p = path.join(scratch, file);
    fs.writeFileSync(p, src);
    let stdout: string;
    try {
        stdout = execFileSync(process.execPath, [p], {
            cwd: root,
            encoding: 'utf8',
            timeout: 60_000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (e) {
        // Surface the CHILD's stderr. Without this the failure reads only as
        // "Command failed", which is how the first draft of this file hid its
        // own unrelated resolution bug for two runs.
        const err = e as { stderr?: string; stdout?: string; message?: string };
        return { error: (err.stderr || err.stdout || err.message || '').slice(0, 400) };
    }
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
    return JSON.parse(line);
}

describe('the default engine resolves in BOTH built halves', () => {
    it('ESM: dist/index.js spawns a real shell that executes', () => {
        const r = run('drive.mjs', esmDriver(path.join(dist, 'index.js')));
        // The specific regression: a bare require() here threw
        // "Dynamic require of … is not supported" and nothing else noticed.
        expect(r.error, `ESM entry failed: ${r.error}`).toBeUndefined();
        expect(r.ran, 'the shell did not execute — the engine did not load').toBe(true);
        expect(r.exit).toEqual({ exitCode: 0 });
    }, 90_000);

    it('CJS: dist/index.cjs spawns a real shell that executes', () => {
        const r = run('drive.cjs', cjsDriver(path.join(dist, 'index.cjs')));
        expect(r.error, `CJS entry failed: ${r.error}`).toBeUndefined();
        expect(r.ran, 'the shell did not execute — the engine did not load').toBe(true);
        expect(r.exit).toEqual({ exitCode: 0 });
    }, 90_000);

    it('the built output REFERENCES the engine rather than dropping or inlining it', () => {
        // WHAT THIS DOES AND DOES NOT PROVE, stated because the first version
        // of this test claimed more than it could deliver.
        //
        // It proves the reference SURVIVES the build — so renaming the package,
        // deleting the load, or a bundler change that drops it goes red here
        // rather than at a consumer's first terminal.
        //
        // It does NOT prove "not bundled", because bundling is impossible by
        // construction: `manager.ts` loads the engine through
        // `createRequire(import.meta.url)`, a call on a local variable that
        // esbuild cannot follow. Measured by building with and without the
        // `external` entry — the output is the same in both. Sabotaging
        // `external` therefore does NOT make this test red, and I checked that
        // rather than assuming the opposite.
        //
        // The inlining assertion below is cheap insurance against a TWO-PART
        // regression, and only that. Measured, not assumed: converting the load
        // to a static `import` does not trip it either, because the `external`
        // entry in `tsup.config.ts` still keeps the module out of the bundle.
        // It needs BOTH — a static import AND `external` removed — to go red.
        //
        // That is a narrow guard rather than a strong one, and it is kept at
        // that honest weight because inlining is the failure that actually
        // matters: fancy-pty's `packageRoot()` would resolve to
        // fancy-term-host/dist, and every consumer would get "no helper
        // binaries are present" from a package that installed perfectly.
        //
        // The real protection in this file is the two live-shell tests above.
        // They are what caught the bug this file was written for.
        // Read every built JS file, not just `index.js`: tsup splits shared
        // code into `chunk-*.js`, so the engine reference lives in a chunk and
        // `index.js` only re-exports from it. Asserting on the entry alone
        // failed while the bundle was perfectly correct — a check pointed at
        // the wrong artifact.
        const built = fs
            .readdirSync(dist)
            .filter((f) => f.endsWith('.js') || f.endsWith('.cjs'))
            .map((f) => fs.readFileSync(path.join(dist, f), 'utf8'));
        expect(built.length).toBeGreaterThan(0);

        // ANY identifier before the paren, not literally `require`. The engine
        // is loaded through `createRequire(import.meta.url)`, so the bundle
        // emits a call on a LOCAL variable — `req("@particle-academy/fancy-pty")`
        // — which esbuild leaves untouched because it is not a recognised
        // require. A pattern hardcoding `require(` missed it and reported the
        // package as bundled when it was correctly external.
        //
        // The `[=(,]` anchor stays: it keeps the match in a statement position,
        // so a COMMENT mentioning a specifier does not count. `manager.ts` is
        // full of prose about fancy-pty, and an unanchored specifier search
        // here would match its own documentation.
        const referencesEngine =
            /[=(,]\s*(?:await\s+)?[\w$.]*\(\s*['"]@particle-academy\/fancy-pty['"]\s*\)/;
        expect(
            built.some((src) => referencesEngine.test(src)),
            'no built file references @particle-academy/fancy-pty — it was bundled or dropped',
        ).toBe(true);

        // A string only fancy-pty's OWN source contains. Present anywhere in
        // this package's output means its module was inlined rather than
        // referenced.
        for (const src of built) {
            expect(src).not.toContain('no helper binaries are present');
        }
    });
});
