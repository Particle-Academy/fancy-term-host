import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServiceIo } from './types';

/**
 * Production {@link ServiceIo}: real fs + child_process. The orchestration in
 * index.ts takes a ServiceIo so tests can inject a fake and never touch the OS.
 */
export function nodeServiceIo(): ServiceIo {
    return {
        run(argv) {
            const [cmd, ...args] = argv;
            return new Promise((resolve) => {
                let stdout = '';
                let stderr = '';
                const child = spawn(cmd, args, {
                    // schtasks/launchctl/systemctl resolve via the shell on win32.
                    shell: process.platform === 'win32',
                    windowsHide: true,
                });
                child.stdout?.on('data', (d) => (stdout += d.toString()));
                child.stderr?.on('data', (d) => (stderr += d.toString()));
                child.on('error', (err) =>
                    resolve({ code: -1, stdout, stderr: stderr + String(err) }),
                );
                child.on('close', (code) =>
                    resolve({ code: code ?? -1, stdout, stderr }),
                );
            });
        },
        async writeFile(p, contents, opts) {
            await fs.mkdir(path.dirname(p), { recursive: true });
            await fs.writeFile(p, contents, { mode: opts?.mode ?? 0o600 });
        },
        async readFile(p) {
            try {
                return await fs.readFile(p, 'utf8');
            } catch {
                return null;
            }
        },
        async mkdirp(dir) {
            await fs.mkdir(dir, { recursive: true });
        },
        async rm(p) {
            await fs.rm(p, { force: true }).catch(() => {});
        },
        async exists(p) {
            try {
                await fs.access(p);
                return true;
            } catch {
                return false;
            }
        },
    };
}
