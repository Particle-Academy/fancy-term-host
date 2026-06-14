import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    cwdHookSpawn,
    cwdHookEnv,
    shellKind,
    parseCommandLine,
} from '../shells';
import type { SettingsProvider } from '../ports';

/** A minimal SettingsProvider backed by a plain map. */
function settings(values: Record<string, string> = {}): SettingsProvider {
    return { get: (k: string) => values[k] };
}

/** The dir cwdHookSpawn writes shims into (mirrors shells.ts hookDir). */
function shimRoot(): string {
    return path.join(os.tmpdir(), 'fancy-term-host');
}

describe('shellKind', () => {
    it('classifies known shells by basename', () => {
        // Bare + forward-slash forms classify on any platform (shellKind uses the
        // host's path.basename — Windows-backslash paths only split on win32).
        expect(shellKind('/usr/bin/bash')).toBe('bash');
        expect(shellKind('bash')).toBe('bash');
        expect(shellKind('/bin/zsh')).toBe('zsh');
        expect(shellKind('/opt/homebrew/bin/fish')).toBe('fish');
        expect(shellKind('pwsh')).toBe('powershell');
        expect(shellKind('powershell.exe')).toBe('powershell');
        expect(shellKind('cmd.exe')).toBe('cmd');
        expect(shellKind('/usr/bin/nu')).toBe('other');
    });

    it('resolves Windows backslash paths on win32', () => {
        if (process.platform !== 'win32') return;
        expect(shellKind('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash');
        expect(
            shellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
        ).toBe('powershell');
        expect(shellKind('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
    });
});

describe('parseCommandLine', () => {
    it('splits an executable line honoring quotes', () => {
        expect(parseCommandLine('"C:\\Program Files\\Git\\bin\\bash.exe" --login -i')).toEqual({
            command: 'C:\\Program Files\\Git\\bin\\bash.exe',
            args: ['--login', '-i'],
        });
        expect(parseCommandLine('zsh')).toEqual({ command: 'zsh', args: [] });
        expect(parseCommandLine('   ')).toEqual({ command: '', args: [] });
    });
});

describe('cwdHookSpawn — gating', () => {
    it('returns an empty hook when track_cwd is off, for every shell', () => {
        for (const sh of ['bash', 'zsh', 'fish', 'pwsh', 'cmd.exe', 'nu']) {
            expect(cwdHookSpawn(sh, settings({ track_cwd: 'off' }))).toEqual({
                env: {},
                args: [],
            });
        }
    });

    it('returns an empty hook for an unknown shell even when tracking is on', () => {
        expect(cwdHookSpawn('/usr/bin/nu', settings())).toEqual({ env: {}, args: [] });
    });
});

describe('cwdHookSpawn — bash', () => {
    it('emits an OSC-7 PROMPT_COMMAND, no extra args', () => {
        const hook = cwdHookSpawn('/usr/bin/bash', settings());
        expect(hook.args).toEqual([]);
        expect(hook.env.PROMPT_COMMAND).toContain('\\033]7;file://');
        expect(hook.env.PROMPT_COMMAND).toContain('"$PWD"');
    });

    it('cwdHookEnv is the env half of cwdHookSpawn', () => {
        const s = settings();
        expect(cwdHookEnv('/usr/bin/bash', s)).toEqual(cwdHookSpawn('/usr/bin/bash', s).env);
    });
});

describe('cwdHookSpawn — zsh', () => {
    it('points ZDOTDIR at a generated dir whose rc preserves the user config', () => {
        const hook = cwdHookSpawn('/bin/zsh', settings());
        expect(hook.args).toEqual([]);
        const dir = hook.env.ZDOTDIR;
        expect(dir).toBeTruthy();
        expect(dir.startsWith(shimRoot())).toBe(true);
        const rc = fs.readFileSync(path.join(dir, '.zshrc'), 'utf8');
        // Sources the user's real rc (overlay, not clobber) + registers precmd.
        expect(rc).toContain('source');
        expect(rc).toContain('precmd_functions+=(__fth_osc7)');
        expect(rc).toContain('file://');
        // .zshenv sources the user's real env first.
        expect(fs.existsSync(path.join(dir, '.zshenv'))).toBe(true);
    });
});

describe('cwdHookSpawn — fish', () => {
    it('overlays a vendor conf.d via XDG_DATA_DIRS, no extra args', () => {
        const hook = cwdHookSpawn('/opt/homebrew/bin/fish', settings());
        expect(hook.args).toEqual([]);
        const dirs = hook.env.XDG_DATA_DIRS;
        expect(dirs).toBeTruthy();
        const first = dirs.split(path.delimiter)[0];
        expect(first.startsWith(shimRoot())).toBe(true);
        const conf = fs.readFileSync(
            path.join(first, 'fish', 'vendor_conf.d', 'osc7.fish'),
            'utf8',
        );
        expect(conf).toContain('--on-event fish_prompt');
        expect(conf).toContain('file://');
    });
});

describe('cwdHookSpawn — PowerShell', () => {
    it('appends -NoExit -Command dot-sourcing a generated profile shim', () => {
        const hook = cwdHookSpawn('pwsh', settings());
        expect(hook.env).toEqual({});
        expect(hook.args[0]).toBe('-NoExit');
        expect(hook.args[1]).toBe('-Command');
        const m = /^\. '(.+)'$/.exec(hook.args[2] ?? '');
        expect(m).toBeTruthy();
        const shimPath = m![1];
        const shim = fs.readFileSync(shimPath, 'utf8');
        // Wraps any existing prompt + emits OSC-7 via the ESC char.
        expect(shim).toContain('$global:__fthPrev = $function:prompt');
        expect(shim).toContain('file:///');
        expect(shim).toContain('[char]27');
    });
});

describe('cwdHookSpawn — cmd (best-effort)', () => {
    it('sets a PROMPT that emits OSC-7 then the normal $P$G', () => {
        const hook = cwdHookSpawn('cmd.exe', settings());
        expect(hook.args).toEqual([]);
        expect(hook.env.PROMPT).toBe('$E]7;file:///$P$E\\$P$G');
    });
});
