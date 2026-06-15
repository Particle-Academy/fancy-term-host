import { describe, expect, it } from 'vitest';
import { resolveServiceRuntime } from '../service/runtime';

describe('resolveServiceRuntime', () => {
    it('prefers an explicit nodePath', () => {
        const r = resolveServiceRuntime({ nodePath: '/custom/node', env: {} });
        expect(r).toMatchObject({ nodePath: '/custom/node', source: 'explicit' });
    });

    it('falls to $FANCY_TERM_NODE', () => {
        const r = resolveServiceRuntime({
            env: { FANCY_TERM_NODE: '/opt/node20/bin/node' },
            execPath: '/Applications/Genie.app/Contents/MacOS/Genie',
            isElectron: true,
        });
        expect(r).toMatchObject({
            nodePath: '/opt/node20/bin/node',
            source: 'env:FANCY_TERM_NODE',
        });
    });

    it('uses process.execPath when it is plain node (not electron)', () => {
        const r = resolveServiceRuntime({
            env: {},
            execPath: '/usr/local/bin/node',
            isElectron: false,
        });
        expect(r).toMatchObject({ nodePath: '/usr/local/bin/node', source: 'process.execPath' });
    });

    it('REFUSES the electron binary (that is the whole bug)', () => {
        const r = resolveServiceRuntime({
            env: {},
            execPath: '/Applications/Genie.app/Contents/MacOS/Genie',
            isElectron: true,
            pathProbe: () => null, // nothing on PATH either
        });
        expect(r).toBeNull();
    });

    it('refuses execPath even named non-node when electron flag is unset but basename mismatches', () => {
        const r = resolveServiceRuntime({
            env: {},
            execPath: '/Applications/Genie.app/Contents/MacOS/Genie',
            isElectron: false,
            pathProbe: () => null,
        });
        expect(r).toBeNull();
    });

    it('falls back to a node found on PATH', () => {
        const r = resolveServiceRuntime({
            env: {},
            execPath: '/Applications/Genie.app/Contents/MacOS/Genie',
            isElectron: true,
            pathProbe: (names) => (names.includes('node') ? '/usr/bin/node' : null),
        });
        expect(r).toMatchObject({ nodePath: '/usr/bin/node', source: 'PATH' });
    });

    it('carries nodePtyDir through (option or env)', () => {
        expect(
            resolveServiceRuntime({ nodePath: '/n', nodePtyDir: '/native', env: {} }),
        ).toMatchObject({ nodePtyDir: '/native' });
        expect(
            resolveServiceRuntime({ nodePath: '/n', env: { FANCY_TERM_NODE_PTY: '/native2' } }),
        ).toMatchObject({ nodePtyDir: '/native2' });
    });
});
