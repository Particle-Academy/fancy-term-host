import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `windowsVerbatimArguments` end to end: the built package, a real `cmd.exe`, and
 * for the detached backend a real pty-host process reached over its real socket.
 *
 * The oracle is a file the PROGRAM writes with its own `process.argv`, not pty
 * text, which ConPTY re-renders. So "it ran" and "it got these arguments" are each
 * reported by the thing that would know.
 *
 * Windows only, because the failure is. CI is ubuntu-latest, so CI SKIPS THIS
 * FILE, and a change here has to be run on a Windows machine to mean anything.
 * `verbatim.test.ts` and `verbatim-host.test.ts` are what CI sees.
 *
 * Every process here is `windowsHide`: nothing may open a window on the desktop.
 */

const root = path.resolve(__dirname, '..', '..');
/** Inside the repo so module resolution reaches node_modules. See default-engine.test.ts. */
const scratch = path.join(root, '.tmp-verbatim-live');
const dist = path.join(scratch, 'dist');
const drive = path.join(__dirname, 'fixtures', 'verbatim-drive.mjs');
const reporter = path.join(scratch, 'report.cjs');
const noSpaceCmd = path.join(scratch, 'nospace', 'argv.cmd');
const spacedCmd = path.join(scratch, 'dir with space', 'argv.cmd');

const COMSPEC = process.env.COMSPEC ?? 'cmd.exe';
let n = 0;

interface Outcome {
    exit?: { exitCode: number; signal?: number } | 'TIMEOUT';
    output?: string;
    error?: string;
    hostBacked?: boolean;
    /** What the program said its argv was. Null if it never ran. */
    argv: string[] | null;
}

function run(
    backend: 'in-process' | 'host',
    shell: string,
    args: string[],
    windowsVerbatimArguments?: boolean,
): Outcome {
    const id = ++n;
    const report = path.join(scratch, `report-${id}.json`);
    const specPath = path.join(scratch, `spec-${id}.json`);
    fs.writeFileSync(
        specPath,
        JSON.stringify({
            dist,
            backend,
            userData: path.join(scratch, `host-${id}`),
            create: {
                id: `t${id}`,
                cwd: scratch,
                shell,
                args,
                cols: 400,
                rows: 30,
                env: { VERBATIM_REPORT: report },
                ...(windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments }),
            },
        }),
    );
    fs.mkdirSync(path.join(scratch, `host-${id}`), { recursive: true });
    const stdout = execFileSync(process.execPath, [drive, specPath], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const outcome = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '{}');
    return {
        ...outcome,
        argv: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null,
    };
}

/** The wrap every line needs through `cmd /s`, which strips the first and last quote. */
const viaCmd = (line: string) => ['/d', '/s', '/c', `"${line}"`];

describe.runIf(process.platform === 'win32')('a shell line through cmd.exe, for real', () => {
    beforeAll(() => {
        fs.rmSync(scratch, { recursive: true, force: true });
        fs.mkdirSync(path.join(scratch, 'nospace'), { recursive: true });
        fs.mkdirSync(path.join(scratch, 'dir with space'), { recursive: true });
        fs.writeFileSync(
            reporter,
            'require("node:fs").writeFileSync(process.env.VERBATIM_REPORT, JSON.stringify(process.argv.slice(2)));\n',
        );
        // A batch file so that the program in the line is what `cmd` has to find.
        const shim = `@"${process.execPath}" "${reporter}" %*\r\n`;
        fs.writeFileSync(noSpaceCmd, shim);
        fs.writeFileSync(spacedCmd, shim);
        execFileSync(
            process.execPath,
            [path.join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js'), '--no-dts', '--out-dir', dist],
            { cwd: root, stdio: 'ignore', windowsHide: true },
        );
    }, 180_000);

    afterAll(() => {
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    it('the fixture path has no spaces, or the first case tests the wrong thing', () => {
        expect(noSpaceCmd).not.toMatch(/\s/);
    });

    describe.each(['in-process', 'host'] as const)('%s backend', (backend) => {
        const assertBackend = (o: Outcome) => {
            expect(o.error, o.error).toBeUndefined();
            expect(o.hostBacked).toBe(backend === 'host');
        };

        it('with the flag: a quoted path with no spaces runs and gets its argv', () => {
            const o = run(backend, COMSPEC, viaCmd(`"${noSpaceCmd}" alpha "b c"`), true);
            assertBackend(o);
            expect(o.argv, `output: ${o.output}`).toEqual(['alpha', 'b c']);
            expect(o.exit).toMatchObject({ exitCode: 0 });
        }, 90_000);

        it('with the flag: a quoted path WITH spaces runs too, thanks to the outer wrap', () => {
            const o = run(backend, COMSPEC, viaCmd(`"${spacedCmd}" alpha "b c"`), true);
            assertBackend(o);
            expect(o.argv, `output: ${o.output}`).toEqual(['alpha', 'b c']);
            expect(o.exit).toMatchObject({ exitCode: 0 });
        }, 90_000);

        it('CONTROL, without the flag: the same line fails the way the bug report says', () => {
            const o = run(backend, COMSPEC, viaCmd(`"${noSpaceCmd}" alpha`));
            assertBackend(o);
            expect(o.argv, 'the program ran, so this control no longer reproduces the bug').toBeNull();
            expect(o.output).toMatch(/\\".*is not recognized/);
            expect(o.exit).not.toMatchObject({ exitCode: 0 });
        }, 90_000);

        it('CONTROL, without the flag: a second quoted argument fails too, with a different message', () => {
            // Measured: with another quoted element on the line, cmd.exe reports
            // "The network path was not found." instead of "is not recognized".
            // Same cause, so do not search for only one of the two messages.
            const o = run(backend, COMSPEC, viaCmd(`"${noSpaceCmd}" alpha "b c"`));
            assertBackend(o);
            expect(o.argv, 'the program ran, so this control no longer reproduces the bug').toBeNull();
            expect(o.exit).not.toMatchObject({ exitCode: 0 });
        }, 90_000);

        it('without the flag: an ordinary program and argument list is still quoted for you', () => {
            const o = run(backend, process.execPath, [reporter, 'alpha', 'b c', 'd"e']);
            assertBackend(o);
            expect(o.argv, `output: ${o.output}`).toEqual(['alpha', 'b c', 'd"e']);
            expect(o.exit).toMatchObject({ exitCode: 0 });
        }, 90_000);
    });
});
