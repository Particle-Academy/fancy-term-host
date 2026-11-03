import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { HostClient } from '../host-client';
import { isPidAlive, pidfileUsable, readPidfile, socketPathFor } from '../host-locate';
import { PROTOCOL_VERSION } from '../host-protocol';
import type { SnapshotStore } from '../sessions';

/**
 * The pty-host for real: the BUILT `dist/pty-host.js` in its own process, its real
 * socket, a real pty engine and real shells. Only `HostClient` is in this process.
 *
 * Every host here is `windowsHide` and NOT `detached`, so it has a hidden console
 * for its whole life and nothing can open a window. That means this file does not
 * measure a truly detached host. See the "Windows consoles" section of
 * `docs/packaging.md` for what that leaves unverified.
 *
 * Each host gets a private pipe (`fixtures/private-pipe.cjs`), because the default
 * Windows pipe is machine-wide and belongs to whatever app runs a real host here.
 * Only a host this file started is ever shut down or killed.
 *
 * CI is ubuntu-latest. The first describe runs there; the second is Windows only,
 * so CI SKIPS IT, and a change to the engine or its lookup has to be run on Windows
 * to mean anything.
 */

const root = path.resolve(__dirname, '..', '..');
/** Inside the repo so module resolution reaches node_modules. See default-engine.test.ts. */
const scratch = path.join(root, '.tmp-host-live');
const dist = path.join(scratch, 'dist');
const preload = path.join(__dirname, 'fixtures', 'private-pipe.cjs');
const marker = path.join(__dirname, 'fixtures', 'plant-marker.cjs');

const isWindows = process.platform === 'win32';
const shell = isWindows ? 'cmd.exe' : '/bin/sh';
const enter = isWindows ? '\r\n' : '\n';
/** The product never appears in the input, so finding it proves the SHELL RAN. */
const ORACLE = '7006652';
const compute = isWindows ? 'set /a 1234*5678' : 'expr 1234 \\* 5678';

const noSnapshots: SnapshotStore = {
    readSnapshot: () => null,
    writeSnapshot: () => 1,
    deleteSnapshot: () => undefined,
    encrypting: () => false,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | null | undefined | false, ms = 20_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(25);
    }
}

/**
 * The host's environment, with `NoDefaultCurrentDirectoryInExePath` gone.
 *
 * It is set in agent shells on the dev machine, and with it set the program-lookup
 * cases below pass on vulnerable code. `host-probe.json` proves it stayed gone.
 */
function hostEnv(extra: Record<string, string>, pathEntries?: string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        const lower = k.toLowerCase();
        if (lower === 'nodefaultcurrentdirectoryinexepath') continue;
        if (lower === 'node_options') continue;
        if (pathEntries && lower === 'path') continue;
        env[k] = v;
    }
    if (pathEntries) env.PATH = pathEntries.join(path.delimiter);
    return { ...env, ...extra };
}

interface Events {
    data: string;
    exit?: { exitCode: number; signal?: number };
    createError?: { message: string };
}

let hostCount = 0;
const running: Array<{ proc: ChildProcess; client: HostClient }> = [];

async function startHost(
    o: { hostExe?: string; cwd?: string; pathEntries?: string[] } = {},
): Promise<{ client: HostClient; proc: ChildProcess; userData: string; on: (id: string) => Events }> {
    const tag = `${process.pid}-${++hostCount}`;
    const userData = path.join(scratch, `host-${tag}`);
    fs.mkdirSync(userData, { recursive: true });
    const proc = spawn(o.hostExe ?? process.execPath, ['--require', preload, path.join(dist, 'pty-host.js')], {
        stdio: 'ignore',
        windowsHide: true,
        cwd: o.cwd ?? userData,
        env: hostEnv({ GENIE_USERDATA: userData, FTH_TEST_PIPE_TAG: tag }, o.pathEntries),
    });
    const pf = await until('the host to write its pidfile', () => {
        const p = readPidfile(userData);
        return pidfileUsable(p) ? p : null;
    });
    // Refuse to speak to anything but the pipe this host chose for itself.
    expect(pf!.pid).toBe(proc.pid);
    if (isWindows) expect(pf!.socketPath).not.toBe(socketPathFor(userData));
    const probe = JSON.parse(fs.readFileSync(path.join(userData, 'host-probe.json'), 'utf8'));
    expect(probe.ndcdInHost, 'the lookup variable reached the host').toBeNull();

    const client = await HostClient.connect(pf!.socketPath, noSnapshots, 5000, {
        requestTimeoutMs: 4000,
        heartbeatIntervalMs: 0,
    });
    running.push({ proc, client });
    return { client, proc, userData, on: watch(client) };
}

function watch(client: HostClient): (id: string) => Events {
    const byId = new Map<string, Events>();
    const of = (id: string) => {
        let e = byId.get(id);
        if (!e) byId.set(id, (e = { data: '' }));
        return e;
    };
    client.on('data', (id: string, d: string) => void (of(id).data += d));
    client.on('exit', (id: string, x: { exitCode: number; signal?: number }) => void (of(id).exit = x));
    client.on('create-error', (id: string, x: { message: string }) => void (of(id).createError = x));
    return of;
}

/** A program that reports itself and then stays up. */
const reporter = path.join(scratch, 'report.cjs');

beforeAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(
        reporter,
        [
            'console.log("pid " + process.pid);',
            'console.log("utf8 \\u2713\\u00e9");',
            'setInterval(() => {}, 1000);',
        ].join('\n'),
    );
    execFileSync(
        process.execPath,
        [path.join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js'), '--no-dts', '--out-dir', dist],
        { cwd: root, stdio: 'ignore', windowsHide: true },
    );
}, 180_000);

afterEach(async () => {
    for (const { proc, client } of running.splice(0)) {
        if (proc.exitCode === null) {
            await client.shutdownHost(2000).catch(() => {});
            await until('the host to exit', () => proc.exitCode !== null, 4000).catch(() => proc.kill());
        }
        client.disconnect();
    }
});

afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
});

describe('a real shell through the real host', () => {
    it('input, output and an exit code', async () => {
        const { client, on } = await startHost();
        client.create({ id: 'a', cwd: scratch, shell, cols: 90, rows: 30 });
        await until('the prompt', () => on('a').data.length > 0);
        client.write('a', `${compute}${enter}`);
        await until('the shell to run the sum', () => on('a').data.includes(ORACLE));
        client.write('a', `exit 7${enter}`);
        const exit = await until('the exit', () => on('a').exit);
        expect(exit.exitCode).toBe(7);
        expect(client.list()).toEqual([]);
    }, 60_000);

    it('input written in the same tick as the create is not lost', async () => {
        const { client, on } = await startHost();
        client.create({ id: 'a', cwd: scratch, shell, cols: 90, rows: 30 });
        client.write('a', `${compute}${enter}`);
        await until('the shell to run the sum', () => on('a').data.includes(ORACLE));
    }, 60_000);

    it('resize reaches the shell, and the first size is the one asked for', async () => {
        const { client, on } = await startHost();
        const ask = isWindows ? 'mode con' : 'stty size';
        const shows = (cols: number, rows: number) =>
            isWindows
                ? new RegExp(`Lines:\\s+${rows}\\s+Columns:\\s+${cols}`).test(on('a').data)
                : on('a').data.includes(`${rows} ${cols}`);
        client.create({ id: 'a', cwd: scratch, shell, cols: 90, rows: 30 });
        await until('the prompt', () => on('a').data.length > 0);
        client.write('a', `${ask}${enter}`);
        await until('the first size', () => shows(90, 30));

        client.resize('a', 110, 40);
        await sleep(200);
        client.write('a', `${ask}${enter}`);
        await until('the new size', () => shows(110, 40));
    }, 60_000);

    it('UTF-8 survives, and kill ends what is running', async () => {
        const { client, on } = await startHost();
        client.create({ id: 'a', cwd: scratch, shell: process.execPath, args: [reporter], cols: 90, rows: 30 });
        await until('the program', () => on('a').data.includes('utf8'));
        expect(on('a').data).toContain('utf8 \u2713\u00e9');
        const pid = Number(/pid (\d+)/.exec(on('a').data)![1]);
        expect(isPidAlive(pid), 'control: the program is running').toBe(true);

        client.kill('a');
        await until('the exit after a kill', () => on('a').exit);
        await until('the program to be gone', () => !isPidAlive(pid), 5000);
    }, 60_000);

    it('a program that cannot be found reaches the caller as an error, with no phantom', async () => {
        const { client, on } = await startHost();
        client.create({ id: 'a', cwd: scratch, shell: 'fth-no-such-program-anywhere' });
        const err = await until('the create error', () => on('a').createError);
        expect(err.message).toMatch(/fth-no-such-program-anywhere|not found|No such file/i);
        const exit = await until('the exit', () => on('a').exit);
        expect(exit.exitCode).not.toBe(0);
        // In the data as well, because that is all an app wired only to data and
        // exit can see, and a terminal that closes with no words is the bug.
        expect(on('a').data).toMatch(/fth-no-such-program-anywhere|not found|No such file/i);
        expect(client.list()).toEqual([]);
        expect(client.isLive('a')).toBe(false);
        expect(client.write('a', 'x')).toBe(false);

        // The id is free: the failure leaves nothing behind in the host either.
        const before = on('a').data.length;
        client.create({ id: 'a', cwd: scratch, shell, cols: 90, rows: 30 });
        await until('the second create to produce output', () => on('a').data.length > before);
        expect(client.isLive('a')).toBe(true);
    }, 60_000);

    it('a refused batch argument reaches the caller as an error, with no phantom', async () => {
        const { client, on } = await startHost();
        // Refused before anything is started, on every OS, so the file need not exist.
        client.create({ id: 'a', cwd: scratch, shell: 'fth-absent.cmd', args: ['one&two'] });
        const err = await until('the create error', () => on('a').createError);
        expect(err.message).toMatch(/batch|cmd/i);
        await until('the exit', () => on('a').exit);
        expect(on('a').data).toMatch(/batch|cmd/i);
        expect(client.list()).toEqual([]);
    }, 60_000);

    it('terminals outlive the client, and a new client replays and drives them', async () => {
        const { client, on, userData } = await startHost();
        client.create({ id: 'a', cwd: scratch, shell, cols: 90, rows: 30 });
        await until('the prompt', () => on('a').data.length > 0);
        client.write('a', `${compute}${enter}`);
        await until('the sum', () => on('a').data.includes(ORACLE));
        const hostPid = client.hostPid;
        await until('the real pid', () => client.list()[0]?.pid > 0);
        const ptyPid = client.list()[0].pid;
        client.disconnect();
        await sleep(200);

        const second = await HostClient.connect(readPidfile(userData)!.socketPath, noSnapshots, 5000, {
            requestTimeoutMs: 4000,
            heartbeatIntervalMs: 0,
        });
        running[running.length - 1].client = second;
        expect(second.hostPid).toBe(hostPid);
        expect(second.liveIds()).toEqual(['a']);
        expect(second.list()[0].pid).toBe(ptyPid);
        const seen = second.create({ id: 'a', cwd: scratch, shell });
        expect(seen.existing).toBe(true);
        expect(seen.scrollback).toContain(ORACLE);

        const on2 = watch(second);
        second.write('a', `exit 3${enter}`);
        expect((await until('the exit', () => on2('a').exit)).exitCode).toBe(3);
    }, 60_000);

    it('keeps exactly the last scrollbackMax code units on the host side', async () => {
        const { client, on, userData } = await startHost();
        const noisy = path.join(scratch, 'noisy.cjs');
        fs.writeFileSync(noisy, 'for (let i = 0; i < 3000; i++) console.log("line " + i);\nsetInterval(() => {}, 1000);\n');
        client.create({ id: 'a', cwd: scratch, shell: process.execPath, args: [noisy], cols: 90, rows: 30, scrollbackMax: 1000 });
        await until('the last line', () => on('a').data.includes('line 2999'));
        const whole = on('a').data;
        client.disconnect();
        const second = await HostClient.connect(readPidfile(userData)!.socketPath, noSnapshots, 5000, {
            requestTimeoutMs: 4000,
            heartbeatIntervalMs: 0,
        });
        running[running.length - 1].client = second;
        const kept = second.getScrollback('a')!;
        expect(kept.length).toBe(1000);
        expect(whole.endsWith(kept)).toBe(true);
    }, 60_000);

    it('a shutdown leaves no pty or host behind', async () => {
        const { client, proc, on } = await startHost();
        client.create({ id: 'a', cwd: scratch, shell: process.execPath, args: [reporter], cols: 90, rows: 30 });
        await until('the program', () => /pid (\d+)/.test(on('a').data));
        const pid = Number(/pid (\d+)/.exec(on('a').data)![1]);
        await until('the pty pid', () => client.list()[0]?.pid > 0);
        const ptyPid = client.list()[0].pid;
        expect(isPidAlive(pid), 'control: the program is running').toBe(true);
        expect(isPidAlive(ptyPid), 'control: the pty process is running').toBe(true);

        await client.shutdownHost(3000);
        await until('the host to exit', () => proc.exitCode !== null, 5000);
        await until('the program to be gone', () => !isPidAlive(pid), 5000);
        await until('the pty process to be gone', () => !isPidAlive(ptyPid), 5000);
    }, 60_000);

    it('runs on fancy-pty, says so, and keeps the protocol version', async () => {
        const { client } = await startHost();
        expect(client.hostEngine()).toBe('fancy-pty');
        expect(PROTOCOL_VERSION).toBe(2);
    }, 60_000);

    it('the built host imports fancy-pty and not node-pty', () => {
        for (const file of ['pty-host.js', 'pty-host.cjs']) {
            const src = fs.readFileSync(path.join(dist, file), 'utf8');
            // Statements only: comments in the bundle are allowed to mention it.
            expect(src, file).not.toMatch(/^\s*(?:import\b.*from\s*|.*\brequire\(\s*)['"]node-pty['"]/m);
            expect(src, file).toMatch(/^\s*(?:import\b.*from\s*|.*\brequire\(\s*)['"]@particle-academy\/fancy-pty['"]/m);
            // A string only fancy-pty's OWN source has. Inlined, its helper lookup
            // would resolve against this package's dist and find nothing.
            expect(src, file).not.toContain('no helper binaries are present');
        }
    });
});

/**
 * Which program a name starts. A plant is a copy of node.exe under another name,
 * with `plant-marker.cjs` preloaded through the pty's own NODE_OPTIONS, so it writes
 * down its real image and exits before it would act on any argument. Each case
 * opens with a control that runs the plant by absolute path through the same host,
 * which proves the instrument can see one.
 */
describe.runIf(isWindows)('which program a name starts through the host', () => {
    const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const win = process.env.SystemRoot ?? 'C:\\Windows';
    let caseCount = 0;

    function makeCase() {
        const dir = path.join(scratch, `case-${++caseCount}`);
        const markers = path.join(dir, 'markers');
        fs.mkdirSync(markers, { recursive: true });
        const ptyEnv = {
            FTH_MARKER_DIR: markers,
            NODE_OPTIONS: `--require "${marker.split(path.sep).join('/')}"`,
        };
        const plant = (rel: string) => {
            const p = path.join(dir, rel);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.copyFileSync(process.execPath, p);
            return p;
        };
        const readMarkers = (): Array<{ execPath: string; ndcdInChild: string | null }> =>
            fs.readdirSync(markers).flatMap((f) => {
                try {
                    return [JSON.parse(fs.readFileSync(path.join(markers, f), 'utf8'))];
                } catch {
                    return []; // Still being written.
                }
            });
        const clear = () => {
            for (const f of fs.readdirSync(markers)) fs.rmSync(path.join(markers, f));
        };
        return { dir, ptyEnv, plant, readMarkers, clear };
    }

    /** A plant started by absolute path has to be seen, or the rest proves nothing. */
    async function control(
        h: Awaited<ReturnType<typeof startHost>>,
        c: ReturnType<typeof makeCase>,
        planted: string,
    ) {
        h.client.create({ id: 'control', cwd: c.dir, shell: planted, env: c.ptyEnv });
        // A freshly copied image can take seconds to start here.
        const m = await until('the control plant to report', () => c.readMarkers()[0], 30_000);
        expect(m.execPath.toLowerCase()).toBe(planted.toLowerCase());
        expect(m.ndcdInChild, 'the lookup variable reached the child').toBeNull();
        await until('the control to exit', () => h.on('control').exit, 30_000);
        c.clear();
    }

    /** Create by name, wait for the end of it, and report whether a plant ran. */
    async function subject(
        h: Awaited<ReturnType<typeof startHost>>,
        c: ReturnType<typeof makeCase>,
        name: string,
        args: string[] = [],
    ) {
        h.client.create({ id: 'subject', cwd: c.dir, shell: name, args, env: c.ptyEnv });
        await until('the subject to end', () => h.on('subject').exit ?? c.readMarkers()[0], 30_000);
        // A plant reports before it exits, and an exit is only final once the
        // output racing it across the socket has landed.
        await sleep(500);
        return { markers: c.readMarkers(), ...h.on('subject') };
    }

    it('an extensionless name on PATH does not run <name>.exe from the host folder', async () => {
        const c = makeCase();
        const planted = c.plant('hostcwd/fthshim.exe');
        // The literal is an empty file and nothing ever starts it: what a package
        // manager writes on PATH, and what used to satisfy node-pty's pre-check.
        fs.mkdirSync(path.join(c.dir, 'pathdir'), { recursive: true });
        fs.writeFileSync(path.join(c.dir, 'pathdir', 'fthshim'), '');
        const h = await startHost({
            cwd: path.join(c.dir, 'hostcwd'),
            pathEntries: [path.join(c.dir, 'pathdir'), sys, win],
        });
        await control(h, c, planted);

        const s = await subject(h, c, 'fthshim');
        expect(s.markers, 'the plant in the host folder ran').toEqual([]);
        expect(s.createError?.message).toMatch(/fthshim/);
        expect(h.client.list().map((t) => t.id)).not.toContain('subject');
    }, 120_000);

    it('asking for it by .\\name still runs it, which is what a consumer must change to', async () => {
        const c = makeCase();
        const planted = c.plant('hostcwd/fthdot.exe');
        const h = await startHost({ cwd: path.join(c.dir, 'hostcwd'), pathEntries: [sys, win] });
        await control(h, c, planted);

        const s = await subject(h, c, '.\\fthdot.exe');
        expect(s.markers.map((m) => m.execPath.toLowerCase())).toEqual([planted.toLowerCase()]);
    }, 120_000);

    it('a relative PATH entry is not searched', async () => {
        const c = makeCase();
        const planted = c.plant('hostcwd/rel/fthprobe.exe');
        const h = await startHost({ cwd: path.join(c.dir, 'hostcwd'), pathEntries: ['rel', sys, win] });
        await control(h, c, planted);

        const s = await subject(h, c, 'fthprobe.exe');
        expect(s.markers, 'the plant on a relative PATH entry ran').toEqual([]);
        expect(s.createError?.message).toMatch(/fthprobe/);
    }, 120_000);

    it('a bare cmd.exe is the system one, not a file beside the host executable', async () => {
        const c = makeCase();
        const hostExe = c.plant('appdir/node.exe');
        const planted = c.plant('appdir/cmd.exe');
        // Its cwd is somewhere else, so only the executable's own folder is in play.
        const cwd = path.join(c.dir, 'hostcwd');
        fs.mkdirSync(cwd, { recursive: true });
        const h = await startHost({ hostExe, cwd, pathEntries: [sys, win] });
        await control(h, c, planted);

        const s = await subject(h, c, 'cmd.exe', ['/d', '/c', 'echo', 'FTH-REAL-CMD']);
        expect(s.markers, 'the plant beside the host executable ran').toEqual([]);
        expect(s.data).toContain('FTH-REAL-CMD');
        expect(s.exit?.exitCode).toBe(0);
    }, 180_000);

    it('a refused batch argument starts nothing; the same file runs with a plain one', async () => {
        const dir = path.join(scratch, 'batch');
        fs.mkdirSync(dir, { recursive: true });
        const script = path.join(dir, 'run.cmd');
        const ran = path.join(dir, 'ran.txt');
        const injected = path.join(dir, 'injected.txt');
        fs.writeFileSync(script, `@echo %1>"${ran}"\r\n`);
        const h = await startHost();

        h.client.create({ id: 'plain', cwd: dir, shell: script, args: ['plain'] });
        await until('the control script to run', () => h.on('plain').exit);
        expect(fs.readFileSync(ran, 'utf8').trim()).toBe('plain');
        fs.rmSync(ran);

        h.client.create({ id: 'bad', cwd: dir, shell: script, args: [`a&echo x>"${injected}"`] });
        const err = await until('the refusal', () => h.on('bad').createError);
        expect(err.message).toMatch(/batch|cmd/i);
        await until('the exit', () => h.on('bad').exit);
        await sleep(500);
        expect(fs.existsSync(ran)).toBe(false);
        expect(fs.existsSync(injected)).toBe(false);
        expect(h.client.list()).toEqual([]);
    }, 60_000);
});
