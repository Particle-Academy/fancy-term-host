import { describe, expect, it } from 'vitest';

import {
    createFancyPtySpawn,
    type FancyPty,
    type FancyPtyOpenOptions,
} from '../fancy-pty';

/**
 * The fancy-pty adapter, tested with NO fancy-pty installed.
 *
 * That is the point of injecting `open`: the adapter's logic is the part that
 * can be wrong, and it is covered here rather than after a publish. These tests
 * need no native module, no pty and no platform.
 */

/** A fake fancy-pty whose data/exit/error can be driven from the test. */
function fakePty() {
    let data: ((c: Buffer) => void) | undefined;
    let exit: ((code: number) => void) | undefined;
    let error: ((e: Error) => void) | undefined;
    const written: string[] = [];
    const resizes: [number, number][] = [];
    let killed = 0;
    let opened: FancyPtyOpenOptions | undefined;

    const pty: FancyPty = {
        pid: 4321,
        write(d) {
            written.push(typeof d === 'string' ? d : d.toString('utf8'));
            return true;
        },
        resize(cols, rows) {
            resizes.push([cols, rows]);
            return true;
        },
        kill() {
            killed++;
            return true;
        },
        onData(fn) {
            data = fn;
        },
        onExit(fn) {
            exit = fn;
        },
        onError(fn) {
            error = fn;
        },
    };

    const open = (options: FancyPtyOpenOptions) => {
        opened = options;
        return pty;
    };

    return {
        open,
        emitData: (b: Buffer) => data?.(b),
        emitExit: (code: number) => exit?.(code),
        emitError: (e: Error) => error?.(e),
        written,
        resizes,
        get killed() {
            return killed;
        },
        get opened() {
            return opened;
        },
    };
}

describe('spawn mapping', () => {
    it('composes argv from node-pty style (file, args)', () => {
        const f = fakePty();
        createFancyPtySpawn(f.open)('C:\\Windows\\system32\\cmd.exe', ['/k', 'echo hi'], {
            cwd: 'C:\\tmp',
            cols: 120,
            rows: 30,
            env: { TERM: 'xterm-256color' },
        });

        expect(f.opened?.argv).toEqual(['C:\\Windows\\system32\\cmd.exe', '/k', 'echo hi']);
        expect(f.opened?.cwd).toBe('C:\\tmp');
        expect(f.opened?.cols).toBe(120);
        expect(f.opened?.rows).toBe(30);
        expect(f.opened?.env?.TERM).toBe('xterm-256color');
    });

    it('defaults the size the way node-pty does', () => {
        const f = fakePty();
        createFancyPtySpawn(f.open)('sh', [], {});
        expect(f.opened?.cols).toBe(80);
        expect(f.opened?.rows).toBe(24);
    });

    it('IGNORES `name` rather than letting it override env.TERM', () => {
        // node-pty's `name` option WINS over `env.TERM`
        // (`name = opt.name || env.TERM; env.TERM = name`), and a hardcoded
        // `name: 'xterm-color'` once silently replaced a caller's TERM with a
        // deprecated terminfo that lacks the `Ms` capability — so OSC 52
        // clipboard copy never fired in any TUI. fancy-pty has no such option,
        // and this asserts the adapter does not reintroduce it by helpfully
        // mapping `name` onto TERM.
        const f = fakePty();
        createFancyPtySpawn(f.open)('sh', [], {
            name: 'xterm-color',
            env: { TERM: 'xterm-256color' },
        });
        expect(f.opened?.env?.TERM).toBe('xterm-256color');
    });

    it('passes write, resize and kill straight through', () => {
        const f = fakePty();
        const pty = createFancyPtySpawn(f.open)('sh', [], {});
        pty.write('ls -la\r');
        pty.resize(100, 40);
        pty.kill();
        expect(f.written).toEqual(['ls -la\r']);
        expect(f.resizes).toEqual([[100, 40]]);
        expect(f.killed).toBe(1);
    });

    it('reports the pid, and -1 rather than undefined before one exists', () => {
        const f = fakePty();
        expect(createFancyPtySpawn(f.open)('sh', [], {}).pid).toBe(4321);

        const noPid = createFancyPtySpawn(() => ({ ...(fakePty().open({ argv: ['sh'] })), pid: undefined }))(
            'sh',
            [],
            {},
        );
        expect(noPid.pid).toBe(-1);
    });
});

describe('UTF-8 decoding across chunk boundaries', () => {
    it('does NOT corrupt a multi-byte character split between chunks', () => {
        // THE DEFECT THIS ADAPTER EXISTS TO AVOID. node-pty hands out strings;
        // fancy-pty hands out Buffers. A per-chunk `buf.toString('utf8')`
        // emits U+FFFD for the half-sequence and loses the character — so a
        // box-drawing TUI or any non-ASCII output corrupts intermittently,
        // under load, looking like a font or terminal bug rather than a decode
        // bug. A naive implementation passes every ASCII test ever written.
        const f = fakePty();
        const pty = createFancyPtySpawn(f.open)('sh', [], {});
        const out: string[] = [];
        pty.onData((d) => out.push(d));

        const full = Buffer.from('┌─┐ héllo', 'utf8');
        // Split at every single byte: the worst case a pipe can produce.
        for (const byte of full) {
            f.emitData(Buffer.from([byte]));
        }

        expect(out.join('')).toBe('┌─┐ héllo');
        expect(out.join('')).not.toContain('\ufffd');
    });

    it('emits nothing for a chunk that is only half a character', () => {
        const f = fakePty();
        const pty = createFancyPtySpawn(f.open)('sh', [], {});
        const out: string[] = [];
        pty.onData((d) => out.push(d));

        const e = Buffer.from('é', 'utf8'); // two bytes
        f.emitData(e.subarray(0, 1));
        expect(out).toEqual([]); // not '', and certainly not U+FFFD
        f.emitData(e.subarray(1));
        expect(out).toEqual(['é']);
    });

    it('flushes a trailing partial sequence BEFORE announcing the exit', () => {
        // The exit handler upstream tears down the scrollback, so anything the
        // decoder still holds at exit is lost unless it is flushed first. A
        // shell whose last output ends mid-sequence would drop its final
        // character — rare, and permanent when it happens.
        const f = fakePty();
        const pty = createFancyPtySpawn(f.open)('sh', [], {});
        const events: string[] = [];
        pty.onData((d) => events.push(`data:${d}`));
        pty.onExit((e) => events.push(`exit:${e.exitCode}`));

        f.emitData(Buffer.from('ok ', 'utf8'));
        f.emitData(Buffer.from([0xc3])); // first byte of 'é', deliberately orphaned
        f.emitExit(0);

        expect(events[0]).toBe('data:ok ');
        // The orphan is flushed as a replacement char — lossy, but it is
        // DELIVERED and it is ordered before the exit, which is the contract.
        expect(events[1]).toMatch(/^data:/);
        expect(events[2]).toBe('exit:0');
    });

    it('still announces the exit when a data listener throws on that final flush', () => {
        // The flush runs data listeners INSIDE the exit callback. Before
        // 0.11.1 a throw there skipped every exit listener, so the backend
        // never unlisted the pty and never emitted `exit` -- a lost exit with
        // the process long gone. The throw itself must still surface.
        const f = fakePty();
        const pty = createFancyPtySpawn(f.open)('sh', [], {});
        const exits: number[] = [];
        pty.onData(() => {
            throw new Error('listener fault');
        });
        pty.onExit((e) => exits.push(e.exitCode));

        f.emitData(Buffer.from([0xc3])); // orphaned lead byte: the exit must flush it
        let err: unknown;
        try {
            f.emitExit(0);
        } catch (e) {
            err = e;
        }

        expect(exits).toEqual([0]);
        expect(String(err)).toContain('listener fault');
    });
});

describe('exit shape', () => {
    it('maps a clean exit', () => {
        const f = fakePty();
        const pty = createFancyPtySpawn(f.open)('sh', [], {});
        let seen: { exitCode: number; signal?: number } | undefined;
        pty.onExit((e) => (seen = e));
        f.emitExit(0);
        expect(seen).toEqual({ exitCode: 0, signal: undefined });
    });

    it('decomposes 128+signal into a signal, which node-pty consumers expect', () => {
        // fancy-pty reports one number with the shell convention; node-pty
        // reports { exitCode, signal }. `InProcessBackend` and its tests read
        // `signal`, so dropping it would make a killed terminal
        // indistinguishable from one that exited 137 on purpose.
        const f = fakePty();
        const pty = createFancyPtySpawn(f.open)('sh', [], {});
        let seen: { exitCode: number; signal?: number } | undefined;
        pty.onExit((e) => (seen = e));
        f.emitExit(137); // 128 + SIGKILL(9)
        expect(seen).toEqual({ exitCode: 137, signal: 9 });
    });

    it('does not invent a signal for an ordinary non-zero exit', () => {
        const f = fakePty();
        const pty = createFancyPtySpawn(f.open)('sh', [], {});
        let seen: { exitCode: number; signal?: number } | undefined;
        pty.onExit((e) => (seen = e));
        f.emitExit(1);
        expect(seen).toEqual({ exitCode: 1, signal: undefined });
        f.emitExit(127); // "command not found" — a real code, not a signal
        expect(seen).toEqual({ exitCode: 127, signal: undefined });
    });
});

describe('errors reach the user', () => {
    it('surfaces a fault as terminal output rather than swallowing it', () => {
        // fancy-pty reports faults node-pty had no channel for at all: a spawn
        // that failed, a helper that died without reporting. A terminal that
        // closes with no explanation is the failure this package keeps paying
        // for, so it lands where the user is already looking.
        const f = fakePty();
        const pty = createFancyPtySpawn(f.open)('sh', [], {});
        const out: string[] = [];
        pty.onData((d) => out.push(d));
        f.emitError(new Error('cannot start "npm" (CreateProcessW GetLastError=2)'));
        expect(out.join('')).toContain('[fancy-pty]');
        expect(out.join('')).toContain('CreateProcessW');
    });
});
