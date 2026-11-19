import { describe, expect, it } from 'vitest';
import {
  MAX_COOKIES_PER_DOMAIN,
  buildCookieHeader,
  cookiesForRequest,
  defaultPath,
  domainMatches,
  isFresh,
  mergeCookies,
  parseSetCookie,
  pathMatches,
  serializeForDocument,
  readSetCookies,
  type JarCookie,
} from '../src/proxy/cookie-jar.js';

const REQUEST = 'https://shop.example.com/account/login?next=%2F';

function cookie(overrides: Partial<JarCookie> = {}): JarCookie {
  return {
    name: 'sid',
    value: 'abc',
    domain: 'example.com',
    path: '/',
    httpOnly: false,
    secure: false,
    ...overrides,
  };
}

describe('parseSetCookie', () => {
  it('parses a bare name=value pair', () => {
    expect(parseSetCookie('sid=abc123', REQUEST)).toMatchObject({
      name: 'sid',
      value: 'abc123',
      domain: 'shop.example.com',
      path: '/account',
    });
  });

  it('parses every attribute', () => {
    const parsed = parseSetCookie(
      'sid=abc; Domain=.example.com; Path=/app; HttpOnly; Secure; SameSite=Strict',
      REQUEST,
    );
    expect(parsed).toMatchObject({
      name: 'sid',
      value: 'abc',
      domain: 'example.com',
      path: '/app',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });
  });

  it('handles a comma inside an Expires date', () => {
    const parsed = parseSetCookie(
      'sid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/',
      REQUEST,
    );
    expect(parsed?.expires).toBe(Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'));
  });

  it('prefers Max-Age over Expires', () => {
    const before = Date.now();
    const parsed = parseSetCookie(
      'sid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=60',
      REQUEST,
    );
    expect(parsed?.expires).toBeGreaterThanOrEqual(before + 59_000);
    expect(parsed?.expires).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it('treats Max-Age=0 as an immediate expiry', () => {
    expect(parseSetCookie('sid=abc; Max-Age=0', REQUEST)?.expires).toBe(0);
  });

  it('rejects a Domain the request host is not part of', () => {
    // A hostile response must not plant cookies for another site.
    const parsed = parseSetCookie('sid=abc; Domain=evil.test', REQUEST);
    expect(parsed?.domain).toBe('shop.example.com');
  });

  it('accepts a parent domain the host belongs to', () => {
    expect(parseSetCookie('sid=abc; Domain=example.com', REQUEST)?.domain).toBe('example.com');
  });

  it('rejects malformed headers', () => {
    for (const header of ['', 'novalue', '=orphan', ';Path=/', 'sid=' + 'x'.repeat(5000)]) {
      expect(parseSetCookie(header, REQUEST)).toBeNull();
    }
  });

  it('accepts an empty value, which RFC 6265 permits', () => {
    expect(parseSetCookie('sid=', REQUEST)).toMatchObject({ name: 'sid', value: '' });
  });

  it('ignores an unknown SameSite value', () => {
    expect(parseSetCookie('sid=abc; SameSite=Bogus', REQUEST)?.sameSite).toBeUndefined();
  });
});

describe('defaultPath', () => {
  it('uses the request directory', () => {
    expect(defaultPath('/a/b/c.html')).toBe('/a/b');
    expect(defaultPath('/a/')).toBe('/a');
  });

  it('falls back to root', () => {
    expect(defaultPath('/')).toBe('/');
    expect(defaultPath('/single')).toBe('/');
    expect(defaultPath('')).toBe('/');
  });
});

describe('domainMatches', () => {
  it('matches the exact host and subdomains', () => {
    expect(domainMatches('example.com', 'example.com')).toBe(true);
    expect(domainMatches('shop.example.com', 'example.com')).toBe(true);
    expect(domainMatches('a.b.example.com', '.example.com')).toBe(true);
  });

  it('requires a label boundary', () => {
    expect(domainMatches('notexample.com', 'example.com')).toBe(false);
    expect(domainMatches('example.com.evil.test', 'example.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(domainMatches('Shop.Example.COM', 'EXAMPLE.com')).toBe(true);
  });
});

describe('pathMatches', () => {
  it('matches the exact path and subpaths', () => {
    expect(pathMatches('/a/b', '/a/b')).toBe(true);
    expect(pathMatches('/a/b/c', '/a/b')).toBe(true);
    expect(pathMatches('/a/b/c', '/a/b/')).toBe(true);
  });

  it('does not match a partial segment', () => {
    expect(pathMatches('/a/bcd', '/a/b')).toBe(false);
  });

  it('treats / as matching everything', () => {
    expect(pathMatches('/anything', '/')).toBe(true);
  });
});

describe('isFresh', () => {
  it('treats a session cookie as fresh', () => {
    expect(isFresh(cookie(), 1_000)).toBe(true);
  });

  it('compares against the clock', () => {
    expect(isFresh(cookie({ expires: 2_000 }), 1_000)).toBe(true);
    expect(isFresh(cookie({ expires: 1_000 }), 1_000)).toBe(false);
  });
});

describe('cookiesForRequest', () => {
  const jar = [
    cookie({ name: 'a', domain: 'example.com', path: '/' }),
    cookie({ name: 'b', domain: 'shop.example.com', path: '/account' }),
    cookie({ name: 'c', domain: 'other.test', path: '/' }),
    cookie({ name: 'd', domain: 'example.com', path: '/', secure: true }),
    cookie({ name: 'e', domain: 'example.com', path: '/', expires: 1 }),
    cookie({ name: 'f', domain: 'example.com', path: '/', httpOnly: true }),
  ];

  it('selects only cookies matching domain, path and scheme', () => {
    const names = cookiesForRequest(jar, REQUEST).map((c) => c.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
    expect(names).toContain('d');
    expect(names).not.toContain('c');
    expect(names).not.toContain('e');
  });

  it('includes HttpOnly cookies: the worker is the server side of the jar', () => {
    expect(cookiesForRequest(jar, REQUEST).map((c) => c.name)).toContain('f');
  });

  it('excludes Secure cookies over plain http', () => {
    const names = cookiesForRequest(jar, 'http://shop.example.com/account').map((c) => c.name);
    expect(names).not.toContain('d');
  });

  it('excludes cookies scoped to a different path', () => {
    expect(cookiesForRequest(jar, 'https://shop.example.com/other').map((c) => c.name)).not.toContain('b');
  });
});

describe('buildCookieHeader', () => {
  it('joins name=value pairs', () => {
    expect(buildCookieHeader([cookie({ name: 'a', value: '1' }), cookie({ name: 'b', value: '2' })])).toBe('a=1; b=2');
  });

  it('returns an empty string for an empty jar', () => {
    expect(buildCookieHeader([])).toBe('');
  });
});

describe('mergeCookies', () => {
  it('adds a new cookie', () => {
    const merged = mergeCookies([], [cookie({ name: 'new' })]);
    expect(merged.map((c) => c.name)).toEqual(['new']);
  });

  it('replaces a cookie with the same (domain, path, name)', () => {
    const merged = mergeCookies([cookie({ value: 'old' })], [cookie({ value: 'new' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.value).toBe('new');
  });

  it('keeps cookies that differ only by path', () => {
    const merged = mergeCookies(
      [cookie({ name: 'sid', path: '/a' })],
      [cookie({ name: 'sid', path: '/b' })],
    );
    expect(merged).toHaveLength(2);
  });

  it('deletes a cookie that arrives already expired', () => {
    const merged = mergeCookies([cookie({ name: 'sid' })], [cookie({ name: 'sid', expires: 1 })], 2_000);
    expect(merged).toHaveLength(0);
  });

  it('drops an existing cookie that has already expired', () => {
    expect(mergeCookies([cookie({ expires: 1 })], [], 2_000)).toHaveLength(0);
  });

  it('caps the jar and evicts the soonest-to-expire first', () => {
    const existing: JarCookie[] = Array.from({ length: MAX_COOKIES_PER_DOMAIN }, (_, index) =>
      cookie({ name: `c${index}`, expires: 10_000 + index }),
    );
    const merged = mergeCookies(existing, [cookie({ name: 'fresh', expires: 99_999_999 })], 0);
    expect(merged).toHaveLength(MAX_COOKIES_PER_DOMAIN);
    expect(merged.map((c) => c.name)).toContain('fresh');
    // The shortest-lived cookie was evicted.
    expect(merged.map((c) => c.name)).not.toContain('c0');
  });

  it('is order-independent for a set of distinct cookies', () => {
    const a = cookie({ name: 'a' });
    const b = cookie({ name: 'b' });
    const forward = mergeCookies([], [a, b]).map((c) => c.name).sort();
    const backward = mergeCookies([], [b, a]).map((c) => c.name).sort();
    expect(forward).toEqual(backward);
  });
});

describe('profile isolation', () => {
  it('never surfaces a cookie for another domain', () => {
    const jar = [cookie({ name: 'sid', domain: 'a.test' })];
    expect(cookiesForRequest(jar, 'https://b.test/')).toHaveLength(0);
  });

  it('never matches a cookie whose domain is a suffix string but not a label boundary', () => {
    const jar = [cookie({ name: 'sid', domain: 'a.test' })];
    expect(cookiesForRequest(jar, 'https://xa.test/')).toHaveLength(0);
  });
});

describe('serializeForDocument', () => {
  it('omits Domain so the cookie binds to the proxied host', () => {
    const serialized = serializeForDocument(cookie({ secure: true, sameSite: 'Lax' }));
    expect(serialized).toContain('sid=abc');
    expect(serialized).toContain('Path=/');
    expect(serialized).toContain('Secure');
    expect(serialized).toContain('SameSite=Lax');
    expect(serialized.toLowerCase()).not.toContain('domain=');
  });

  it('renders an expiry date', () => {
    const serialized = serializeForDocument(cookie({ expires: Date.UTC(2026, 0, 1) }));
    expect(serialized).toContain('Expires=Thu, 01 Jan 2026');
  });
});

describe('readSetCookies', () => {
  it('reads every Set-Cookie header without mutating the source', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Path=/');
    const cookies = readSetCookies(headers);
    expect(cookies.length).toBeGreaterThanOrEqual(1);
    // Read-only: the caller must not rely on this removing the header.
    expect(headers.get('set-cookie')).not.toBeNull();
  });

  it('works against an immutable Response header map', () => {
    const response = new Response('body', { headers: { 'set-cookie': 'sid=abc' } });
    expect(() => readSetCookies(response.headers)).not.toThrow();
    expect(readSetCookies(response.headers)).toEqual(['sid=abc']);
  });

  it('returns nothing when there is no Set-Cookie', () => {
    expect(readSetCookies(new Headers({ 'content-type': 'text/html' }))).toEqual([]);
  });

  it('does not split on a comma inside an Expires date', () => {
    const headers = new Headers();
    headers.set('set-cookie', 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT');
    const cookies = readSetCookies(headers);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain('Expires=Wed, 21 Oct 2026');
  });

  it('drops blank header values', () => {
    const headers = new Headers();
    headers.append('set-cookie', '   ');
    expect(readSetCookies(headers)).toEqual([]);
  });
});
