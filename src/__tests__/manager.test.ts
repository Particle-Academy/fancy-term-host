import { describe, expect, it } from 'vitest';

/**
 * Pty I/O + lifecycle live in default-engine.test.ts, exit-delivery.test.ts and
 * host-live.test.ts. This file only exercises the pure helpers.
 */

describe('defaultShell', () => {
    it('returns a non-empty string on this platform', async () => {
        const { defaultShell } = await import('../manager');
        const shell = defaultShell();
        expect(typeof shell).toBe('string');
        expect(shell.length).toBeGreaterThan(0);
    });

    it('honours COMSPEC on Windows', async () => {
        if (process.platform !== 'win32') return; // skip elsewhere
        const { defaultShell } = await import('../manager');
        const original = process.env.COMSPEC;
        process.env.COMSPEC = 'C:\\test\\shell.exe';
        try {
            expect(defaultShell()).toBe('C:\\test\\shell.exe');
        } finally {
            if (original === undefined) delete process.env.COMSPEC;
            else process.env.COMSPEC = original;
        }
    });

    it('honours SHELL on POSIX', async () => {
        if (process.platform === 'win32') return; // skip on Windows
        const { defaultShell } = await import('../manager');
        const original = process.env.SHELL;
        process.env.SHELL = '/usr/local/bin/zsh';
        try {
            expect(defaultShell()).toBe('/usr/local/bin/zsh');
        } finally {
            if (original === undefined) delete process.env.SHELL;
            else process.env.SHELL = original;
        }
    });
});
