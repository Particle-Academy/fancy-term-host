import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
    encodeFrame,
    FrameDecoder,
    MAX_FRAME,
    socketPathFor,
    pidfilePath,
    writePidfile,
    readPidfile,
    deletePidfile,
    pidfileUsable,
    userHash,
    type Pidfile,
} from '../ipc';
import { FrameDecoder as HostFrameDecoder, PROTOCOL_VERSION } from '../host-protocol';

/**
 * `@particle-academy/fancy-term-host/ipc` — the transport a SECOND per-user host
 * can reuse (#12).
 *
 * The codec and the socket/pidfile helpers were always free of native code, but
 * they were only exported from the root entry, whose bundle opens with
 * `import { spawn } from 'node-pty'`. A process that must ship with no native
 * dependency (Genie's MCP shuttle) could not import them without copying them,
 * and a copy drifts. This entry is the fix, and these tests hold its two
 * promises: it loads no native module, and it is the SAME implementation the
 * pty-host uses rather than a second one.
 */

const root = path.resolve(__dirname, '..', '..');

type ShuttleMessage = { kind: 'call'; seq: number; tool: string } | { kind: 'result'; seq: number; ok: boolean };

describe('the codec, typed for a caller with its own messages', () => {
    it('round-trips a message union that is not the pty-host Frame', () => {
        const msg: ShuttleMessage = { kind: 'call', seq: 7, tool: 'imDone' };
        const dec = new FrameDecoder<ShuttleMessage>();
        const out: ShuttleMessage[] = dec.push(encodeFrame<ShuttleMessage>(msg));

        expect(out).toEqual([msg]);
    });

    it('exports the frame cap it enforces', () => {
        expect(MAX_FRAME).toBe(16 * 1024 * 1024);
        expect(FrameDecoder.MAX_FRAME).toBe(MAX_FRAME);

        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(MAX_FRAME + 1, 0);
        const dec = new FrameDecoder();
        expect(dec.push(header)).toEqual([]);
        expect(dec.desynced).toBe(true);
    });

    it('is the implementation the pty-host uses, not a copy of it', () => {
        // A copy would pass every round-trip test above and still drift.
        expect(new HostFrameDecoder()).toBeInstanceOf(FrameDecoder);
    });
});

describe('a named host gets its own transport and pidfile', () => {
    let dir: string;
    const realPlatform = process.platform;
    const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p });

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-ipc-'));
    });

    afterEach(() => {
        setPlatform(realPlatform);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('names the Windows pipe after the host', () => {
        setPlatform('win32');

        expect(socketPathFor(dir, 'mcp-shuttle')).toBe(`\\\\.\\pipe\\genie-mcp-shuttle-${userHash()}`);
        // Unnamed is exactly what it always was, so a running pty-host is still found.
        expect(socketPathFor(dir)).toBe(`\\\\.\\pipe\\genie-ptyhost-${userHash()}`);
    });

    it('names the POSIX socket after the host, with the same short-path fallback', () => {
        setPlatform('linux');

        expect(socketPathFor(dir, 'mcp-shuttle')).toBe(path.join(dir, 'mcp-shuttle.sock'));
        expect(socketPathFor(dir)).toBe(path.join(dir, 'ptyhost.sock'));

        const deep = path.join(dir, 'x'.repeat(120));
        expect(socketPathFor(deep, 'mcp-shuttle')).toBe(path.join(os.tmpdir(), `genie-mcp-shuttle-${userHash()}.sock`));
        expect(socketPathFor(deep)).toBe(path.join(os.tmpdir(), `genie-ptyhost-${userHash()}.sock`));
    });

    it('keeps a named pidfile apart from the pty-host one', () => {
        const pty: Pidfile = { pid: process.pid, socketPath: 'pty', protocolVersion: PROTOCOL_VERSION, startedAt: 1 };
        const shuttle: Pidfile = { pid: process.pid, socketPath: 'shuttle', protocolVersion: 1, startedAt: 2 };

        writePidfile(dir, pty);
        writePidfile(dir, shuttle, 'mcp-shuttle');

        expect(pidfilePath(dir)).toBe(path.join(dir, 'ptyhost.json'));
        expect(pidfilePath(dir, 'mcp-shuttle')).toBe(path.join(dir, 'mcp-shuttle.json'));
        expect(readPidfile(dir)).toEqual(pty);
        expect(readPidfile(dir, 'mcp-shuttle')).toEqual(shuttle);

        deletePidfile(dir, 'mcp-shuttle');
        expect(readPidfile(dir, 'mcp-shuttle')).toBeNull();
        expect(readPidfile(dir)).toEqual(pty);
    });

    it('judges a pidfile against the version of the host that reads it', () => {
        const shuttle: Pidfile = { pid: process.pid, socketPath: 's', protocolVersion: 1, startedAt: 1 };

        expect(pidfileUsable(shuttle, 1)).toBe(true);
        expect(pidfileUsable(shuttle, 2)).toBe(false);
        // Without a version it is the pty-host's, as before.
        expect(pidfileUsable({ ...shuttle, protocolVersion: PROTOCOL_VERSION })).toBe(true);
    });

    it('refuses a name that would leave the directory or break a pipe name', () => {
        for (const bad of ['', '../escape', 'a/b', 'a\\b', '.hidden', 'has space']) {
            expect(() => socketPathFor(dir, bad), bad).toThrow(TypeError);
            expect(() => pidfilePath(dir, bad), bad).toThrow(TypeError);
        }
    });
});

describe('the built entry loads no native module', () => {
    // Asserted on BUILT output, because that is what failed: the source was
    // always pure, and the bundle still opened with a node-pty import. Built into
    // a temp dir with the repo's own tsup config, so CI (which tests before it
    // builds) checks it too, and a stale dist/ can't answer for the code.
    let out: string;

    beforeAll(() => {
        out = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-ipc-dist-'));
        execFileSync(process.execPath, [path.join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js'), '--no-dts', '--out-dir', out], {
            cwd: root,
            stdio: 'pipe',
            env: { ...process.env, NODE_ENV: 'production' },
        });
    }, 120_000);

    afterAll(() => {
        fs.rmSync(out, { recursive: true, force: true });
    });

    /** Every module an ESM file reaches through relative imports, itself included. */
    function esmGraph(file: string, seen = new Set<string>()): Set<string> {
        if (seen.has(file)) return seen;
        seen.add(file);
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
            esmGraph(path.resolve(path.dirname(file), m[1]), seen);
        }
        return seen;
    }

    it('is published at the ./ipc subpath', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

        expect(pkg.exports['./ipc'].import.default).toBe('./dist/ipc.js');
        expect(pkg.exports['./ipc'].require.default).toBe('./dist/ipc.cjs');
        expect(pkg.exports['./ipc'].import.types).toBe('./dist/ipc.d.ts');
    });

    /** A static or dynamic import of node-pty or electron — statements only, since
     *  the bundle keeps comments and one of them quotes `require('node-pty')`. */
    const nativeImport =
        /^\s*(?:import|export)\b[^;]*?from\s*['"](?:node-pty|electron)['"]|^\s*import\s*['"](?:node-pty|electron)['"]|[=(,]\s*(?:await\s+)?import\(\s*['"](?:node-pty|electron)['"]\s*\)/m;

    it('the ESM entry reaches no node-pty and no electron', () => {
        const graph = [...esmGraph(path.join(out, 'ipc.js'))];

        // The control: the root entry DOES import node-pty, so the check can see one.
        const rootGraph = [...esmGraph(path.join(out, 'index.js'))];
        expect(rootGraph.some((f) => nativeImport.test(fs.readFileSync(f, 'utf8')))).toBe(true);

        for (const f of graph) {
            expect(fs.readFileSync(f, 'utf8'), path.basename(f)).not.toMatch(nativeImport);
        }
    });

    it('the CJS entry loads, with no native module in the require cache', () => {
        const req = createRequire(path.join(out, 'noop.cjs'));
        const before = new Set(Object.keys(req.cache));
        const ipc = req(path.join(out, 'ipc.cjs'));
        const loaded = Object.keys(req.cache).filter((k) => !before.has(k));

        expect(typeof ipc.encodeFrame).toBe('function');
        expect(loaded.some((k) => k.includes('node-pty') || k.endsWith('.node'))).toBe(false);
    });
});
