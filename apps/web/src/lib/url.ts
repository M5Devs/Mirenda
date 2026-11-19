/**
 * Address-bar input normalization. Pure and DOM-free so it is unit tested.
 */

/** Search engine used when the input is not a URL. */
export const SEARCH_TEMPLATE = 'https://duckduckgo.com/?q=%s';

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/**
 * `host:port` looks exactly like `scheme:rest` to a naive check, so a host
 * followed by a numeric port is detected before scheme handling.
 */
const HOST_WITH_PORT = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[^\s/?#:]+\.[a-z]{2,}):\d{1,5}(?:[/?#].*)?$/i;
/** Looks like a hostname: a dot with a plausible TLD, or localhost. */
const LOOKS_LIKE_HOST = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[^\s/?#]+\.[a-z]{2,})(?::\d+)?(?:[/?#].*)?$/i;
/** Hosts that are never reachable over TLS. */
const PLAIN_HTTP_HOST = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?$/i;

/**
 * Turn whatever the user typed into an absolute http(s) URL to proxy.
 *
 * - `example.com`          → `https://example.com/`
 * - `http://example.com`   → unchanged
 * - `localhost:3000`       → `http://localhost:3000/`
 * - `how to cook rice`     → a search URL
 *
 * Returns `null` for input that cannot become a navigation target.
 */
export function normalizeAddressInput(raw: string): string | null {
  const input = raw.trim();
  if (input === '') return null;

  // A bare `host:port` must be handled before scheme detection.
  if (HOST_WITH_PORT.test(input) || !HAS_SCHEME.test(input)) {
    if (LOOKS_LIKE_HOST.test(input)) {
      const scheme = PLAIN_HTTP_HOST.test(input) ? 'http' : 'https';
      try {
        return new URL(`${scheme}://${input}`).toString();
      } catch {
        return null;
      }
    }
  }

  if (HAS_SCHEME.test(input)) {
    try {
      const url = new URL(input);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  return SEARCH_TEMPLATE.replace('%s', encodeURIComponent(input));
}

/** Display form of a URL: drop the scheme and a trailing slash on the root. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host;
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${host}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

/** Origin shown as the viewport's security label. */
export function originOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Extract the proxied target from a `/proxy?url=...` URL, for the address bar
 * when the viewport navigates internally.
 */
export function targetFromProxyUrl(value: string): string | null {
  try {
    const parsed = new URL(value, 'https://placeholder.invalid');
    if (parsed.pathname !== '/proxy') return null;
    const target = parsed.searchParams.get('url');
    return target ? target : null;
  } catch {
    return null;
  }
}
