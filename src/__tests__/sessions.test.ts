import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSnapshotStore, type SnapshotStore } from '../sessions';
import type { Encryptor } from '../ports';

/**
 * Session-snapshot persistence (Tier 1). Exercises the gzip + (optional)
 * encryptor round-trip, the plaintext fallback when encryption is unavailable,
 * the tail-trim cap, and the corrupt/missing → null tolerance.
 *
 * The inversion: instead of mocking electron's app.getPath + safeStorage, we
 * build the store with TEST-DOUBLE PORTS — a per-test temp baseDir and a fake
 * Encryptor. The default encryptor reports unavailable (exercises the plaintext
 * fallback); the encrypted cases swap in an identity-cipher Encryptor (a
 * Buffer→Buffer passthrough), enough to prove the encrypt/decrypt branch is
 * wired correctly without a real keychain. This proves the SnapshotStoreConfig
 * inversion: the core no longer imports electron.
 */

let tmpDir: string;

/**
 * An Encryptor that genuinely TRANSFORMS bytes, so the encrypted branch is a
 * real round-trip rather than a passthrough.
 *
 * This was an identity cipher until 2026-10-10 (`encrypt: (b) => b`). That
 * proved the encrypt/decrypt branch was REACHED and could not prove it was
 * REVERSIBLE: with both halves no-ops, an implementation that forgot to
 * decrypt, or decrypted in the wrong place, read back perfectly. The test was
 * weaker than it read — the same shape as a check whose own prose can fail it.
 * `claude · genie2` hit it in their live check and named it.
 *
 * Deliberately NOT a bare XOR. XOR with a fixed key is an INVOLUTION, so
 * `encrypt(encrypt(x)) === x` and calling `encrypt` on the read path instead of
 * `decrypt` would still round-trip — a passthrough's weakness wearing a
 * cipher's clothes. This prepends a marker as well, so the transform is
 * directional: `decrypt` throws unless the marker is there, which makes
 * "encrypted twice" and "never decrypted" both detectable.
 */
const XOR_KEY = 0x5a;
const MARKER = Buffer.from('ENC1');

const xorBytes = (b: Buffer): Buffer => Buffer.from(b.map((byte) => byte ^ XOR_KEY));

const transformingEncryptor: Encryptor = {
    isAvailable: () => true,
    encrypt: (b) => Buffer.concat([MARKER, xorBytes(b)]),
    decrypt: (b) => {
        if (!b.subarray(0, MARKER.length).equals(MARKER)) {
            throw new Error('decrypt called on bytes this cipher did not encrypt');
        }
        return xorBytes(b.subarray(MARKER.length));
    },
};

/** Encryptor that reports the OS can't encrypt → plaintext-magic fallback. */
const unavailableEncryptor: Encryptor = {
    isAvailable: () => false,
    encrypt: (b) => b,
    decrypt: (b) => b,
};

function storeWith(encryptor: Encryptor): SnapshotStore {
    return createSnapshotStore({ baseDir: tmpDir, encryptor });
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-sessions-'));
});

afterEach(() => {
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
});

describe('the test cipher is a real transform, not a passthrough', () => {
    // Guards the GUARD. Every encrypted-branch assertion below is only as strong
    // as this double, and the cheapest way to weaken them all is to quietly
    // simplify it back to `(b) => b`.
    const plain = Buffer.from('scrollback');

    it('changes the bytes', () => {
        expect(transformingEncryptor.encrypt(plain).equals(plain)).toBe(false);
    });

    it('is reversible', () => {
        expect(transformingEncryptor.decrypt(transformingEncryptor.encrypt(plain)).equals(plain)).toBe(true);
    });

    it('is DIRECTIONAL, so encrypting twice is not the same as a round-trip', () => {
        // The property a bare XOR would not have, and the reason it was rejected.
        const once = transformingEncryptor.encrypt(plain);
        expect(transformingEncryptor.encrypt(once).equals(once)).toBe(false);
        expect(() => transformingEncryptor.decrypt(plain)).toThrow();
    });
});

describe('sessions snapshot round-trip', () => {
    it('writes then reads back the same serialized text (plaintext fallback)', () => {
        const store = storeWith(unavailableEncryptor);
        const text = 'hello \x1b[31mworld\x1b[0m\r\n$ ';
        const bytes = store.writeSnapshot('term-a', text);
        expect(bytes).toBeGreaterThan(0);

        const read = store.readSnapshot('term-a');
        expect(read).not.toBeNull();
        expect(read!.serialized).toBe(text);
        expect(typeof read!.savedAt).toBe('number');
    });

    it('round-trips through the encrypted path', () => {
        // Encryption "available" + an identity cipher: encrypt returns the
        // bytes, decrypt returns them back. Proves the encrypt/decrypt branch is
        // reached and reversible.
        const store = storeWith(transformingEncryptor);
        const text = 'encrypted buffer — OK';
        store.writeSnapshot('term-enc', text);
        const read = store.readSnapshot('term-enc');
        expect(read?.serialized).toBe(text);
    });

    it('marks the encrypted file with the encrypted magic byte (0x01)', () => {
        const store = storeWith(transformingEncryptor);
        store.writeSnapshot('term-magic', 'x');
        const file = path.join(tmpDir, 'sessions', 'term-magic.snap');
        const raw = fs.readFileSync(file);
        expect(raw[0]).toBe(0x01);
    });

    it('plaintext fallback writes the plaintext magic byte (0x00)', () => {
        const store = storeWith(unavailableEncryptor);
        store.writeSnapshot('term-plain', 'x');
        const file = path.join(tmpDir, 'sessions', 'term-plain.snap');
        const raw = fs.readFileSync(file);
        expect(raw[0]).toBe(0x00);
    });

    it('trims oversized input to the tail (~256KB cap)', () => {
        const store = storeWith(unavailableEncryptor);
        // 400KB of input — head is "AAAA…", tail is a unique marker we expect
        // to survive the tail-keeping trim.
        const head = 'A'.repeat(400 * 1024);
        const tail = 'TAIL-MARKER-END';
        store.writeSnapshot('term-big', head + tail);
        const read = store.readSnapshot('term-big');
        expect(read).not.toBeNull();
        // Tail kept, head dropped.
        expect(read!.serialized.endsWith(tail)).toBe(true);
        expect(read!.serialized.length).toBeLessThan((head + tail).length);
        expect(Buffer.byteLength(read!.serialized, 'utf8')).toBeLessThanOrEqual(
            256 * 1024,
        );
    });

    it('returns null for a missing snapshot', () => {
        const store = storeWith(unavailableEncryptor);
        expect(store.readSnapshot('does-not-exist')).toBeNull();
    });

    it('returns null (never throws) for a corrupt snapshot file', () => {
        const store = storeWith(unavailableEncryptor);
        store.writeSnapshot('term-corrupt', 'good data');
        const file = path.join(tmpDir, 'sessions', 'term-corrupt.snap');
        // Clobber the gzip body with garbage, keep a valid-looking magic byte.
        fs.writeFileSync(file, Buffer.from([0x00, 0xff, 0xfe, 0xfd, 0xfc]));
        expect(() => store.readSnapshot('term-corrupt')).not.toThrow();
        expect(store.readSnapshot('term-corrupt')).toBeNull();
    });

    it('returns null for an unknown magic byte', () => {
        const store = storeWith(unavailableEncryptor);
        const dir = path.join(tmpDir, 'sessions');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'term-weird.snap'), Buffer.from([0x09, 1, 2, 3]));
        expect(store.readSnapshot('term-weird')).toBeNull();
    });

    it('deleteSnapshot removes the file and is a no-op when absent', () => {
        const store = storeWith(unavailableEncryptor);
        store.writeSnapshot('term-del', 'bye');
        expect(store.readSnapshot('term-del')).not.toBeNull();
        store.deleteSnapshot('term-del');
        expect(store.readSnapshot('term-del')).toBeNull();
        // Second delete must not throw.
        expect(() => store.deleteSnapshot('term-del')).not.toThrow();
    });

    it('writeSnapshot returns null for empty input', () => {
        const store = storeWith(unavailableEncryptor);
        expect(store.writeSnapshot('term-empty', '')).toBeNull();
    });
});

/**
 * Whether a snapshot is encrypted at rest, reported THROUGH the API.
 *
 * Asked for by `claude · genie2` on 2026-10-10, and the reason is the better
 * half of the request. Genie 2 shipped its terminal engine writing plaintext
 * snapshots because its `Encryptor` reported unavailable — not because the OS
 * could not encrypt (the case the fallback exists for) but because the module
 * was loading under plain Node for a live check. A DEVELOPMENT condition
 * wearing the fallback's clothes, in a buffer where humans type passwords.
 *
 * It was undetectable from outside: the only signal was a `console.warn` fired
 * ONCE per process, and the only reliable check was reading the magic byte of
 * `<baseDir>/sessions/<id>.snap` — which means a consumer reaching past this
 * API into the file format, coupling they correctly refused to carry.
 *
 * So the posture is now part of the surface:
 *   - `encrypting()` — what a write WOULD do right now, so a consumer can
 *     assert it at startup and fail loudly the day `safeStorage` stops being
 *     wired, rather than discovering plaintext later.
 *   - `SnapshotRead.encrypted` — how the file ON DISK was actually stored,
 *     which is a different question and can disagree with the first after an
 *     environment change.
 *
 * Deliberately NOT added: a fail-closed `requireEncryption`. The documented
 * trade is that a non-functional resume is worse than a plaintext scrollback,
 * and reversing that in a package default would be wrong. genie2 agreed, and
 * said a fail-closed posture for Genie is a Genie-side assertion. These two
 * accessors are what make such an assertion possible without this package
 * choosing for everyone.
 */
describe('the encryption posture is readable through the API', () => {
    it('reports what a write would do, without writing anything', () => {
        expect(storeWith(transformingEncryptor).encrypting()).toBe(true);
        expect(storeWith(unavailableEncryptor).encrypting()).toBe(false);

        // No file may be needed to answer it — this is the startup assertion,
        // and a check that required a write would be useless at startup.
        expect(fs.existsSync(path.join(tmpDir, 'sessions'))).toBe(false);
    });

    it('treats a throwing Encryptor as not encrypting, rather than propagating', () => {
        // Same tolerance the write path already has: this surface must never
        // throw, or an assertion on it becomes a crash at startup.
        const hostile: Encryptor = {
            isAvailable: () => {
                throw new Error('keychain exploded');
            },
            encrypt: (b) => b,
            decrypt: (b) => b,
        };
        expect(storeWith(hostile).encrypting()).toBe(false);
    });

    it('reports how the file on disk was ACTUALLY stored', () => {
        storeWith(transformingEncryptor).writeSnapshot('enc', 'secret output');
        expect(storeWith(transformingEncryptor).readSnapshot('enc')!.encrypted).toBe(true);

        storeWith(unavailableEncryptor).writeSnapshot('plain', 'secret output');
        expect(storeWith(unavailableEncryptor).readSnapshot('plain')!.encrypted).toBe(false);
    });

    it('agrees with the magic byte, which is what consumers were reading instead', () => {
        // Pins the mapping to the on-disk format rather than to itself. If these
        // ever disagree, the accessor is lying and the byte is the truth.
        storeWith(transformingEncryptor).writeSnapshot('enc', 'x');
        storeWith(unavailableEncryptor).writeSnapshot('plain', 'x');

        const byte0 = (id: string) => fs.readFileSync(path.join(tmpDir, 'sessions', `${id}.snap`))[0];
        expect(byte0('enc')).toBe(0x01);
        expect(byte0('plain')).toBe(0x00);
        expect(storeWith(transformingEncryptor).readSnapshot('enc')!.encrypted).toBe(true);
        expect(storeWith(unavailableEncryptor).readSnapshot('plain')!.encrypted).toBe(false);
    });

    it('distinguishes "would encrypt now" from "was encrypted then"', () => {
        // The case that motivated the whole request: a snapshot written while
        // encryption was unavailable, later read by a process that CAN encrypt.
        // `encrypting()` says true, the file says false, and a consumer needs
        // both to know it has plaintext on disk to migrate.
        storeWith(unavailableEncryptor).writeSnapshot('legacy', 'written before safeStorage was wired');

        const nowEncrypting = storeWith(transformingEncryptor);
        expect(nowEncrypting.encrypting()).toBe(true);
        expect(nowEncrypting.readSnapshot('legacy')!.encrypted).toBe(false);
        expect(nowEncrypting.readSnapshot('legacy')!.serialized).toBe('written before safeStorage was wired');
    });
});
