import { describe, expect, it } from 'vitest';
import {
  SEARCH_TEMPLATE,
  displayUrl,
  normalizeAddressInput,
  originOf,
  targetFromProxyUrl,
} from '../src/lib/url.js';

describe('normalizeAddressInput', () => {
  it('returns null for empty or whitespace-only input', () => {
    expect(normalizeAddressInput('')).toBeNull();
    expect(normalizeAddressInput('   ')).toBeNull();
  });

  it('keeps an absolute http(s) URL', () => {
    expect(normalizeAddressInput('https://example.com/a?b=c')).toBe('https://example.com/a?b=c');
    expect(normalizeAddressInput('http://example.com/')).toBe('http://example.com/');
  });

  it('upgrades a bare domain to https', () => {
    expect(normalizeAddressInput('example.com')).toBe('https://example.com/');
    expect(normalizeAddressInput('www.example.co.uk/path')).toBe('https://www.example.co.uk/path');
  });

  it('uses http for localhost and bare IPs', () => {
    expect(normalizeAddressInput('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeAddressInput('127.0.0.1:8787')).toBe('http://127.0.0.1:8787/');
  });

  it('searches for anything that is not a hostname', () => {
    expect(normalizeAddressInput('how to cook rice')).toBe(
      SEARCH_TEMPLATE.replace('%s', encodeURIComponent('how to cook rice')),
    );
  });

  it('searches for a single word with no dot', () => {
    expect(normalizeAddressInput('mirenda')).toContain('duckduckgo.com');
  });

  it('rejects a non-http scheme rather than searching', () => {
    expect(normalizeAddressInput('javascript:alert(1)')).toBeNull();
    expect(normalizeAddressInput('file:///etc/passwd')).toBeNull();
  });

  it('rejects an unparseable absolute URL', () => {
    expect(normalizeAddressInput('http://[')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeAddressInput('  example.com  ')).toBe('https://example.com/');
  });
});

describe('displayUrl', () => {
  it('drops the scheme and a root trailing slash', () => {
    expect(displayUrl('https://example.com/')).toBe('example.com');
  });

  it('keeps a non-root path, query and hash', () => {
    expect(displayUrl('https://example.com/a/b?c=d#e')).toBe('example.com/a/b?c=d#e');
  });

  it('keeps a non-default port', () => {
    expect(displayUrl('http://localhost:3000/')).toBe('localhost:3000');
  });

  it('returns the input when it does not parse', () => {
    expect(displayUrl('not a url')).toBe('not a url');
  });
});

describe('originOf', () => {
  it('returns the hostname', () => {
    expect(originOf('https://shop.example.com:8443/a')).toBe('shop.example.com');
  });

  it('returns an empty string for invalid input', () => {
    expect(originOf('nope')).toBe('');
  });
});

describe('targetFromProxyUrl', () => {
  it('extracts the proxied target', () => {
    const value = `/proxy?url=${encodeURIComponent('https://example.com/a')}&profileId=p1`;
    expect(targetFromProxyUrl(value)).toBe('https://example.com/a');
  });

  it('works with an absolute proxy URL', () => {
    const value = `https://mirenda.test/proxy?url=${encodeURIComponent('https://a.test/')}&profileId=p`;
    expect(targetFromProxyUrl(value)).toBe('https://a.test/');
  });

  it('returns null for a non-proxy path', () => {
    expect(targetFromProxyUrl('https://mirenda.test/api/tabs')).toBeNull();
  });

  it('returns null when the url parameter is missing', () => {
    expect(targetFromProxyUrl('/proxy?profileId=p')).toBeNull();
  });
});
