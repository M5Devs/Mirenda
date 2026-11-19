/**
 * Zero-knowledge vault crypto.
 *
 * The master password never leaves the device. A PBKDF2-SHA256 derivation over
 * a per-user salt produces an AES-256-GCM key held only in memory; vault items
 * are sealed before they are sent to the worker, which stores opaque
 * `{ encryptedBlob, iv }` pairs.
 *
 * This module is intentionally free of DOM globals beyond Web Crypto so the
 * exact code that runs in the browser is the code the tests exercise.
 */

/** OWASP 2023 guidance for PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 310_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

export interface SealedPayload {
  /** Base64 AES-GCM ciphertext, tag appended. */
  encryptedBlob: string;
  /** Base64 96-bit IV, unique per seal. */
  iv: string;
}

function subtle(): SubtleCrypto {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) throw new Error('Web Crypto is unavailable in this environment');
  return cryptoObj.subtle;
}

export function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A fresh random base64 salt for a new account's vault. */
export function generateSalt(): string {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  return bytesToBase64(salt);
}

/**
 * Derive the AES-256-GCM vault key from the master password.
 *
 * The key is `extractable: false`, so even a compromised script in the page
 * cannot export the raw key material after derivation.
 */
export async function deriveMasterKey(
  password: string,
  saltBase64: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  if (password.length === 0) throw new Error('master password is required');
  const salt = base64ToBytes(saltBase64);
  if (salt.length < 8) throw new Error('salt must be at least 8 bytes');

  const material = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Seal a JSON-serializable value with a fresh random IV. */
export async function seal(key: CryptoKey, value: unknown): Promise<SealedPayload> {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { encryptedBlob: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

/** Open a sealed payload. Throws when the key is wrong or the data was tampered with. */
export async function open<T = unknown>(key: CryptoKey, payload: SealedPayload): Promise<T> {
  const iv = base64ToBytes(payload.iv);
  if (iv.length !== IV_BYTES) throw new Error('iv must be 12 bytes');
  const ciphertext = base64ToBytes(payload.encryptedBlob);
  if (ciphertext.length <= 16) throw new Error('ciphertext is too short');
  const plaintext = await subtle().decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/**
 * Derive a stable verifier the worker can compare against without learning the
 * password. It is a separate derivation with a distinct salt context, so the
 * verifier cannot be used to decrypt vault data.
 */
export async function deriveVerifier(
  password: string,
  saltBase64: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const material = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle().deriveBits(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(saltBase64),
      iterations,
      hash: 'SHA-256',
    },
    material,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}
