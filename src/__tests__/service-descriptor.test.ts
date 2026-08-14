import { describe, expect, it } from 'vitest';
import {
    buildServiceDescriptor,
    parseInstalledRevision,
    servicePlatformFor,
    SERVICE_REVISION,
    type ResolvedServiceConfig,
} from '../service/descriptor';

const base: ResolvedServiceConfig = {
    label: 'academy.particle.genie.ptyhost',
    userDataDir: '/home/u/.genie',
    hostScript: '/opt/genie/dist/pty-host.js',
    runtime: { nodePath: '/usr/bin/node', source: 'PATH' },
    env: { FOO: 'bar' },
    revision: SERVICE_REVISION,
    logDir: '/home/u/.genie',
};

describe('servicePlatformFor', () => {
    it('maps each supported OS, null otherwise', () => {
        expect(servicePlatformFor('darwin')).toBe('launchd');
        expect(servicePlatformFor('linux')).toBe('systemd');
        expect(servicePlatformFor('win32')).toBe('windows-task');
        expect(servicePlatformFor('aix' as NodeJS.Platform)).toBeNull();
    });
});

describe('launchd descriptor', () => {
    const d = buildServiceDescriptor(base, {
        platform: 'launchd',
        home: '/Users/u',
        uid: 501,
    });

    it('writes the plist under ~/Library/LaunchAgents', () => {
        expect(d.unitPath).toBe(
            '/Users/u/Library/LaunchAgents/academy.particle.genie.ptyhost.plist',
        );
        expect(d.unitContents).toContain('<key>RunAtLoad</key>');
        expect(d.unitContents).toContain('<string>/usr/bin/node</string>');
        expect(d.unitContents).toContain('<string>/opt/genie/dist/pty-host.js</string>');
    });

    it('injects env incl. GENIE_USERDATA + the revision', () => {
        expect(d.unitContents).toContain('<key>GENIE_USERDATA</key>');
        expect(d.unitContents).toContain('<string>/home/u/.genie</string>');
        expect(d.unitContents).toContain('<key>FOO</key>');
        expect(d.unitContents).toContain(`fancy-term-service-revision: ${SERVICE_REVISION}`);
    });

    it('targets the gui/<uid> domain for launchctl', () => {
        expect(d.installArgv[0]).toEqual([
            'launchctl', 'bootstrap', 'gui/501',
            '/Users/u/Library/LaunchAgents/academy.particle.genie.ptyhost.plist',
        ]);
        expect(d.startArgv[0]).toEqual([
            'launchctl', 'kickstart', '-k', 'gui/501/academy.particle.genie.ptyhost',
        ]);
        expect(d.uninstallArgv[0]).toEqual([
            'launchctl', 'bootout', 'gui/501/academy.particle.genie.ptyhost',
        ]);
    });
});

describe('systemd descriptor', () => {
    const d = buildServiceDescriptor(base, { platform: 'systemd', home: '/home/u' });

    it('writes a --user unit and uses systemctl --user', () => {
        expect(d.unitPath).toBe(
            '/home/u/.config/systemd/user/academy.particle.genie.ptyhost.service',
        );
        expect(d.unitContents).toContain('ExecStart=/usr/bin/node /opt/genie/dist/pty-host.js');
        expect(d.unitContents).toContain('WantedBy=default.target');
        expect(d.unitContents).toContain('Environment=GENIE_USERDATA=/home/u/.genie');
        expect(d.installArgv).toContainEqual([
            'systemctl', '--user', 'enable', '--now',
            'academy.particle.genie.ptyhost.service',
        ]);
        expect(d.statusArgv).toEqual([
            'systemctl', '--user', 'is-active',
            'academy.particle.genie.ptyhost.service',
        ]);
    });
});

describe('windows-task descriptor', () => {
    const d = buildServiceDescriptor(
        { ...base, userDataDir: 'C:/Users/u/AppData/Roaming/Genie' },
        { platform: 'windows-task' },
    );

    it('emits a launcher .cmd that sets env then runs node host', () => {
        expect(d.unitPath).toContain('academy.particle.genie.ptyhost.cmd');
        expect(d.unitContents).toContain('set "GENIE_USERDATA=C:/Users/u/AppData/Roaming/Genie"');
        expect(d.unitContents).toContain('"/usr/bin/node" "/opt/genie/dist/pty-host.js"');
        expect(d.unitContents).toContain(`fancy-term-service-revision: ${SERVICE_REVISION}`);
    });

    /**
     * Issue #10. The pty-host is single-instance and shared by every terminal
     * in a consumer app, so when it dies the whole fleet freezes at once. On
     * Windows there was NO trace of why: the `.cmd` ran node with no
     * redirection, and consumers on locked-down machines (where `schtasks
     * /Create` is policy-denied) launch it via a hidden `wscript`, whose
     * inherited console is discarded. A crash left literally nothing behind.
     *
     * 0.4.0 added `logDir` and wired stdio capture for launchd and systemd, and
     * `windowsTask()` was simply never updated — it is the one platform that
     * never read the config field added for exactly this.
     *
     * `<nul` matters as much as the redirection: it detaches stdin, hardening
     * against an unexpected stdin EOF, which is the same failure class that
     * produces a silent EPIPE exit.
     */
    const win = buildServiceDescriptor(
        {
            ...base,
            userDataDir: 'C:/Users/u/AppData/Roaming/Genie',
            logDir: 'C:/Users/u/AppData/Roaming/Genie/logs',
        },
        { platform: 'windows-task' },
    );

    it('captures the host stdout and stderr into logDir', () => {
        expect(win.unitContents).toContain('1>>"C:\\Users\\u\\AppData\\Roaming\\Genie\\logs\\ptyhost.out.log"');
        expect(win.unitContents).toContain('2>>"C:\\Users\\u\\AppData\\Roaming\\Genie\\logs\\ptyhost.err.log"');
    });

    it('detaches stdin so an EOF read cannot kill the host silently', () => {
        expect(win.unitContents).toContain('<nul');
    });

    it('keeps redirection on the same line as the host invocation', () => {
        // A redirection on its own line redirects nothing. Assert the operators
        // sit on the line that actually launches node.
        const line = win.unitContents
            .split(/\r?\n/)
            .find((l) => l.includes(base.hostScript));

        expect(line).toBeDefined();
        expect(line).toContain('1>>');
        expect(line).toContain('2>>');
        expect(line).toContain('<nul');
    });

    it('registers a per-user ONLOGON task with no elevation', () => {
        const create = d.installArgv[0];
        expect(create).toContain('schtasks');
        expect(create).toContain('/Create');
        expect(create).toContain('ONLOGON');
        expect(create).toContain('LIMITED'); // /RL LIMITED — no elevation
        expect(d.uninstallArgv[0]).toEqual([
            'schtasks', '/Delete', '/TN', 'academy.particle.genie.ptyhost', '/F',
        ]);
    });
});

describe('NODE_PATH for an ABI-matched node-pty', () => {
    it('is set when the runtime carries a nodePtyDir', () => {
        const d = buildServiceDescriptor(
            { ...base, runtime: { nodePath: '/usr/bin/node', nodePtyDir: '/opt/genie/native', source: 'explicit' } },
            { platform: 'systemd', home: '/home/u' },
        );
        expect(d.unitContents).toContain('Environment=NODE_PATH=/opt/genie/native');
    });
});

describe('parseInstalledRevision', () => {
    it('round-trips the marker from generated unit contents', () => {
        const d = buildServiceDescriptor(base, { platform: 'systemd', home: '/home/u' });
        expect(parseInstalledRevision(d.unitContents)).toBe(SERVICE_REVISION);
        expect(parseInstalledRevision('no marker here')).toBeNull();
    });
});
