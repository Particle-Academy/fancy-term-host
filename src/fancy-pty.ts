/**
 * The `fancy-pty` backend: an `IPty`-shaped adapter over fancy-pty's six calls.
 *
 * WHY AN ADAPTER RATHER THAN A REWRITE. `InProcessBackend` in `manager.ts`
 * consumes a narrow slice of node-pty's `IPty` — `pid`, `process`, `onData`,
 * `onExit`, `write`, `resize`, `kill`. Everything above it (T1/T2/T3
 * persistence, the scrollback, OSC 7 cwd tracking, the registry) is engine-
 * agnostic and has no business changing to swap a PTY layer. So the engine is
 * replaced at the one seam where the two disagree, and the 300-odd lines of
 * terminal behaviour above it are untouched and keep their tests.
 *
 * WHY `open` IS INJECTED rather than imported here. It matches the four
 * injected ports this package already uses, and it means the adapter compiles,
 * typechecks and is FULLY TESTED without `@particle-academy/fancy-pty` being
 * installed — which matters because its npm name does not exist yet. The real
 * wiring is one import at the call site; the logic in this file is the part
 * that can be wrong, and it is covered now rather than after a publish.
 *
 * WHY fancy-pty AT ALL — Renaissance-Analytics/genie#805, reproduced from clean
 * by `claude · tynn` on a Windows 11 VM against this package at 0.9.0:
 * node-pty retains **1.067 threads, 18.27 handles and 13.303 MB per EXITED
 * pty**, at 3.3 s per spawn. 120 cycles exhausted a machine in six minutes.
 * fancy-pty puts each pty in its own process, so an exited terminal cannot
 * retain anything in this one — a property of the shape, not a promise about
 * the code.
 */

import { StringDecoder } from 'node:string_decoder';

/** fancy-pty's surface, declared structurally so this file imports nothing from it. */
export interface FancyPty {
    readonly pid: number | undefined;
    write(data: string | Buffer): boolean;
    resize(cols: number, rows: number): boolean;
    kill(): boolean;
    onData(listener: (chunk: Buffer) => void): void;
    onExit(listener: (code: number) => void): void;
    onError(listener: (error: Error) => void): void;
}

export interface FancyPtyOpenOptions {
    argv: string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    cols?: number;
    rows?: number;
}

export type FancyPtyOpen = (options: FancyPtyOpenOptions) => FancyPty;

/** The slice of node-pty's `IPty` that `InProcessBackend` actually uses. */
export interface AdaptedPty {
    readonly pid: number;
    readonly process: string;
    onData(listener: (data: string) => void): void;
    onExit(listener: (e: { exitCode: number; signal?: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
}

export interface AdaptedSpawnOptions {
    name?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
}

/**
 * Build a `spawn(file, args, opts)` compatible with node-pty's, backed by
 * fancy-pty.
 *
 * Three differences between the engines are reconciled here, and each one is a
 * real defect if it is not:
 *
 * 1. **node-pty yields STRINGS; fancy-pty yields BUFFERS.** A per-chunk
 *    `buf.toString('utf8')` splits multi-byte sequences at chunk boundaries and
 *    emits replacement characters — so a box-drawing TUI or any non-ASCII
 *    output corrupts under load, intermittently, in a way that reads as a font
 *    or terminal bug rather than a decode bug. A `StringDecoder` per pty carries
 *    the partial sequence across chunks, which is what node-pty does internally.
 *
 * 2. **`spawn(file, args)` versus `argv`.** fancy-pty takes one list, which is
 *    also where Windows command-line quoting is owned — the caller never has to
 *    know those rules.
 *
 * 3. **Exit shape.** node-pty reports `{ exitCode, signal }`; fancy-pty reports
 *    one number, with the shell convention that a signalled child is
 *    `128 + signal`. Decomposed here so `InProcessBackend`'s existing exit
 *    handling and its tests are unchanged.
 *
 * Two node-pty options have no counterpart and are deliberately DROPPED:
 *
 * - **`useConptyDll: true`** — that flag existed to get node-pty's bundled
 *   modern ConPTY instead of the legacy in-box path, because the legacy path
 *   allocated a visible console under a windowless detached host and its kill
 *   path forked an un-hidden agent that flashed a console and crashed with
 *   "AttachConsole failed" (issue #4). fancy-pty uses the in-box pseudoconsole
 *   API directly and ships no agent process at all, so there is no second
 *   executable to pop a window, to crash, or to orphan. The workaround is not
 *   ported because the failure it worked around cannot occur.
 *
 * - **`name`** — node-pty's `name` option WINS over `env.TERM`
 *   (`name = opt.name || env.TERM; env.TERM = name`), which once silently
 *   overrode a caller's TERM with a deprecated terminfo lacking the `Ms`
 *   capability, so OSC 52 clipboard copy never fired. fancy-pty has no such
 *   option: `env.TERM` is simply respected. The trap becomes unexpressible,
 *   so `name` is accepted and ignored rather than being quietly honoured.
 */
export function createFancyPtySpawn(open: FancyPtyOpen) {
    return function spawn(file: string, args: string[], opts: AdaptedSpawnOptions): AdaptedPty {
        const pty = open({
            argv: [file, ...args],
            cwd: opts.cwd,
            env: opts.env,
            cols: opts.cols ?? 80,
            rows: opts.rows ?? 24,
        });

        // One decoder per pty, for difference (1) above.
        const decoder = new StringDecoder('utf8');
        const dataListeners: ((data: string) => void)[] = [];
        const exitListeners: ((e: { exitCode: number; signal?: number }) => void)[] = [];

        pty.onData((chunk) => {
            const text = decoder.write(chunk);
            // A chunk that is entirely the first half of a multi-byte sequence
            // decodes to nothing. Emitting '' would be harmless here but makes
            // scrollback accounting and test assertions noisier for no reason.
            if (text.length === 0) return;
            for (const fn of dataListeners) fn(text);
        });

        pty.onExit((code) => {
            // Flush whatever the decoder still holds BEFORE announcing the
            // exit: a shell whose final output ends mid-sequence would
            // otherwise lose its last character, and the exit handler upstream
            // tears the scrollback down.
            const tail = decoder.end();
            if (tail.length > 0) {
                for (const fn of dataListeners) fn(tail);
            }
            // The shell convention fancy-pty reports with: 128 + signal.
            const signal = code > 128 && code < 160 ? code - 128 : undefined;
            for (const fn of exitListeners) fn({ exitCode: code, signal });
        });

        // fancy-pty reports faults node-pty had no channel for — a spawn that
        // failed, a helper that died without reporting. Surfaced as output
        // rather than swallowed, because a terminal that closes with no
        // explanation is the failure this package keeps paying for. It reaches
        // the user in the one place they are already looking.
        pty.onError((err) => {
            for (const fn of dataListeners) fn(`\r\n[fancy-pty] ${err.message}\r\n`);
        });

        return {
            // node-pty's `pid` is a number; fancy-pty's is `number | undefined`
            // until the child process exists. -1 rather than a throw: the pid
            // is reported upward for diagnostics, and a spawn failure already
            // arrives through onError/onExit with a real message.
            get pid() {
                return pty.pid ?? -1;
            },
            // node-pty's `IPty.process` is the shell name. `InProcessBackend`
            // only reads it as a fallback for its own `shells` map, which it
            // sets on every spawn — so `file` is both correct and all it needs.
            get process() {
                return file;
            },
            onData(listener) {
                dataListeners.push(listener);
            },
            onExit(listener) {
                exitListeners.push(listener);
            },
            write(data) {
                pty.write(data);
            },
            resize(cols, rows) {
                pty.resize(cols, rows);
            },
            kill() {
                pty.kill();
            },
        };
    };
}
