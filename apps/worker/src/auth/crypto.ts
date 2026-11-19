/**
 * Password hashing and session tokens, using only Web Crypto (available in
 * Workers and Node 20+).
 *
 * Passwords are hashed with PBKDF2-SHA256 at a high iteration count. Session
 * tokens are random 32-byte values; only their SHA-256 is stored, so a database
 * leak cannot be replayed as a live session.
 */

const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function webcrypto(): Crypto {
  // `crypto` is a global in Workers; read it explicitly so the module also works
  // under Node 20+, where it is `globalThis.crypto`.
  return (globalThis as unknown as { crypto: Crypto }).crypto;
}

function subtle(): SubtleCrypto {
  return webcrypto().subtle;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBase64(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  webcrypto().getRandomValues(bytes);
  return toBase64(bytes);
}

async function pbkdf2(password: string, saltBase64: string, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', salt: fromBase64(saltBase64), iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** Hash a password with a fresh random salt. */
export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBase64(SALT_BYTES);
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return { hash: toBase64(derived), salt };
}

/** Constant-time comparison of two base64 digests. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a password against a stored hash and salt. */
export async function verifyPassword(password: string, storedHash: string, salt: string): Promise<boolean> {
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return timingSafeEqual(toBase64(derived), storedHash);
}

/** Mint an opaque session token. Returns the plaintext and its storable hash. */
export async function createSessionToken(): Promise<{ token: string; tokenHash: string }> {
  const token = randomBase64(TOKEN_BYTES);
  return { token, tokenHash: await sha256Base64(token) };
}

export async function sha256Base64(value: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', new TextEncoder().encode(value));
  return toBase64(new Uint8Array(digest));
}

export const PASSWORD_MIN_LENGTH = 10;

/** Validate an email without accepting obviously hostile input. */
export function isValidEmail(email: string): boolean {
  if (email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
