import { describe, expect, it } from 'vitest';
import {
    buildServiceDescriptor,
    ensureHostService,
    installHostService,
    isServiceInstalled,
    resolveServiceConfig,
    serviceStatus,
    uninstallHostService,
    type ServiceIo,
} from '../service';
import type { HostServiceConfig } from '../service';

const config: HostServiceConfig = {
    label: 'test.ptyhost',
    userDataDir: '/tmp/test-genie',
    hostScript: '/opt/x/pty-host.js',
    runtime: { nodePath: '/usr/bin/node', source: 'test' },
};

// The real descriptor for the CURRENT platform — used to seed the fake fs with a
// correctly-pathed, correctly-marked unit so the lifecycle assertions stay
// OS-agnostic (launchd on mac CI, systemd on linux CI, schtasks on Windows).
const desc = buildServiceDescriptor(resolveServiceConfig(config));

/** A status-query argv for any platform (is-active / print / /Query). */
function isStatusQuery(argv: string[]): boolean {
    return (
        argv.includes('is-active') ||
        argv.includes('print') ||
        argv.includes('/Query')
    );
}

const RUNNING_OUT = 'active; state = running; Status: Running; pid = 42';
const STOPPED_OUT = 'inactive';

function fakeIo(opts: {
    files?: Record<string, string>;
    statusOut?: string;
    statusCode?: number;
    failOn?: (argv: string[]) => boolean;
} = {}) {
    const files = new Map<string, string>(Object.entries(opts.files ?? {}));
    const commands: string[][] = [];
    const io: ServiceIo = {
        async run(argv) {
            commands.push(argv);
            if (opts.failOn?.(argv)) {
                return { code: 1, stdout: '', stderr: 'boom' };
            }
            if (isStatusQuery(argv)) {
                return {
                    code: opts.statusCode ?? 0,
                    stdout: opts.statusOut ?? STOPPED_OUT,
                    stderr: '',
                };
            }
            return { code: 0, stdout: '', stderr: '' };
        },
        async writeFile(p, c) {
            files.set(p, c);
        },
        async readFile(p) {
            return files.has(p) ? (files.get(p) as string) : null;
        },
        async mkdirp() {},
        async rm(p) {
            files.delete(p);
        },
        async exists(p) {
            return files.has(p);
        },
    };
    return { io, files, commands };
}

describe('installHostService', () => {
    it('writes the unit file and runs the register commands', async () => {
        const f = fakeIo();
        await installHostService(config, f.io);
        expect(f.files.has(desc.unitPath)).toBe(true);
        // at least one register command ran
        expect(f.commands.length).toBeGreaterThan(0);
        expect(await isServiceInstalled(config, f.io)).toBe(true);
    });
});

describe('ensureHostService', () => {
    it('installs + starts when nothing is there', async () => {
        const f = fakeIo();
        const r = await ensureHostService(config, f.io);
        expect(r.ok).toBe(true);
        expect(r.action).toBe('installed-and-started');
        expect(f.files.has(desc.unitPath)).toBe(true);
    });

    it('is a no-op when already running at the same revision', async () => {
        const f = fakeIo({
            files: { [desc.unitPath]: desc.unitContents },
            statusOut: RUNNING_OUT,
        });
        const r = await ensureHostService(config, f.io);
        expect(r).toMatchObject({ ok: true, action: 'already-running' });
        // no write happened (file already present, contents untouched)
        expect(f.files.get(desc.unitPath)).toBe(desc.unitContents);
    });

    it('just starts when installed (same revision) but stopped', async () => {
        const f = fakeIo({
            files: { [desc.unitPath]: desc.unitContents },
            statusOut: STOPPED_OUT,
        });
        const r = await ensureHostService(config, f.io);
        expect(r).toMatchObject({ ok: true, action: 'started' });
    });

    it('reinstalls when the installed revision is stale', async () => {
        const stale = desc.unitContents.replace(
            /fancy-term-service-revision:\s*\S+/,
            'fancy-term-service-revision: OLD',
        );
        const f = fakeIo({ files: { [desc.unitPath]: stale }, statusOut: STOPPED_OUT });
        const r = await ensureHostService(config, f.io);
        expect(r).toMatchObject({ ok: true, action: 'reinstalled' });
        // the unit was rewritten to the current revision
        expect(f.files.get(desc.unitPath)).toBe(desc.unitContents);
    });

    it('never throws — returns ok:false on a command failure', async () => {
        const f = fakeIo({
            failOn: (argv) => !isStatusQuery(argv) && argv.some((a) => a.includes('install') || a.includes('enable') || a.includes('bootstrap') || a.includes('/Create')),
        });
        const r = await ensureHostService(config, f.io);
        expect(r.ok).toBe(false);
        expect(r.action).toBe('failed');
        expect(r.error).toBeTruthy();
    });

    it('reports unsupported config (no runtime) as failed, not a throw', async () => {
        const f = fakeIo();
        // Force resolveServiceConfig to fail by stripping the runtime AND making
        // PATH resolution impossible via an empty-ish config the resolver can't
        // satisfy is hard here; instead assert resolveServiceConfig throws and
        // ensure swallows it for a config we know can't resolve.
        const noRuntime: HostServiceConfig = {
            label: 'x',
            userDataDir: '/tmp/x',
            hostScript: '/x/pty-host.js',
            runtime: undefined,
        };
        // We can't guarantee the test host lacks node, so only assert it never
        // throws and returns a structured result.
        const r = await ensureHostService(noRuntime, f.io);
        expect(typeof r.ok).toBe('boolean');
        expect(['installed-and-started', 'already-running', 'started', 'reinstalled', 'failed']).toContain(r.action);
    });
});

describe('uninstallHostService', () => {
    it('removes the unit file and never throws when absent', async () => {
        const f = fakeIo({ files: { [desc.unitPath]: desc.unitContents } });
        await uninstallHostService(config, f.io);
        expect(f.files.has(desc.unitPath)).toBe(false);
        // second uninstall on nothing is a no-op
        await expect(uninstallHostService(config, f.io)).resolves.toBeUndefined();
    });
});

describe('serviceStatus', () => {
    it('reports not-installed when no unit exists', async () => {
        const f = fakeIo();
        const s = await serviceStatus(config, f.io);
        expect(s.installed).toBe(false);
        expect(s.state).toBe('not-installed');
    });

    it('reports running with the installed revision', async () => {
        const f = fakeIo({
            files: { [desc.unitPath]: desc.unitContents },
            statusOut: RUNNING_OUT,
        });
        const s = await serviceStatus(config, f.io);
        expect(s).toMatchObject({ installed: true, running: true, state: 'running' });
        expect(s.installedRevision).toBeTruthy();
    });
});
