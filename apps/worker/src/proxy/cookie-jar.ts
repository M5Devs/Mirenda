/**
 * Virtual Cookie Jar — pure parsing, matching and merging rules.
 *
 * Cookies never touch Mirenda's own origin. A target site's `Set-Cookie` is
 * stripped from the upstream response, parsed here, and persisted keyed by
 * `(user_id, profile_id, target_domain)`. Stored cookies are re-injected only on
 * outgoing requests to the matching domain.
 */

/** A cookie as persisted in the jar. Mirrors the SDK's `MirendaCookie`. */
export interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix epoch milliseconds; absent means a session cookie. */
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** The jar key. Every read and write must be scoped by all three parts. */
export interface JarKey {
  userId: string;
  profileId: string;
  domain: string;
}

const MAX_COOKIE_NAME = 256;
const MAX_COOKIE_VALUE = 4096;
/** Browsers cap a jar at ~180 cookies per domain; we cap lower and evict oldest. */
export const MAX_COOKIES_PER_DOMAIN = 60;

/**
 * Parse one `Set-Cookie` header value. Returns `null` for malformed input or a
 * `Set-Cookie` with an empty name, which browsers also reject.
 */
export function parseSetCookie(header: string, requestUrl: string): JarCookie | null {
  const parts = splitCookieHeader(header);
  const [nameValue, ...attributes] = parts;
  if (!nameValue) return null;

  const eq = nameValue.indexOf('=');
  if (eq <= 0) return null;
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();
  if (name === '' || name.length > MAX_COOKIE_NAME) return null;
  if (value.length > MAX_COOKIE_VALUE) return null;

  const request = new URL(requestUrl);
  let domain = request.hostname.toLowerCase();
  let path = defaultPath(request.pathname);
  let expires: number | undefined;
  let maxAge: number | undefined;
  let httpOnly = false;
  let secure = false;
  let sameSite: JarCookie['sameSite'];

  for (const attribute of attributes) {
    const idx = attribute.indexOf('=');
    const key = (idx === -1 ? attribute : attribute.slice(0, idx)).trim().toLowerCase();
    const attrValue = idx === -1 ? '' : attribute.slice(idx + 1).trim();

    switch (key) {
      case 'domain': {
        const candidate = attrValue.replace(/^\./, '').toLowerCase();
        // Reject a domain the request URL is not actually part of: a hostile
        // response must not be able to plant cookies for another site.
        if (candidate && domainMatches(request.hostname.toLowerCase(), candidate)) {
          domain = candidate;
        }
        break;
      }
      case 'path':
        if (attrValue.startsWith('/')) path = attrValue;
        break;
      case 'expires': {
        const parsed = Date.parse(attrValue);
        if (!Number.isNaN(parsed)) expires = parsed;
        break;
      }
      case 'max-age': {
        const seconds = Number.parseInt(attrValue, 10);
        if (Number.isFinite(seconds)) maxAge = seconds;
        break;
      }
      case 'httponly':
        httpOnly = true;
        break;
      case 'secure':
        secure = true;
        break;
      case 'samesite': {
        const normalized = attrValue.toLowerCase();
        if (normalized === 'strict') sameSite = 'Strict';
        else if (normalized === 'lax') sameSite = 'Lax';
        else if (normalized === 'none') sameSite = 'None';
        break;
      }
      default:
        break;
    }
  }

  // `Max-Age` wins over `Expires` per RFC 6265 §5.3.
  if (maxAge !== undefined) {
    expires = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;
  }

  return { name, value, domain, path, expires, httpOnly, secure, sameSite };
}

/**
 * Split a `Set-Cookie` value on `;`, except inside an `Expires` date which
 * legitimately contains a comma and would be mangled by naive splitting.
 */
function splitCookieHeader(header: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inExpires = false;
  for (const char of header) {
    if (char === ';') {
      parts.push(current);
      current = '';
      inExpires = false;
      continue;
    }
    current += char;
    if (!inExpires && /^\s*expires\s*=/i.test(current)) inExpires = true;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

/** RFC 6265 §5.1.4 default-path algorithm. */
export function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const lastSlash = pathname.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return pathname.slice(0, lastSlash);
}

/**
 * Does a cookie's `Domain` attribute cover `hostname`? A leading dot is
 * ignored, and a subdomain match requires a label boundary.
 */
export function domainMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const target = domain.replace(/^\./, '').toLowerCase();
  if (host === target) return true;
  return host.endsWith(`.${target}`);
}

/** RFC 6265 §5.1.4 path-match. */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

/** Is the cookie still valid at `now` (ms)? Session cookies never expire. */
export function isFresh(cookie: JarCookie, now: number = Date.now()): boolean {
  return cookie.expires === undefined || cookie.expires > now;
}

/**
 * Cookies from `jar` that should be sent to `requestUrl`. HttpOnly cookies are
 * included: the worker is the server side of the jar and must send them.
 */
export function cookiesForRequest(jar: readonly JarCookie[], requestUrl: string, now: number = Date.now()): JarCookie[] {
  const url = new URL(requestUrl);
  const hostname = url.hostname.toLowerCase();
  const path = url.pathname || '/';
  const secure = url.protocol === 'https:';
  return jar.filter(
    (cookie) =>
      isFresh(cookie, now) &&
      domainMatches(hostname, cookie.domain) &&
      pathMatches(path, cookie.path) &&
      (!cookie.secure || secure),
  );
}

/** Build a `Cookie` request header value from matching cookies. */
export function buildCookieHeader(cookies: readonly JarCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/**
 * Merge newly received cookies into an existing jar for one domain.
 *
 * Identity is `(name, domain, path)` per RFC 6265. A received cookie replaces a
 * stored one; an expiry in the past deletes it. The result is capped at
 * `MAX_COOKIES_PER_DOMAIN`, evicting the soonest-to-expire first.
 */
export function mergeCookies(existing: readonly JarCookie[], incoming: readonly JarCookie[], now: number = Date.now()): JarCookie[] {
  const byKey = new Map<string, JarCookie>();
  for (const cookie of existing) {
    if (isFresh(cookie, now)) byKey.set(cookieKey(cookie), cookie);
  }
  for (const cookie of incoming) {
    const key = cookieKey(cookie);
    if (!isFresh(cookie, now)) {
      byKey.delete(key);
      continue;
    }
    byKey.set(key, cookie);
  }

  const merged = [...byKey.values()];
  if (merged.length <= MAX_COOKIES_PER_DOMAIN) return merged;

  merged.sort((a, b) => (a.expires ?? Number.MAX_SAFE_INTEGER) - (b.expires ?? Number.MAX_SAFE_INTEGER));
  return merged.slice(merged.length - MAX_COOKIES_PER_DOMAIN);
}

function cookieKey(cookie: JarCookie): string {
  return `${cookie.domain}|${cookie.path}|${cookie.name}`;
}

/**
 * Serialize a jar cookie back into a `Set-Cookie` header for the *target*
 * origin when it is replayed into the proxied document's own context. The
 * domain attribute is intentionally omitted so the cookie binds to the
 * proxied host the browser sees, never to Mirenda's host.
 */
export function serializeForDocument(cookie: JarCookie): string {
  const parts = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path}`];
  if (cookie.expires !== undefined) parts.push(`Expires=${new Date(cookie.expires).toUTCString()}`);
  if (cookie.secure) parts.push('Secure');
  if (cookie.sameSite) parts.push(`SameSite=${cookie.sameSite}`);
  return parts.join('; ');
}

/**
 * Read every `Set-Cookie` header from an upstream response.
 *
 * Read-only by design: `Response.headers` from `fetch` is immutable, so the
 * caller must build a fresh header map rather than mutating this one. Every
 * caller filters `set-cookie` out of what it returns to the client.
 *
 * `Headers.getSetCookie()` keeps repeated headers distinct; where the runtime
 * lacks it we fall back to the comma-folded `get()`, which is lossy for cookies
 * containing a comma but still keeps them out of the client response.
 */
export function readSetCookies(headers: Headers): string[] {
  const withMethod = headers as Headers & { getSetCookie?: () => string[] };
  const cookies =
    typeof withMethod.getSetCookie === 'function'
      ? withMethod.getSetCookie()
      : splitFoldedSetCookie(headers.get('set-cookie'));
  return cookies.filter((value) => value.trim() !== '');
}

/** Split a comma-folded `Set-Cookie` value on the comma before a cookie name. */
function splitFoldedSetCookie(value: string | null): string[] {
  if (!value) return [];
  // A comma only separates cookies when followed by `name=`; `Expires` dates
  // contain commas of their own.
  return value.split(/,(?=\s*[^;,=\s]+=)/).map((part) => part.trim());
}
