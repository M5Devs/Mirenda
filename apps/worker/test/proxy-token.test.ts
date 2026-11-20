import { describe, expect, it } from 'vitest';
import {
  PROXY_TOKEN_TTL_SECONDS,
  mintProxyToken,
  proxyTokenFromRequest,
  timingSafeEqual,
  verifyProxyToken,
} from '../src/auth/proxy-token.js';

const SECRET = 'a'.repeat(40);

describe('mintProxyToken', () => {
  it('produces a three-part token with the mpt1 prefix', async () => {
    const token = await mintProxyToken(SECRET, 'user-1', 'profile-1');
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('mpt1');
  });

  it('refuses a short secret instead of weakening the signature', async () => {
    await expect(mintProxyToken('short', 'u', 'p')).rejects.toThrow(/32 characters/);
  });

  it('refuses empty ids', async () => {
    await expect(mintProxyToken(SECRET, '', 'p')).rejects.toThrow();
    await expect(mintProxyToken(SECRET, 'u', '')).rejects.toThrow();
  });

  it('is deterministic for the same inputs and clock', async () => {
    const a = await mintProxyToken(SECRET, 'u1', 'p1', 1_000_000);
    const b = await mintProxyToken(SECRET, 'u1', 'p1', 1_000_000);
    expect(a).toBe(b);
  });

  it('differs across users, profiles, and time', async () => {
    const base = await mintProxyToken(SECRET, 'u1', 'p1', 1_000_000);
    expect(await mintProxyToken(SECRET, 'u2', 'p1', 1_000_000)).not.toBe(base);
    expect(await mintProxyToken(SECRET, 'u1', 'p2', 1_000_000)).not.toBe(base);
    expect(await mintProxyToken(SECRET, 'u1', 'p1', 2_000_000)).not.toBe(base);
  });
});

describe('verifyProxyToken', () => {
  it('round-trips the claims', async () => {
    const now = 1_700_000_000_000;
    const token = await mintProxyToken(SECRET, 'user-9', 'profile-9', now);
    const result = await verifyProxyToken(SECRET, token, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sub).toBe('user-9');
    expect(result.claims.pid).toBe('profile-9');
    expect(result.claims.exp).toBe(result.claims.iat + PROXY_TOKEN_TTL_SECONDS);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await mintProxyToken(SECRET, 'u1', 'p1');
    const result = await verifyProxyToken('b'.repeat(40), token);
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a tampered payload', async () => {
    const token = await mintProxyToken(SECRET, 'u1', 'p1');
    const [prefix, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin', pid: 'x', iat: 0, exp: 9_999_999_999 }))
      .toString('base64url');
    const result = await verifyProxyToken(SECRET, `${prefix}.${forgedPayload}.${signature}`);
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an expired token', async () => {
    const issued = 1_700_000_000_000;
    const token = await mintProxyToken(SECRET, 'u1', 'p1', issued);
    const afterExpiry = issued + (PROXY_TOKEN_TTL_SECONDS + 1) * 1000;
    const result = await verifyProxyToken(SECRET, token, afterExpiry);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts a token right up to its expiry', async () => {
    const issued = 1_700_000_000_000;
    const token = await mintProxyToken(SECRET, 'u1', 'p1', issued);
    const atExpiry = issued + (PROXY_TOKEN_TTL_SECONDS - 1) * 1000;
    expect((await verifyProxyToken(SECRET, token, atExpiry)).ok).toBe(true);
  });

  it('rejects malformed tokens without throwing', async () => {
    for (const bad of ['', 'x', 'mpt1.x', 'mpt2.a.b', 'mpt1..', 'mpt1.!!!.???', 'a.b.c.d']) {
      const result = await verifyProxyToken(SECRET, bad);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a wrong-prefix token even with a valid signature shape', async () => {
    const token = await mintProxyToken(SECRET, 'u1', 'p1');
    const tampered = token.replace(/^mpt1\./, 'mpt2.');
    expect((await verifyProxyToken(SECRET, tampered)).ok).toBe(false);
  });

  it('rejects claims that are structurally incomplete', async () => {
    // Sign a payload that parses but lacks required fields.
    const payload = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url');
    const input = `mpt1.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input)));
    const signature = Buffer.from(sig).toString('base64url');
    const result = await verifyProxyToken(SECRET, `${input}.${signature}`);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('proxyTokenFromRequest', () => {
  it('prefers the query parameter', () => {
    const url = new URL('https://sandbox.example/proxy?url=https%3A%2F%2Fa.com&pt=abc');
    expect(proxyTokenFromRequest(url, new Headers())).toBe('abc');
  });

  it('falls back to the header', () => {
    const url = new URL('https://sandbox.example/proxy?url=https%3A%2F%2Fa.com');
    const headers = new Headers({ 'x-mirenda-proxy-token': 'hdr-token' });
    expect(proxyTokenFromRequest(url, headers)).toBe('hdr-token');
  });

  it('returns null when neither is present or the header is blank', () => {
    const url = new URL('https://sandbox.example/proxy');
    expect(proxyTokenFromRequest(url, new Headers())).toBeNull();
    expect(proxyTokenFromRequest(url, new Headers({ 'x-mirenda-proxy-token': '' }))).toBeNull();
  });
});

describe('timingSafeEqual', () => {
  it('compares equal and unequal arrays', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});
