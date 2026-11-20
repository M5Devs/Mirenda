import { describe, expect, it } from 'vitest';
import {
  RATE_LIMITS,
  bucketKeyFor,
  decideRateLimit,
  rateLimitHeaders,
  rateLimitedResponse,
  windowStartFor,
} from '../src/lib/rate-limit.js';

describe('windowStartFor', () => {
  it('aligns to absolute epoch multiples, not to first use', () => {
    expect(windowStartFor(0, 10_000)).toBe(0);
    expect(windowStartFor(9_999, 10_000)).toBe(0);
    expect(windowStartFor(10_000, 10_000)).toBe(10_000);
    expect(windowStartFor(15_500, 10_000)).toBe(10_000);
  });

  it('rejects a non-positive window', () => {
    expect(() => windowStartFor(1, 0)).toThrow();
    expect(() => windowStartFor(1, -5)).toThrow();
    expect(() => windowStartFor(1, Number.NaN)).toThrow();
  });
});

describe('bucketKeyFor', () => {
  it('encodes scope, subject and window so each window is a fresh key', () => {
    expect(bucketKeyFor('proxy', 'user-1', 0)).toBe('proxy:user-1:0');
    expect(bucketKeyFor('proxy', 'user-1', 10_000)).toBe('proxy:user-1:10000');
  });

  it('refuses a subject containing a colon, which would make keys ambiguous', () => {
    expect(() => bucketKeyFor('proxy', 'a:b', 0)).toThrow();
    expect(() => bucketKeyFor('proxy', '', 0)).toThrow();
  });
});

describe('decideRateLimit', () => {
  const rule = RATE_LIMITS.proxy;

  it('allows the first request and reports the remaining budget', () => {
    const decision = decideRateLimit('proxy', 'u1', 0, 1_000);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(rule.limit - 1);
    expect(decision.limit).toBe(rule.limit);
  });

  it('blocks once the counter reaches the limit', () => {
    const decision = decideRateLimit('proxy', 'u1', rule.limit, 1_000);
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('treats a negative or non-finite counter as zero rather than over-blocking', () => {
    expect(decideRateLimit('proxy', 'u1', -10, 1_000).allowed).toBe(true);
    expect(decideRateLimit('proxy', 'u1', Number.NaN, 1_000).allowed).toBe(true);
  });

  it('never reports negative remaining', () => {
    const decision = decideRateLimit('proxy', 'u1', rule.limit + 500, 1_000);
    expect(decision.remaining).toBe(0);
  });

  it('gives a different bucket in the next window', () => {
    const now = 1_000;
    const first = decideRateLimit('proxy', 'u1', 0, now);
    const later = decideRateLimit('proxy', 'u1', 0, now + rule.windowMs);
    expect(first.bucketKey).not.toBe(later.bucketKey);
    expect(later.allowed).toBe(true);
  });

  it('reports retryAfter of at most one window', () => {
    const now = 1_000;
    const decision = decideRateLimit('proxy', 'u1', rule.limit, now);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(Math.ceil(rule.windowMs / 1000));
    expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('keeps scopes independent, so proxy traffic cannot exhaust the token budget', () => {
    const proxy = decideRateLimit('proxy', 'u1', 0, 1_000);
    const token = decideRateLimit('proxyToken', 'u1', 0, 1_000);
    expect(proxy.bucketKey).not.toBe(token.bucketKey);
    expect(token.limit).toBe(RATE_LIMITS.proxyToken.limit);
  });
});

describe('rateLimitHeaders', () => {
  it('advertises the budget on successful responses too', () => {
    const headers = rateLimitHeaders(decideRateLimit('proxy', 'u1', 3, 1_000));
    expect(headers['ratelimit-limit']).toBe(String(RATE_LIMITS.proxy.limit));
    expect(headers['ratelimit-remaining']).toBe(String(RATE_LIMITS.proxy.limit - 4));
    expect(headers['ratelimit-policy']).toMatch(/^\d+;w=\d+$/);
  });
});

describe('rateLimitedResponse', () => {
  it('is a 429 with Retry-After and a JSON body', async () => {
    const decision = decideRateLimit('proxy', 'u1', RATE_LIMITS.proxy.limit, 1_000);
    const response = rateLimitedResponse(decision);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe(String(decision.retryAfterSeconds));
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { error: string; limit: number };
    expect(body.error).toBe('rate limit exceeded');
    expect(body.limit).toBe(RATE_LIMITS.proxy.limit);
  });
});
