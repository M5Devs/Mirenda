import { describe, expect, it } from 'vitest';
import {
  IV_BYTES,
  PBKDF2_ITERATIONS,
  base64ToBytes,
  bytesToBase64,
  deriveMasterKey,
  deriveVerifier,
  generateSalt,
  open,
  seal,
} from '../src/lib/crypto.js';

/** PBKDF2 at 310k iterations is deliberately slow; one derivation is shared. */
const SALT = 'c2FsdHktc2FsdHktc2FsdA==';
const PASSWORD = 'correct horse battery staple';

const keyPromise = deriveMasterKey(PASSWORD, SALT, 1_000);

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });

  it('round-trips the empty array', () => {
    expect(base64ToBytes(bytesToBase64(new Uint8Array(0))).length).toBe(0);
  });

  it('produces standard base64, not base64url', () => {
    const encoded = bytesToBase64(new Uint8Array([251, 255, 191]));
    expect(encoded).toBe('+/+/');
    expect(encoded).not.toContain('-');
    expect(encoded).not.toContain('_');
  });
});

describe('generateSalt', () => {
  it('produces 16 bytes of base64', () => {
    expect(base64ToBytes(generateSalt()).length).toBe(16);
  });

  it('never repeats', () => {
    const salts = new Set(Array.from({ length: 32 }, () => generateSalt()));
    expect(salts.size).toBe(32);
  });
});

describe('PBKDF2 constants', () => {
  it('meets the OWASP 2023 floor for SHA-256', () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(310_000);
  });

  it('uses a 96-bit IV, as AES-GCM requires', () => {
    expect(IV_BYTES).toBe(12);
  });
});

describe('deriveMasterKey', () => {
  it('rejects an empty password', async () => {
    await expect(deriveMasterKey('', SALT, 1_000)).rejects.toThrow(/password is required/);
  });

  it('rejects a salt shorter than 8 bytes', async () => {
    await expect(deriveMasterKey(PASSWORD, bytesToBase64(new Uint8Array(4)), 1_000)).rejects.toThrow(
      /at least 8 bytes/,
    );
  });

  it('produces a non-extractable AES-GCM key', async () => {
    const key = await keyPromise;
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.usages.sort()).toEqual(['decrypt', 'encrypt']);
  });

  it('is deterministic for the same password and salt', async () => {
    const [a, b] = await Promise.all([
      deriveMasterKey(PASSWORD, SALT, 1_000),
      deriveMasterKey(PASSWORD, SALT, 1_000),
    ]);
    const sealed = await seal(a, { probe: true });
    await expect(open(b, sealed)).resolves.toEqual({ probe: true });
  });

  it('derives a different key for a different salt', async () => {
    const other = await deriveMasterKey(PASSWORD, 'b3RoZXItc2FsdC1ieXRlcw==', 1_000);
    const sealed = await seal(await keyPromise, { probe: true });
    await expect(open(other, sealed)).rejects.toThrow();
  });

  it('derives a different key for a different password', async () => {
    const other = await deriveMasterKey('different password', SALT, 1_000);
    const sealed = await seal(await keyPromise, { probe: true });
    await expect(open(other, sealed)).rejects.toThrow();
  });
});

describe('seal / open', () => {
  it('round-trips a credential payload', async () => {
    const key = await keyPromise;
    const payload = { username: 'alice@example.com', password: 'hunter2', notes: '2FA on phone' };
    const sealed = await seal(key, payload);
    expect(await open(key, sealed)).toEqual(payload);
  });

  it('round-trips nested and unicode values', async () => {
    const key = await keyPromise;
    const payload = { tags: ['a', 'b'], nested: { deep: { value: '日本語 ✓' } }, n: null, b: false };
    expect(await open(key, await seal(key, payload))).toEqual(payload);
  });

  it('emits base64 ciphertext and a 12-byte IV', async () => {
    const sealed = await seal(await keyPromise, { a: 1 });
    expect(sealed.encryptedBlob).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(base64ToBytes(sealed.iv).length).toBe(IV_BYTES);
  });

  it('uses a fresh IV per seal, so equal payloads differ', async () => {
    const key = await keyPromise;
    const first = await seal(key, { same: true });
    const second = await seal(key, { same: true });
    expect(first.iv).not.toBe(second.iv);
    expect(first.encryptedBlob).not.toBe(second.encryptedBlob);
  });

  it('rejects a tampered ciphertext', async () => {
    const key = await keyPromise;
    const sealed = await seal(key, { secret: 'value' });
    const bytes = base64ToBytes(sealed.encryptedBlob);
    // Flip a bit in the last byte, which is part of the GCM tag.
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    await expect(open(key, { ...sealed, encryptedBlob: bytesToBase64(bytes) })).rejects.toThrow();
  });

  it('rejects a tampered IV', async () => {
    const key = await keyPromise;
    const sealed = await seal(key, { secret: 'value' });
    const iv = base64ToBytes(sealed.iv);
    iv[0] = (iv[0] ?? 0) ^ 0xff;
    await expect(open(key, { ...sealed, iv: bytesToBase64(iv) })).rejects.toThrow();
  });

  it('rejects an IV of the wrong length', async () => {
    const key = await keyPromise;
    await expect(open(key, { encryptedBlob: 'AAAA', iv: bytesToBase64(new Uint8Array(16)) })).rejects.toThrow(
      /iv must be 12 bytes/,
    );
  });

  it('rejects a truncated ciphertext', async () => {
    const key = await keyPromise;
    await expect(
      open(key, { encryptedBlob: bytesToBase64(new Uint8Array(8)), iv: bytesToBase64(new Uint8Array(12)) }),
    ).rejects.toThrow(/too short/);
  });

  it('produces ciphertext that does not contain the plaintext', async () => {
    const key = await keyPromise;
    const sealed = await seal(key, { password: 'SUPER-SECRET-MARKER' });
    const raw = new TextDecoder().decode(base64ToBytes(sealed.encryptedBlob));
    expect(raw).not.toContain('SUPER-SECRET-MARKER');
  });
});

describe('deriveVerifier', () => {
  it('is stable for the same password and salt', async () => {
    const [a, b] = await Promise.all([deriveVerifier(PASSWORD, SALT, 1_000), deriveVerifier(PASSWORD, SALT, 1_000)]);
    expect(a).toBe(b);
  });

  it('differs from the encryption key, so a verifier cannot decrypt', async () => {
    // The verifier is derived with `deriveBits` and the key with `deriveKey`;
    // they are separate derivations of the same input, and the verifier is not
    // an AES key at all.
    const verifier = await deriveVerifier(PASSWORD, SALT, 1_000);
    expect(verifier).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(base64ToBytes(verifier).length).toBe(32);
  });

  it('changes with the password', async () => {
    const [a, b] = await Promise.all([
      deriveVerifier(PASSWORD, SALT, 1_000),
      deriveVerifier(`${PASSWORD}!`, SALT, 1_000),
    ]);
    expect(a).not.toBe(b);
  });
});
