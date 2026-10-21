import { beforeEach, describe, expect, it } from 'vitest';

/**
 * An exit must ALWAYS reach the backend's `exit` event and ALWAYS clear the
 * pty from `list()`, and an exit from a pty that is no longer the registered
 * one must never touch the pty that replaced it.
 *
 * The symptom these pin is Genie's Windows leak check (beta.34): "cycle 74: the
 * pty never reported its exit" and "the host counts ZERO live terminals
 * afterwards -- count=1", with every helper process gone. A pty that the engine
 * has finished with, but which the backend still lists and never announces, is
 * exactly what a throw inside the exit path produces: the bookkeeping and the
 * `exit` emit sat AFTER a synchronous `cwd` emit, so any `cwd` listener that
 * threw (Genie persists it to its DB) skipped both. fancy-pty catches a
 * throwing exit listener and turns it into a process warning, so nothing
 * crashed and nothing said so either.
 */

interface FakePty {
    pid: number;
    process: string;
    killed: boolean;
    onData: (cb: (d: string) => void) => void;
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
    write: (d: string) => void;
    resize: (c: number, r: number) => void;
    kill: () => void;
    /** Test helpers: drive the engine's callbacks by hand. */
    emitData: (d: string) => void;
    emitExit: (code: number) => void;
}

const spawned: FakePty[] = [];
let nextPid = 5000;

/** A pty whose exit arrives only when the test says so -- kill() does NOT exit it. */
function makeFakePty(): FakePty {
    let data: ((d: string) => void) | null = null;
    let exit: ((e: { exitCode: number; signal?: number }) => void) | null = null;
    return {
        pid: nextPid++,
        process: 'fake-shell',
        killed: false,
        onData(cb) {
            data = cb;
        },
        onExit(cb) {
            exit = cb;
        },
        write() {},
        resize() {},
        kill() {
            this.killed = true;
        },
        emitData(d) {
            data?.(d);
        },
        emitExit(code) {
            exit?.({ exitCode: code });
        },
    };
}

import { configureInProcessBackend, inProcessBackend } from '../manager';

configureInProcessBackend({
    ptySpawn: () => {
        const p = makeFakePty();
        spawned.push(p);
        return p;
    },
    settings: { get: (k) => (k === 'track_cwd' ? 'off' : undefined) },
    snapshots: {
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
        encrypting: () => false,
    },
});

const m = inProcessBackend();
const exits: Array<{ id: string; exitCode: number }> = [];
m.on('exit', (id: string, p: { exitCode: number }) => exits.push({ id, exitCode: p.exitCode }));

/** Run `fn`, returning what it threw (or undefined). */
function thrown(fn: () => void): unknown {
    try {
        fn();
        return undefined;
    } catch (e) {
        return e;
    }
}

beforeEach(() => {
    // Drop a previous test's throwing listener FIRST, so cleanup cannot fail.
    m.removeAllListeners('cwd');
    for (const p of spawned) p.emitExit(0);
    m.killAll();
    spawned.length = 0;
    exits.length = 0;
});

describe('an exit survives a throwing listener', () => {
    it('a cwd listener that throws at exit still leaves the pty unlisted and announced', () => {
        m.create({ id: 'cwd-throws', cwd: '/tmp', shell: '/bin/fake', args: [] });
        // An OSC-7 report: the backend now holds a live cwd, which it flushes
        // synchronously as a `cwd` event when the pty exits.
        spawned[0].emitData('\x1b]7;file:///home/user/proj\x07');
        m.on('cwd', () => {
            throw new Error('persisting the cwd failed');
        });

        const err = thrown(() => spawned[0].emitExit(0));

        // The listener's fault is not swallowed -- it still reaches the engine,
        // which reports it -- but it no longer costs the exit.
        expect(String(err)).toContain('persisting the cwd failed');
        expect(exits).toEqual([{ id: 'cwd-throws', exitCode: 0 }]);
        expect(m.list()).toEqual([]);
        expect(m.isLive('cwd-throws')).toBe(false);
        expect(m.getScrollback('cwd-throws')).toBeUndefined();
    });

    it('a cwd listener that throws during kill() still clears the pty', () => {
        m.create({ id: 'kill-cwd-throws', cwd: '/tmp', shell: '/bin/fake', args: [] });
        spawned[0].emitData('\x1b]7;file:///home/user/proj\x07');
        m.on('cwd', () => {
            throw new Error('persisting the cwd failed');
        });

        thrown(() => m.kill('kill-cwd-throws'));

        expect(spawned[0].killed).toBe(true);
        expect(m.list()).toEqual([]);
    });
});

describe('a late exit from a replaced pty (the reused-id race)', () => {
    it('does not unlist, or announce an exit for, the pty that replaced it', () => {
        m.create({ id: 'reused', cwd: '/tmp', shell: '/bin/fake', args: [] });
        const old = spawned[0];
        m.kill('reused');
        m.create({ id: 'reused', cwd: '/tmp', shell: '/bin/fake', args: [] });
        const fresh = spawned[1];
        fresh.emitData('fresh output');

        // The killed pty's exit arrives only now, after the id was reused.
        old.emitExit(1);

        expect(m.list().map((t) => t.pid)).toEqual([fresh.pid]);
        expect(m.getScrollback('reused')).toBe('fresh output');
        expect(exits).toEqual([]);

        // And the replacement's own exit is still delivered normally.
        fresh.emitExit(0);
        expect(exits).toEqual([{ id: 'reused', exitCode: 0 }]);
        expect(m.list()).toEqual([]);
    });

    it('a killed pty that was NOT replaced still announces its exit', () => {
        // What a consumer that kills and then waits for `exit` relies on.
        m.create({ id: 'killed', cwd: '/tmp', shell: '/bin/fake', args: [] });
        m.kill('killed');
        spawned[0].emitExit(1);
        expect(exits).toEqual([{ id: 'killed', exitCode: 1 }]);
        expect(m.list()).toEqual([]);
    });
});
