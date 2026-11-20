/**
 * Per-account rate limiting — pure window arithmetic.
 *
 * The limiter is a **fixed window** counter: each `(scope, subject)` pair gets a
 * bucket per `windowMs` slice of wall-clock time. Fixed windows are chosen over
 * a sliding log because the whole cost is one integer read and one increment,
 * which matters when the thing being limited is `/proxy` itself. The trade-off
 * is the classic boundary burst: a caller can spend a full allowance at the end
 * of one window and another at the start of the next. `RATE_LIMITS` therefore
 * keeps windows short (10s) so the worst case is a brief, bounded spike rather
 * than a doubled sustained rate.
 *
 * Everything here is a pure function of its arguments so the policy can be
 * tested without D1, a clock, or a Worker.
 */

/** A limit: at most `limit` requests per `windowMs` per subject. */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * Tunable policy. `/proxy` is the expensive, abusable surface: every request is
 * an upstream fetch plus HTML rewriting, so it is limited per user. The token
 * mint is cheap but still per-user so a caller cannot farm unlimited tokens.
 */
export const RATE_LIMITS = {
  /** Page loads, subresources and form posts through the proxy. */
  proxy: { limit: 240, windowMs: 10_000 },
  /** Proxy-token minting for the sandbox origin. */
  proxyToken: { limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitScope = keyof typeof RATE_LIMITS;

/** The bucket a request falls into, plus what to tell the caller. */
export interface RateLimitDecision {
  /** Whether the request may proceed. */
  readonly allowed: boolean;
  /** The bucket key to increment (stable for the whole window). */
  readonly bucketKey: string;
  /** Start of the current window, epoch ms. */
  readonly windowStart: number;
  /** Remaining requests in this window *after* this one, floored at 0. */
  readonly remaining: number;
  /** Requests allowed per window. */
  readonly limit: number;
  /** Seconds until the window rolls over — the `Retry-After` value. */
  readonly retryAfterSeconds: number;
  /** Epoch ms at which the window resets. */
  readonly resetAt: number;
}

/** Start of the window containing `now`, aligned to absolute epoch multiples. */
export function windowStartFor(now: number, windowMs: number): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('windowMs must be a positive number');
  }
  return Math.floor(now / windowMs) * windowMs;
}

/** Stable bucket key. Subject is opaque; it must not contain `:`. */
export function bucketKeyFor(scope: RateLimitScope, subject: string, windowStart: number): string {
  if (subject === '' || subject.includes(':')) {
    throw new Error('subject must be a non-empty string without ":"');
  }
  return `${scope}:${subject}:${windowStart}`;
}

/**
 * Decide a request given the counter already stored for its bucket.
 *
 * `used` is the count *before* this request. The caller increments the stored
 * counter separately; passing the pre-increment value keeps this function pure
 * and lets the same math drive both the check and the `RateLimit-*` headers.
 *
 * A counter from a previous window (`used` from a stale bucket) must not count
 * against the new window, so the caller passes the counter for *this* window's
 * key — which is a fresh key every window by construction.
 */
export function decideRateLimit(
  scope: RateLimitScope,
  subject: string,
  used: number,
  now: number,
  rule: RateLimitRule = RATE_LIMITS[scope],
): RateLimitDecision {
  const windowStart = windowStartFor(now, rule.windowMs);
  const resetAt = windowStart + rule.windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  const safeUsed = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;

  return {
    allowed: safeUsed < rule.limit,
    bucketKey: bucketKeyFor(scope, subject, windowStart),
    windowStart,
    remaining: Math.max(0, rule.limit - safeUsed - 1),
    limit: rule.limit,
    retryAfterSeconds,
    resetAt,
  };
}

/**
 * Headers describing the caller's budget. Sent on *every* proxied response,
 * not only on 429, so a well-behaved client can back off before being blocked.
 */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    'ratelimit-limit': String(decision.limit),
    'ratelimit-remaining': String(decision.remaining),
    'ratelimit-reset': String(decision.retryAfterSeconds),
    'ratelimit-policy': `${decision.limit};w=${Math.round((decision.resetAt - decision.windowStart) / 1000)}`,
  };
}

/** A 429 body with `Retry-After`, kept separate so the shape is testable. */
export function rateLimitedResponse(decision: RateLimitDecision): Response {
  const headers = new Headers(rateLimitHeaders(decision));
  headers.set('retry-after', String(decision.retryAfterSeconds));
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(
    JSON.stringify({
      error: 'rate limit exceeded',
      scope: 'proxy',
      limit: decision.limit,
      retryAfterSeconds: decision.retryAfterSeconds,
    }),
    { status: 429, headers },
  );
}
