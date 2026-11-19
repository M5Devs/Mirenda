import { describe, expect, it, vi } from 'vitest';
import { PluginRegistry } from '../src/registry.js';
import {
  definePlugin,
  hasPermission,
  manifestMatchesUrl,
  validateManifest,
  type MirendaApi,
  type MirendaManifest,
  type MirendaPlugin,
} from '../src/types.js';

const baseManifest: MirendaManifest = {
  id: 'demo',
  name: 'Demo',
  version: '1.0.0',
  runtime: 'page',
  entry: '/extensions/demo.js',
  matches: ['*'],
  permissions: ['page'],
};

/** The registry never builds an API itself; a stub keeps tests honest. */
const stubApi = { plugin: { id: 'demo', profileId: 'p' } } as unknown as MirendaApi;

function registry(plugins: MirendaPlugin[], onError?: (failure: { pluginId: string; hook: string; error: unknown }) => void) {
  const r = new PluginRegistry({ createApi: () => stubApi, onError: onError as never });
  for (const plugin of plugins) r.register(plugin);
  return r;
}

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(validateManifest(baseManifest)).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateManifest(null)).toEqual(['manifest must be an object']);
    expect(validateManifest('nope')).toEqual(['manifest must be an object']);
  });

  it('requires a slug-shaped id', () => {
    for (const id of ['Demo', 'has space', '', 'trailing-', '-leading', 'a_b']) {
      expect(validateManifest({ ...baseManifest, id }).length).toBeGreaterThan(0);
    }
    for (const id of ['demo', 'eruda-devtools', 'my.ext', 'a1']) {
      expect(validateManifest({ ...baseManifest, id })).toEqual([]);
    }
  });

  it('requires semver', () => {
    for (const version of ['1.0', 'v1.0.0', '1', 'latest']) {
      expect(validateManifest({ ...baseManifest, version }).length).toBeGreaterThan(0);
    }
    for (const version of ['1.0.0', '2.1.3-beta.1', '1.0.0+build.5']) {
      expect(validateManifest({ ...baseManifest, version })).toEqual([]);
    }
  });

  it('requires a runtime from the known set', () => {
    expect(validateManifest({ ...baseManifest, runtime: 'sandbox' }).length).toBeGreaterThan(0);
  });

  it('requires an absolute entry for page and both runtimes', () => {
    expect(validateManifest({ ...baseManifest, runtime: 'page', entry: undefined }).length).toBeGreaterThan(0);
    expect(validateManifest({ ...baseManifest, runtime: 'page', entry: 'demo.js' }).length).toBeGreaterThan(0);
    expect(validateManifest({ ...baseManifest, runtime: 'both', entry: '/x.js' })).toEqual([]);
  });

  it('does not require an entry for a worker-only runtime', () => {
    expect(validateManifest({ ...baseManifest, runtime: 'worker', entry: undefined })).toEqual([]);
  });

  it('rejects unknown permissions', () => {
    expect(validateManifest({ ...baseManifest, permissions: ['page', 'root'] }).length).toBeGreaterThan(0);
    expect(validateManifest({ ...baseManifest, permissions: 'page' }).length).toBeGreaterThan(0);
  });

  it('rejects non-string match globs', () => {
    expect(validateManifest({ ...baseManifest, matches: [1] }).length).toBeGreaterThan(0);
  });
});

describe('manifestMatchesUrl', () => {
  it('matches everything when matches is absent or ["*"]', () => {
    expect(manifestMatchesUrl({ ...baseManifest, matches: undefined }, 'https://a.test/')).toBe(true);
    expect(manifestMatchesUrl({ ...baseManifest, matches: [] }, 'https://a.test/')).toBe(true);
    expect(manifestMatchesUrl(baseManifest, 'https://a.test/')).toBe(true);
  });

  it('matches an exact URL', () => {
    const manifest = { ...baseManifest, matches: ['https://example.com/app'] };
    expect(manifestMatchesUrl(manifest, 'https://example.com/app')).toBe(true);
    expect(manifestMatchesUrl(manifest, 'https://example.com/app/')).toBe(false);
  });

  it('supports a wildcard in the host or path', () => {
    const manifest = { ...baseManifest, matches: ['https://*.example.com/*'] };
    expect(manifestMatchesUrl(manifest, 'https://shop.example.com/cart')).toBe(true);
    expect(manifestMatchesUrl(manifest, 'https://example.com/cart')).toBe(false);
  });

  it('matches any of several globs', () => {
    const manifest = { ...baseManifest, matches: ['https://a.test/*', 'https://b.test/*'] };
    expect(manifestMatchesUrl(manifest, 'https://b.test/x')).toBe(true);
    expect(manifestMatchesUrl(manifest, 'https://c.test/x')).toBe(false);
  });

  it('is case-insensitive', () => {
    const manifest = { ...baseManifest, matches: ['https://EXAMPLE.com/*'] };
    expect(manifestMatchesUrl(manifest, 'https://example.com/x')).toBe(true);
  });

  it('does not let regex metacharacters in a glob act as regex', () => {
    const manifest = { ...baseManifest, matches: ['https://example.com/a.b'] };
    expect(manifestMatchesUrl(manifest, 'https://example.com/a.b')).toBe(true);
    expect(manifestMatchesUrl(manifest, 'https://example.com/axb')).toBe(false);
  });

  it('anchors the pattern, so a prefix does not match', () => {
    const manifest = { ...baseManifest, matches: ['https://example.com/a'] };
    expect(manifestMatchesUrl(manifest, 'https://example.com/abcdef')).toBe(false);
  });
});

describe('hasPermission', () => {
  it('reports declared permissions only', () => {
    expect(hasPermission(baseManifest, 'page')).toBe(true);
    expect(hasPermission(baseManifest, 'cookies')).toBe(false);
    expect(hasPermission({ ...baseManifest, permissions: undefined }, 'page')).toBe(false);
  });
});

describe('definePlugin', () => {
  it('returns the plugin unchanged', () => {
    const plugin = definePlugin({ manifest: baseManifest });
    expect(plugin.manifest.id).toBe('demo');
  });
});

describe('PluginRegistry', () => {
  it('registers and lists plugins', () => {
    const r = registry([{ manifest: baseManifest }]);
    expect(r.has('demo')).toBe(true);
    expect(r.list()).toHaveLength(1);
    expect(r.manifests()[0]?.id).toBe('demo');
  });

  it('rejects an invalid manifest', () => {
    const r = new PluginRegistry({ createApi: () => stubApi });
    expect(() => r.register({ manifest: { ...baseManifest, id: 'Bad Id' } })).toThrow(/invalid manifest/);
  });

  it('rejects a duplicate id', () => {
    const r = registry([{ manifest: baseManifest }]);
    expect(() => r.register({ manifest: baseManifest })).toThrow(/already registered/);
  });

  it('filters plugins by URL', () => {
    const r = registry([
      { manifest: baseManifest },
      { manifest: { ...baseManifest, id: 'other', matches: ['https://other.test/*'] } },
    ]);
    // `demo` matches everything, so it is present for both; `other` is scoped.
    expect(r.forUrl('https://example.com/').map((p) => p.manifest.id)).toEqual(['demo']);
    expect(r.forUrl('https://other.test/').map((p) => p.manifest.id)).toEqual(['demo', 'other']);
  });

  it('folds onRequest hooks in registration order', async () => {
    const order: string[] = [];
    const r = registry([
      {
        manifest: { ...baseManifest, id: 'first', runtime: 'worker' },
        onRequest: (request) => {
          order.push('first');
          return { ...request, url: `${request.url}?a=1` };
        },
      },
      {
        manifest: { ...baseManifest, id: 'second', runtime: 'worker' },
        onRequest: (request) => {
          order.push('second');
          return { ...request, url: `${request.url}&b=2` };
        },
      },
    ]);

    const result = await r.runRequestHooks({
      url: 'https://example.com/',
      method: 'GET',
      headers: {},
      profileId: 'p',
      targetDomain: 'example.com',
    });

    expect(order).toEqual(['first', 'second']);
    expect(result.url).toBe('https://example.com/?a=1&b=2');
  });

  it('keeps the request when a hook returns nothing', async () => {
    const r = registry([{ manifest: { ...baseManifest, runtime: 'worker' }, onRequest: () => undefined }]);
    const request = { url: 'https://a.test/', method: 'GET', headers: {}, profileId: 'p', targetDomain: 'a.test' };
    expect(await r.runRequestHooks(request)).toEqual(request);
  });

  it('isolates a throwing hook so later hooks still run', async () => {
    const onError = vi.fn();
    const after = vi.fn();
    const r = registry(
      [
        {
          manifest: { ...baseManifest, id: 'boom', runtime: 'worker' },
          onRequest: () => {
            throw new Error('hook exploded');
          },
        },
        {
          manifest: { ...baseManifest, id: 'after', runtime: 'worker' },
          onRequest: (request) => {
            after();
            return request;
          },
        },
      ],
      onError,
    );

    const result = await r.runRequestHooks({
      url: 'https://a.test/',
      method: 'GET',
      headers: {},
      profileId: 'p',
      targetDomain: 'a.test',
    });

    expect(result.url).toBe('https://a.test/');
    expect(after).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ pluginId: 'boom', hook: 'onRequest' });
  });

  it('collects script injections only for page-runtime plugins with the page permission', () => {
    const r = registry([
      { manifest: baseManifest },
      { manifest: { ...baseManifest, id: 'worker-only', runtime: 'worker', entry: undefined } },
      { manifest: { ...baseManifest, id: 'no-perm', permissions: [] } },
    ]);

    const injections = r.collectInjections('https://example.com/');
    expect(injections).toHaveLength(1);
    expect(injections[0]?.content).toContain('/extensions/demo.js');
    expect(injections[0]?.content).toContain('data-mirenda-plugin="demo"');
    expect(injections[0]?.source).toBe('Demo 1.0.0');
  });

  it('writes the profile id onto the injected tag when given', () => {
    const r = registry([{ manifest: baseManifest }]);
    const [injection] = r.collectInjections('https://example.com/', 'profile-abc');
    expect(injection?.content).toContain('data-profile-id="profile-abc"');
  });

  it('omits the profile attribute when no profile id is given', () => {
    const r = registry([{ manifest: baseManifest }]);
    expect(r.collectInjections('https://example.com/')[0]?.content).not.toContain('data-profile-id');
  });

  it('respects URL matches when collecting injections', () => {
    const r = registry([{ manifest: { ...baseManifest, matches: ['https://only.test/*'] } }]);
    expect(r.collectInjections('https://only.test/')).toHaveLength(1);
    expect(r.collectInjections('https://elsewhere.test/')).toHaveLength(0);
  });

  it('escapes attribute values in injected markup', () => {
    const r = registry([
      { manifest: { ...baseManifest, id: 'x', entry: '/extensions/x.js?a="b"' } },
    ]);
    expect(r.collectInjections('https://a.test/')[0]?.content).toContain('&quot;');
  });

  it('reports permission usage', () => {
    const r = registry([
      { manifest: baseManifest },
      { manifest: { ...baseManifest, id: 'c', permissions: ['cookies'] } },
    ]);
    expect(r.usesPermission('page')).toBe(true);
    expect(r.usesPermission('cookies')).toBe(true);
    expect(r.usesPermission('network')).toBe(false);
  });

  it('runs onLoad and onUnload, collecting failures', async () => {
    const loaded = vi.fn();
    const r = registry([
      {
        manifest: baseManifest,
        onLoad: () => {
          loaded();
        },
      },
      {
        manifest: { ...baseManifest, id: 'broken' },
        onLoad: () => {
          throw new Error('nope');
        },
      },
    ]);

    const failures = await r.loadAll();
    expect(loaded).toHaveBeenCalledOnce();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ pluginId: 'broken', hook: 'onLoad' });

    expect(await r.unloadAll()).toEqual([]);
  });
});
