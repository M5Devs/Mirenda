/**
 * Scoped proxy tokens.
 *
 * Why this exists: when `mirenda-app` (UI + auth + vault) and
 * `mirenda-sandbox` (proxy + extension sandbox) run on different origins, the
 * session cookie cannot authenticate `/proxy`. The cookie is `SameSite=Lax` and
 * belongs to the app origin, so a cross-origin `GET` to the sandbox origin never
 * carries it. Weakening it to `SameSite=None` would hand the session to every
 * cross-site request — exactly the isolation this split is meant to create.
 *
 * Instead the app mints a short-lived **proxy token**: an HMAC-signed,
 * scope-limited credential that authorises `/proxy` for one `(user, profile)`
 * pair and nothing else. It is passed as a query parameter because it must
 * survive inside `iframe src`, `href` and `src` attributes that HTMLRewriter
 * rewrites into `/proxy` URLs.
 *
 * Properties that matter:
 *   - **Stateless.** No D1 row per token; verification is an HMAC compare. A
 *     page load fans out into dozens of subresource requests, so per-token
 *     storage would be the hot path.
 *   - **Narrow.** A token authorises proxying for one profile. It cannot read
 *     the vault, list tabs, or call any `/api/*` route.
 *   - **Short-lived.** Minutes, not days, and the app re-mints as needed.
 *   - **Bound to the target domain list implicitly** — not needed here because
 *     `/proxy` still re-checks profile ownership from the signed `sub`.
 *
 * The same-origin single-worker deployment also uses this path: it is simpler
 * to have one authentication route for `/proxy` than two, and it means the
 * local dev stack exercises the production code path.
 */

/** Claims carried in a proxy token. Deliberately minimal. */
export interface ProxyTokenClaims {
  /** User id. */
  sub: string;
  /** Profile id the token may proxy for. */
  pid: string;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Issued-at, epoch seconds. */
  iat: number;
}

const TOKEN_PREFIX = 'mpt1';
/** Tokens live five minutes: long enough for a page and its subresources. */
export const PROXY_TOKEN_TTL_SECONDS = 5 * 60;

function encoder(): TextEncoder {
  return new TextEncoder();
}

function webcrypto(): Crypto {
  return (globalThis as unknown as { crypto: Crypto }).crypto;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  try {
    const binary = atob(withPadding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return webcrypto().subtle.importKey(
    'raw',
    encoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Constant-time comparison for two equal-length byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

function signingInput(claims: ProxyTokenClaims): string {
  return `${TOKEN_PREFIX}.${base64UrlEncode(encoder().encode(JSON.stringify(claims)))}`;
}

/**
 * Mint a token. `secret` must be at least 32 characters; a short secret is
 * rejected rather than silently weakening the signature.
 */
export async function mintProxyToken(
  secret: string,
  userId: string,
  profileId: string,
  now: number = Date.now(),
  ttlSeconds: number = PROXY_TOKEN_TTL_SECONDS,
): Promise<string> {
  if (secret.length < 32) throw new Error('proxy token secret must be at least 32 characters');
  if (!userId || !profileId) throw new Error('userId and profileId are required');

  const iat = Math.floor(now / 1000);
  const claims: ProxyTokenClaims = { sub: userId, pid: profileId, iat, exp: iat + ttlSeconds };
  const input = signingInput(claims);
  const signature = await webcrypto().subtle.sign('HMAC', await hmacKey(secret), encoder().encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Why a token was rejected. Kept granular so the caller can log safely. */
export type ProxyTokenFailure = 'malformed' | 'bad-signature' | 'expired';

export type ProxyTokenResult =
  | { ok: true; claims: ProxyTokenClaims }
  | { ok: false; reason: ProxyTokenFailure };

/**
 * Verify a token and return its claims.
 *
 * Expiry is checked *after* the signature so an attacker cannot learn anything
 * from a tampered payload, and the returned claims are always the signed ones —
 * never values parsed out of an unverified segment.
 */
export async function verifyProxyToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<ProxyTokenResult> {
  if (secret.length < 32) throw new Error('proxy token secret must be at least 32 characters');

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: 'malformed' };
  const [, payloadB64, signatureB64] = parts;
  if (!payloadB64 || !signatureB64) return { ok: false, reason: 'malformed' };

  const signature = base64UrlDecode(signatureB64);
  if (!signature) return { ok: false, reason: 'malformed' };

  const expected = new Uint8Array(
    await webcrypto().subtle.sign('HMAC', await hmacKey(secret), encoder().encode(`${TOKEN_PREFIX}.${payloadB64}`)),
  );
  if (!timingSafeEqual(expected, signature)) return { ok: false, reason: 'bad-signature' };

  const payloadBytes = base64UrlDecode(payloadB64);
  if (!payloadBytes) return { ok: false, reason: 'malformed' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const claims = parsed as Partial<ProxyTokenClaims>;
  if (
    typeof claims.sub !== 'string' ||
    typeof claims.pid !== 'string' ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number' ||
    claims.sub === '' ||
    claims.pid === ''
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (claims.exp <= Math.floor(now / 1000)) return { ok: false, reason: 'expired' };

  return { ok: true, claims: claims as ProxyTokenClaims };
}

/**
 * Extract a token from a request. Query param first (iframe `src` and rewritten
 * links), then the `x-mirenda-proxy-token` header for `fetch` calls from the
 * sandbox that would rather not put it in a URL.
 */
export function proxyTokenFromRequest(url: URL, headers: Headers): string | null {
  const fromQuery = url.searchParams.get('pt');
  if (fromQuery) return fromQuery;
  const fromHeader = headers.get('x-mirenda-proxy-token');
  return fromHeader && fromHeader !== '' ? fromHeader : null;
}
