/**
 * Pure URL rewriting for the proxy. No Workers globals are used here so the
 * rules can be unit-tested directly in Node.
 */

/** Path the proxy is mounted at. Kept in one place so links and routes agree. */
export const PROXY_PATH = '/proxy';

export interface RewriteContext {
  /** Absolute URL of the proxied document. All relative refs resolve against it. */
  pageUrl: string;
  profileId: string;
  /** Override for tests or alternate mounts. */
  proxyPath?: string;
  /**
   * Scoped proxy token to carry on every rewritten URL.
   *
   * A proxied document fans out into dozens of subresource requests (`src`,
   * `href`, `srcset`, CSS `url()`), and in a split deployment each of those is a
   * fresh request to the sandbox origin with no session cookie. Without the
   * token on the rewritten URL every subresource would be refused, so the token
   * is threaded through the same rewrite that produces the URL.
   */
  proxyToken?: string;
}

/**
 * Schemes that must never be rewritten: they are not navigations through the
 * proxy, and wrapping them would break the page or leak a non-HTTP target.
 */
const PASSTHROUGH_SCHEME = /^(?:javascript|mailto|tel|sms|data|blob|about|chrome|file|magnet|intent):/i;

/** Attributes whose value is a single URL. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'data']);

/** Attributes whose value is a comma-separated candidate list. */
const SRCSET_ATTRIBUTES = new Set(['srcset', 'imagesrcset']);

/**
 * Named entities that legitimately appear in URLs. `&amp;` is by far the most
 * common — an HTML author must write `?a=1&amp;b=2` in a raw attribute — and it
 * is the one that silently corrupts a proxied query string if left encoded.
 */
const URL_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
  '#47': '/',
  nbsp: '\u00a0',
};

/**
 * Decode HTML character references in an attribute value.
 *
 * `HTMLRewriter` exposes attribute values exactly as they appear in the source,
 * so a URL written as `/w/load.php?lang=en&amp;modules=x` arrives still
 * escaped. Encoding that verbatim produces `%26amp%3B` and the upstream server
 * sees one nonsense parameter instead of `lang` + `modules` — which is how a
 * stylesheet ends up served empty. Decode before resolving.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name: string) => {
    const key = name.toLowerCase();
    const direct = URL_ENTITIES[key];
    if (direct !== undefined) return direct;
    if (key.startsWith('#')) {
      const code = key.startsWith('#x')
        ? Number.parseInt(key.slice(2), 16)
        : Number.parseInt(key.slice(1), 10);
      // Only decode printable ASCII; anything else is left alone so a stray
      // numeric reference cannot smuggle control characters into a URL.
      if (Number.isFinite(code) && code >= 0x20 && code < 0x7f) {
        return String.fromCharCode(code);
      }
    }
    return match;
  });
}

/**
 * Resolve `raw` against `base` and return an absolute http(s) URL, or `null`
 * when the reference should be left untouched.
 *
 * `raw` is expected to be already decoded when it came from an HTML attribute;
 * see `resolveAttributeUrl`.
 */
export function resolveTargetUrl(raw: string, base: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  if (PASSTHROUGH_SCHEME.test(value)) return null;
  // A bare fragment only scrolls within the document; proxying it loses the page.
  if (value.startsWith('#')) return null;
  let resolved: URL;
  try {
    resolved = new URL(value, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  return resolved.toString();
}

/**
 * Resolve a URL taken from an HTML attribute. Attribute text arrives
 * entity-escaped from `HTMLRewriter`, so it is decoded first; CSS text does
 * *not* go through here, because entities are not interpreted inside a
 * stylesheet and decoding them there would corrupt a literal `&amp;`.
 */
export function resolveAttributeUrl(raw: string, base: string): string | null {
  return resolveTargetUrl(decodeHtmlEntities(raw), base);
}

/** Wrap an absolute target URL in a `/proxy` request for `profileId`. */
export function proxify(target: string, ctx: RewriteContext): string {
  const path = ctx.proxyPath ?? PROXY_PATH;
  const params = new URLSearchParams({ url: target, profileId: ctx.profileId });
  if (ctx.proxyToken) params.set('pt', ctx.proxyToken);
  return `${path}?${params.toString()}`;
}

/**
 * Rewrite one attribute value. Returns the original string when the value is
 * not a rewritable URL (so callers can write it back unconditionally).
 */
export function rewriteUrlAttribute(value: string, ctx: RewriteContext): string {
  const target = resolveAttributeUrl(value, ctx.pageUrl);
  if (!target) return value;
  return proxify(target, ctx);
}

/**
 * Split a `srcset` value into candidates following the HTML spec's parsing
 * rules closely enough to be safe: a URL token runs until whitespace, and a
 * trailing comma terminates the candidate immediately.
 *
 * A naive `split(',')` corrupts `data:` URLs, whose payload legitimately
 * contains commas, so this parser tracks the URL/descriptor boundary instead.
 */
function splitSrcset(value: string): Array<{ url: string; descriptors: string }> {
  const candidates: Array<{ url: string; descriptors: string }> = [];
  let index = 0;

  while (index < value.length) {
    // Skip leading whitespace and stray commas.
    while (index < value.length && /[\s,]/.test(value[index] ?? '')) index += 1;
    if (index >= value.length) break;

    // URL token: everything up to whitespace.
    const urlStart = index;
    while (index < value.length && !/\s/.test(value[index] ?? '')) index += 1;
    let url = value.slice(urlStart, index);

    // A URL ending in comma(s) has no descriptors and ends the candidate.
    const trailingCommas = url.length - url.replace(/,+$/, '').length;
    if (trailingCommas > 0) {
      url = url.slice(0, url.length - trailingCommas);
      if (url !== '') candidates.push({ url, descriptors: '' });
      continue;
    }

    // Descriptors run until a comma outside parentheses.
    const descriptorStart = index;
    let depth = 0;
    while (index < value.length) {
      const char = value[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth = Math.max(0, depth - 1);
      else if (char === ',' && depth === 0) break;
      index += 1;
    }
    const descriptors = value.slice(descriptorStart, index).trim().replace(/\s+/g, ' ');
    if (url !== '') candidates.push({ url, descriptors });
    index += 1; // consume the separating comma
  }

  return candidates;
}

/**
 * Rewrite a `srcset` value, preserving each candidate's descriptor
 * (`1x`, `640w`, ...). Candidates that are not rewritable are kept as-is.
 */
export function rewriteSrcset(value: string, ctx: RewriteContext): string {
  return splitSrcset(value)
    .map(({ url, descriptors }) => {
      const target = resolveAttributeUrl(url, ctx.pageUrl);
      const rewritten = target ? proxify(target, ctx) : url;
      return descriptors === '' ? rewritten : `${rewritten} ${descriptors}`;
    })
    .join(', ');
}

/**
 * Rewrite `url(...)` references inside a CSS declaration block or stylesheet.
 * Quoted and unquoted forms are both handled.
 *
 * `url()` is also how `@font-face`, `background-image` and `cursor` reach
 * their files, so this covers every subresource a stylesheet pulls in except
 * `@import`, which `rewriteCssImports` handles.
 */
export function rewriteCssUrls(css: string, ctx: RewriteContext): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote: string, rawUrl: string) => {
    const target = resolveTargetUrl(rawUrl, ctx.pageUrl);
    if (!target) return match;
    return `url(${quote}${proxify(target, ctx)}${quote})`;
  });
}

/**
 * Rewrite `@import "..."` / `@import url(...)` statements.
 *
 * `@import` takes a bare string, which the `url()` pass does not see. Media
 * queries after the URL are preserved. `url(...)` imports are left to
 * `rewriteCssUrls` so they are not rewritten twice.
 */
export function rewriteCssImports(css: string, ctx: RewriteContext): string {
  return css.replace(
    /@import\s+(['"])([^'"]+)\1/gi,
    (match, quote: string, rawUrl: string) => {
      const target = resolveTargetUrl(rawUrl, ctx.pageUrl);
      if (!target) return match;
      return `@import ${quote}${proxify(target, ctx)}${quote}`;
    },
  );
}

/**
 * Full stylesheet rewrite: `@import` first (it matches a superset of the
 * `url()` pattern only for the string form, so order is safe either way), then
 * `url(...)`.
 */
export function rewriteStylesheet(css: string, ctx: RewriteContext): string {
  return rewriteCssUrls(rewriteCssImports(css, ctx), ctx);
}

/**
 * Extract the upstream target from a value that is already a proxy URL.
 *
 * The client-side runtime and the GET-form handler both need this: a form's
 * `action` has usually already been rewritten to `/proxy?url=...` by the HTML
 * pass, and appending `?q=...` to *that* would clobber the proxy's own query
 * string — the classic "search box wipes the proxy params" bug.
 */
export function extractProxyTarget(value: string, proxyPath: string = PROXY_PATH): string | null {
  const prefix = `${proxyPath}?`;
  if (!value.startsWith(prefix)) return null;
  try {
    const params = new URLSearchParams(value.slice(prefix.length));
    return params.get('url');
  } catch {
    return null;
  }
}

/**
 * Build the absolute upstream URL a `GET` form submission should navigate to.
 *
 * `action` may be a raw attribute (`/search`), an absolute URL, or an
 * already-proxied URL. In every case the fields become the target's query
 * string, merged with any query the action already carries.
 */
export function buildGetFormUrl(
  action: string,
  currentUrl: string,
  entries: ReadonlyArray<readonly [string, string]>,
  proxyPath: string = PROXY_PATH,
): string | null {
  const proxied = extractProxyTarget(action, proxyPath);
  const base = proxied ?? resolveTargetUrl(action === '' ? currentUrl : action, currentUrl);
  if (!base) return null;

  let target: URL;
  try {
    target = new URL(base);
  } catch {
    return null;
  }
  for (const [name, value] of entries) target.searchParams.append(name, value);
  return target.toString();
}

/** True when `name` carries a URL that `rewriteAttribute` handles. */
export function isUrlAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  return URL_ATTRIBUTES.has(lower) || SRCSET_ATTRIBUTES.has(lower);
}

/** Rewrite a single attribute by name, dispatching on the attribute kind. */
export function rewriteAttribute(name: string, value: string, ctx: RewriteContext): string {
  const lower = name.toLowerCase();
  if (SRCSET_ATTRIBUTES.has(lower)) return rewriteSrcset(value, ctx);
  if (URL_ATTRIBUTES.has(lower)) return rewriteUrlAttribute(value, ctx);
  return value;
}

/**
 * Normalize a user-supplied proxy target. Returns `null` unless the value is an
 * absolute http(s) URL, so `/proxy?url=file:///etc/passwd` can never be fetched.
 */
export function parseProxyTarget(raw: string | null): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.toString();
}

/** Hostname used as the Virtual Cookie Jar key. Lowercased, port-free. */
export function targetDomainOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}
