import { describe, expect, it } from 'vitest';
import {
  buildGetFormUrl,
  decodeHtmlEntities,
  extractProxyTarget,
  isUrlAttribute,
  parseProxyTarget,
  proxify,
  resolveAttributeUrl,
  resolveTargetUrl,
  rewriteAttribute,
  rewriteCssImports,
  rewriteCssUrls,
  rewriteSrcset,
  rewriteStylesheet,
  rewriteUrlAttribute,
  targetDomainOf,
} from '../src/proxy/url-rewriter.js';

const ctx = { pageUrl: 'https://example.com/dir/page.html', profileId: 'profile-1' };

/** Decode the target back out of a `/proxy` URL for assertions. */
function targetOf(proxied: string): string | null {
  const query = proxied.slice(proxied.indexOf('?') + 1);
  return new URLSearchParams(query).get('url');
}

describe('resolveTargetUrl', () => {
  it('resolves a root-relative path against the page origin', () => {
    expect(resolveTargetUrl('/about', ctx.pageUrl)).toBe('https://example.com/about');
  });

  it('resolves a document-relative path against the page directory', () => {
    expect(resolveTargetUrl('other.html', ctx.pageUrl)).toBe('https://example.com/dir/other.html');
  });

  it('keeps an absolute http(s) URL as-is', () => {
    expect(resolveTargetUrl('https://cdn.test/a.js', ctx.pageUrl)).toBe('https://cdn.test/a.js');
  });

  it('upgrades protocol-relative URLs to https', () => {
    expect(resolveTargetUrl('//cdn.test/a.js', ctx.pageUrl)).toBe('https://cdn.test/a.js');
  });

  it('leaves non-navigational schemes untouched', () => {
    for (const value of [
      'javascript:void(0)',
      'mailto:a@b.test',
      'tel:+15551234',
      'data:text/html,hi',
      'blob:https://x/y',
      'about:blank',
      '#section',
      '',
      '   ',
    ]) {
      expect(resolveTargetUrl(value, ctx.pageUrl)).toBeNull();
    }
  });

  it('rejects non-http schemes that parse successfully', () => {
    expect(resolveTargetUrl('ftp://files.test/a', ctx.pageUrl)).toBeNull();
  });

  it('returns null for unparseable input rather than throwing', () => {
    expect(resolveTargetUrl('http://[', ctx.pageUrl)).toBeNull();
  });
});

describe('proxify', () => {
  it('encodes the target and profile into the query string', () => {
    const proxied = proxify('https://example.com/a?b=c&d=e', ctx);
    expect(proxied.startsWith('/proxy?')).toBe(true);
    expect(targetOf(proxied)).toBe('https://example.com/a?b=c&d=e');
    expect(new URLSearchParams(proxied.slice(proxied.indexOf('?') + 1)).get('profileId')).toBe('profile-1');
  });

  it('round-trips a URL containing a hash and unicode', () => {
    const target = 'https://example.com/path?q=caf%C3%A9#frag';
    expect(targetOf(proxify(target, ctx))).toBe(target);
  });

  it('honours a custom proxy path', () => {
    expect(proxify('https://a.test/', { ...ctx, proxyPath: '/p' }).startsWith('/p?')).toBe(true);
  });
});

describe('rewriteUrlAttribute', () => {
  it('rewrites hrefs, srcs and form actions', () => {
    expect(targetOf(rewriteUrlAttribute('/x', ctx))).toBe('https://example.com/x');
    expect(targetOf(rewriteUrlAttribute('img.png', ctx))).toBe('https://example.com/dir/img.png');
    expect(targetOf(rewriteUrlAttribute('https://a.test/form', ctx))).toBe('https://a.test/form');
  });

  it('returns the original value when it is not rewritable', () => {
    expect(rewriteUrlAttribute('javascript:alert(1)', ctx)).toBe('javascript:alert(1)');
    expect(rewriteUrlAttribute('#top', ctx)).toBe('#top');
  });
});

describe('rewriteSrcset', () => {
  it('rewrites every candidate and preserves descriptors', () => {
    const value = 'a.png 1x, /b.png 2x';
    const rewritten = rewriteSrcset(value, ctx);
    const parts = rewritten.split(', ');
    expect(parts).toHaveLength(2);
    expect(targetOf(parts[0]!)).toBe('https://example.com/dir/a.png');
    expect(parts[0]!.endsWith(' 1x')).toBe(true);
    expect(targetOf(parts[1]!)).toBe('https://example.com/b.png');
    expect(parts[1]!.endsWith(' 2x')).toBe(true);
  });

  it('supports width descriptors', () => {
    const rewritten = rewriteSrcset('/a.png 640w', ctx);
    expect(rewritten.endsWith(' 640w')).toBe(true);
    expect(targetOf(rewritten)).toBe('https://example.com/a.png');
  });

  it('drops empty candidates and keeps unrewritable ones', () => {
    expect(rewriteSrcset(' , data:image/png;base64,AAA 1x', ctx)).toBe('data:image/png;base64,AAA 1x');
  });
});

describe('rewriteCssUrls', () => {
  it('rewrites url() in unquoted, single- and double-quoted forms', () => {
    const css = 'a{background:url(/a.png)}b{background:url("/b.png")}c{background:url(\'/c.png\')}';
    const out = rewriteCssUrls(css, ctx);
    expect(out).not.toContain('url(/a.png)');
    expect(targetOf(out.slice(out.indexOf('url(') + 4).split(')')[0]!.replace(/^"|"$/g, ''))).toBe(
      'https://example.com/a.png',
    );
    expect(out).toContain('%2Fc.png');
  });

  it('leaves data URLs alone', () => {
    const css = 'i{background:url(data:image/gif;base64,R0lGOD)}';
    expect(rewriteCssUrls(css, ctx)).toBe(css);
  });

  it('handles multiple url() tokens in one declaration', () => {
    const out = rewriteCssUrls('x{background:url(/a),url(/b)}', ctx);
    expect(out.match(/\/proxy\?/g)).toHaveLength(2);
  });
});

describe('isUrlAttribute / rewriteAttribute', () => {
  it('identifies URL-bearing attributes case-insensitively', () => {
    for (const name of ['href', 'SRC', 'action', 'formaction', 'poster', 'cite', 'data', 'srcset']) {
      expect(isUrlAttribute(name)).toBe(true);
    }
    for (const name of ['class', 'id', 'style', 'title']) {
      expect(isUrlAttribute(name)).toBe(false);
    }
  });

  it('dispatches srcset to the srcset rewriter', () => {
    const out = rewriteAttribute('srcset', '/a.png 2x', ctx);
    expect(out).toContain('/proxy?');
    expect(out.endsWith(' 2x')).toBe(true);
  });

  it('leaves unknown attributes untouched', () => {
    expect(rewriteAttribute('class', 'x', ctx)).toBe('x');
  });
});

describe('parseProxyTarget', () => {
  it('accepts absolute http and https URLs', () => {
    expect(parseProxyTarget('https://example.com/a')).toBe('https://example.com/a');
    expect(parseProxyTarget('http://example.com/')).toBe('http://example.com/');
  });

  it('rejects anything that is not http(s)', () => {
    for (const value of [
      null,
      '',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://a.test',
      'not a url',
      '//example.com/a',
    ]) {
      expect(parseProxyTarget(value)).toBeNull();
    }
  });

  it('rejects embedded credentials', () => {
    expect(parseProxyTarget('https://user:pass@example.com/')).toBeNull();
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes the ampersand that appears in every multi-param URL', () => {
    expect(decodeHtmlEntities('/w/load.php?lang=en&amp;modules=x')).toBe('/w/load.php?lang=en&modules=x');
  });

  it('leaves a bare ampersand alone', () => {
    expect(decodeHtmlEntities('/a?b=1&c=2')).toBe('/a?b=1&c=2');
  });

  it('decodes numeric references for printable ASCII only', () => {
    expect(decodeHtmlEntities('a&#47;b')).toBe('a/b');
    expect(decodeHtmlEntities('a&#x2F;b')).toBe('a/b');
    // A control character must not be introduced into a URL.
    expect(decodeHtmlEntities('a&#1;b')).toBe('a&#1;b');
  });

  it('leaves unknown named entities untouched', () => {
    expect(decodeHtmlEntities('a&nosuchentity;b')).toBe('a&nosuchentity;b');
  });
});

describe('resolveAttributeUrl', () => {
  it('decodes entities before resolving so query params survive', () => {
    const resolved = resolveAttributeUrl(
      '/w/load.php?lang=en&amp;modules=site.styles',
      'https://en.wikipedia.org/wiki/Cloudflare',
    );
    expect(resolved).toBe('https://en.wikipedia.org/w/load.php?lang=en&modules=site.styles');
  });

  it('rewrites a stylesheet link to a single readable proxied URL', () => {
    const proxied = rewriteUrlAttribute(
      '/w/load.php?lang=en&amp;modules=site.styles&amp;only=styles',
      { pageUrl: 'https://en.wikipedia.org/wiki/Cloudflare', profileId: 'p1' },
    );
    const target = targetOf(proxied);
    expect(target).toBe('https://en.wikipedia.org/w/load.php?lang=en&modules=site.styles&only=styles');
    // The `&amp;` must not have been double-encoded into `%26amp%3B`.
    expect(proxied).not.toContain('amp%3B');
    expect(proxied).not.toContain('amp;');
  });
});

describe('rewriteCssImports', () => {
  it('rewrites the quoted @import form', () => {
    const css = '@import "theme.css";';
    const out = rewriteCssImports(css, ctx);
    expect(targetOf(out.slice(out.indexOf('/proxy')))).toBe('https://example.com/dir/theme.css');
  });

  it('preserves a trailing media query', () => {
    const out = rewriteCssImports('@import "/a.css" screen and (min-width: 40em);', ctx);
    expect(out).toContain('screen and (min-width: 40em)');
  });

  it('leaves the url() form to rewriteCssUrls', () => {
    const out = rewriteCssImports('@import url("/a.css");', ctx);
    expect(out).toBe('@import url("/a.css");');
  });
});

describe('rewriteStylesheet', () => {
  it('rewrites both @import and url() in one pass', () => {
    const out = rewriteStylesheet('@import "a.css";\nbody{background:url(/b.png)}', ctx);
    expect(out).toContain('url(/proxy');
    expect(out).toContain('@import "/proxy');
    expect(targetOf(out.slice(out.indexOf('@import') + 8))).toBe('https://example.com/dir/a.css');
  });

  it('does not decode CSS entities, which are literal in a stylesheet', () => {
    const out = rewriteStylesheet('body{background:url(/a.png?x=1&amp;y=2)}', ctx);
    // `&amp;` is not an HTML entity here; it stays as the server sent it.
    expect(targetOf(out.slice(out.indexOf('/proxy')))).toBe(
      'https://example.com/a.png?x=1&amp;y=2',
    );
  });
});

describe('extractProxyTarget', () => {
  it('recovers the upstream URL from a proxied value', () => {
    expect(extractProxyTarget('/proxy?url=https%3A%2F%2Fa.test%2Fx&profileId=p')).toBe(
      'https://a.test/x',
    );
  });

  it('returns null for a non-proxy value', () => {
    expect(extractProxyTarget('/search?q=1')).toBeNull();
  });
});

describe('buildGetFormUrl', () => {
  const page = 'https://www.google.com/';

  it('folds the fields into the target query string', () => {
    const out = buildGetFormUrl('/search', page, [['q', 'cloudflare workers']]);
    expect(out).toBe('https://www.google.com/search?q=cloudflare+workers');
  });

  it('merges with a query the action already carries', () => {
    const out = buildGetFormUrl('/search?hl=en', page, [['q', 'x']]);
    expect(out).toBe('https://www.google.com/search?hl=en&q=x');
  });

  it('uses the current page when the action is empty', () => {
    const out = buildGetFormUrl('', 'https://a.test/find?q=old', [['q', 'new']]);
    expect(out).toBe('https://a.test/find?q=old&q=new');
  });

  it('unwraps an already-proxied action instead of nesting it', () => {
    const proxied = proxify('https://www.google.com/search', {
      pageUrl: page,
      profileId: 'p1',
    });
    const out = buildGetFormUrl(proxied, page, [['q', 'hi']]);
    expect(out).toBe('https://www.google.com/search?q=hi');
  });

  it('returns null for an action that cannot be resolved', () => {
    expect(buildGetFormUrl('javascript:void(0)', page, [['q', 'x']])).toBeNull();
  });
});

describe('targetDomainOf', () => {
  it('returns the lowercased hostname without a port', () => {
    expect(targetDomainOf('https://Example.COM:8443/a')).toBe('example.com');
  });

  it('keeps subdomains distinct', () => {
    expect(targetDomainOf('https://api.example.com/')).toBe('api.example.com');
    expect(targetDomainOf('https://api.example.com/')).not.toBe(targetDomainOf('https://example.com/'));
  });
});
