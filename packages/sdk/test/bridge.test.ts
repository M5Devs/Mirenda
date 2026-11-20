import { describe, expect, it } from 'vitest';
import {
  SANDBOX_RPC_METHODS,
  isAllowedOrigin,
  isSandboxRpcMethod,
  isTrustedCrossOriginMessage,
  isTrustedViewportMessage,
  resolveProfileId,
  parseOrigins,
} from '@mirenda/sdk';

describe('parseOrigins', () => {
  it('splits, trims and normalises', () => {
    expect(parseOrigins('https://a.example, https://b.example/')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('drops blanks and handles empty input', () => {
    expect(parseOrigins('')).toEqual([]);
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins(null)).toEqual([]);
    expect(parseOrigins(' , , ')).toEqual([]);
  });

  it('lowercases so matching is case-insensitive', () => {
    expect(parseOrigins('HTTPS://App.Example')).toEqual(['https://app.example']);
  });
});

describe('isAllowedOrigin', () => {
  const allowed = ['https://app.example'];

  it('matches exactly, ignoring a trailing slash and case', () => {
    expect(isAllowedOrigin('https://app.example', allowed)).toBe(true);
    expect(isAllowedOrigin('https://app.example/', allowed)).toBe(true);
    expect(isAllowedOrigin('HTTPS://APP.EXAMPLE', allowed)).toBe(true);
  });

  it('rejects a different origin, including a subdomain or port', () => {
    expect(isAllowedOrigin('https://evil.example', allowed)).toBe(false);
    expect(isAllowedOrigin('https://sub.app.example', allowed)).toBe(false);
    expect(isAllowedOrigin('https://app.example:8443', allowed)).toBe(false);
    expect(isAllowedOrigin('http://app.example', allowed)).toBe(false);
  });

  it('never allows an opaque or missing origin', () => {
    expect(isAllowedOrigin('null', allowed)).toBe(false);
    expect(isAllowedOrigin('', allowed)).toBe(false);
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
    expect(isAllowedOrigin(null, allowed)).toBe(false);
  });

  it('is false when the allowlist is empty', () => {
    expect(isAllowedOrigin('https://app.example', [])).toBe(false);
  });
});

describe('isTrustedViewportMessage', () => {
  const frame = { name: 'viewport' };

  it('accepts only the exact source with an opaque origin', () => {
    expect(isTrustedViewportMessage({ source: frame, origin: 'null' }, frame)).toBe(true);
    expect(isTrustedViewportMessage({ source: frame, origin: '' }, frame)).toBe(true);
  });

  it('rejects a different window even when the origin looks right', () => {
    expect(isTrustedViewportMessage({ source: { name: 'other' }, origin: 'null' }, frame)).toBe(false);
  });

  it('rejects a real origin, which means the frame escaped its sandbox', () => {
    expect(isTrustedViewportMessage({ source: frame, origin: 'https://evil.example' }, frame)).toBe(false);
  });

  it('trusts nothing before a viewport is set', () => {
    expect(isTrustedViewportMessage({ source: frame, origin: 'null' }, null)).toBe(false);
    expect(isTrustedViewportMessage({ source: frame, origin: 'null' }, undefined)).toBe(false);
  });
});

describe('isTrustedCrossOriginMessage', () => {
  const frame = { name: 'viewport' };
  const allowed = ['https://app.example'];

  it('requires both the source and an allowlisted origin', () => {
    expect(isTrustedCrossOriginMessage({ source: frame, origin: 'https://app.example' }, frame, allowed)).toBe(true);
    expect(isTrustedCrossOriginMessage({ source: frame, origin: 'https://evil.example' }, frame, allowed)).toBe(false);
    expect(isTrustedCrossOriginMessage({ source: {}, origin: 'https://app.example' }, frame, allowed)).toBe(false);
    expect(isTrustedCrossOriginMessage({ source: frame, origin: 'https://app.example' }, null, allowed)).toBe(false);
  });
});

describe('SANDBOX_RPC_METHODS', () => {
  it('is an allowlist that excludes auth, vault and profile mutation', () => {
    const methods = SANDBOX_RPC_METHODS as readonly string[];
    expect(methods.some((method) => method.startsWith('auth.'))).toBe(false);
    expect(methods.some((method) => method.startsWith('vault.'))).toBe(false);
    expect(methods.some((method) => method.startsWith('profiles.'))).toBe(false);
    // A credentialed fetch from the sandbox would bypass proxy cookie handling.
    expect(methods).not.toContain('network.fetch');
  });

  it('covers the documented surface', () => {
    const methods = SANDBOX_RPC_METHODS as readonly string[];
    for (const expected of [
      'tabs.list',
      'tabs.create',
      'tabs.close',
      'cookies.list',
      'cookies.set',
      'cookies.remove',
      'storage.get',
      'storage.set',
      'storage.clear',
    ]) {
      expect(methods).toContain(expected);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(SANDBOX_RPC_METHODS).size).toBe(SANDBOX_RPC_METHODS.length);
  });
});

describe('isSandboxRpcMethod', () => {
  it('accepts known methods and rejects everything else', () => {
    expect(isSandboxRpcMethod('tabs.list')).toBe(true);
    expect(isSandboxRpcMethod('cookies.set')).toBe(true);
    expect(isSandboxRpcMethod('vault.read')).toBe(false);
    expect(isSandboxRpcMethod('auth.login')).toBe(false);
    expect(isSandboxRpcMethod('')).toBe(false);
    expect(isSandboxRpcMethod(null)).toBe(false);
    expect(isSandboxRpcMethod(42)).toBe(false);
    expect(isSandboxRpcMethod({ toString: () => 'tabs.list' })).toBe(false);
  });
});

describe('resolveProfileId', () => {
  const fakeDoc = (currentScript: unknown, queried: unknown) => ({
    currentScript,
    querySelector: () => queried,
  });

  it('prefers currentScript when it carries the attribute', () => {
    const doc = fakeDoc({ dataset: { profileId: 'from-current' } }, null);
    expect(resolveProfileId('x', doc)).toBe('from-current');
  });

  it('falls back to the plugin tag when currentScript is null (defer)', () => {
    const doc = fakeDoc(null, { dataset: { profileId: 'from-tag' } });
    expect(resolveProfileId('x', doc)).toBe('from-tag');
  });

  it('returns empty string when nothing matches, rather than guessing', () => {
    expect(resolveProfileId('x', fakeDoc(null, null))).toBe('');
    expect(resolveProfileId('x', fakeDoc({ dataset: {} }, { dataset: {} }))).toBe('');
  });

  it('treats an empty currentScript value as absent', () => {
    const doc = fakeDoc({ dataset: { profileId: '' } }, { dataset: { profileId: 'tag' } });
    expect(resolveProfileId('x', doc)).toBe('tag');
  });

  it('ignores a non-string dataset value', () => {
    const doc = fakeDoc(null, { dataset: { profileId: 42 } });
    expect(resolveProfileId('x', doc)).toBe('');
  });

  it('quotes the plugin id into the selector', () => {
    let seen = '';
    const doc = {
      currentScript: null,
      querySelector: (selector: string) => {
        seen = selector;
        return null;
      },
    };
    resolveProfileId('js-css-studio', doc);
    expect(seen).toBe('script[data-mirenda-plugin="js-css-studio"]');
  });
});
