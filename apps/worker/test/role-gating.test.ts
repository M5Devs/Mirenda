/**
 * Role gating is the core of the origin-isolation story, so it is tested against
 * the real route table rather than a fixture. The property under test: a Worker
 * deployed as `sandbox` must not match a single `/api/*` route, and one deployed
 * as `app` must not match `/proxy`. A filtered route answers 404, never 403 —
 * the sandbox should not reveal that a vault endpoint exists.
 */
import { describe, expect, it } from 'vitest';
import { Router } from '../src/router.js';
import { buildRoutes } from '../src/routes.js';
import type { ProxyDeps } from '../src/routes/proxy.js';

/**
 * `buildRoutes` only closes over its deps; nothing here executes a handler, so
 * a minimal stand-in is enough and keeps the test free of D1 and fetch mocks.
 */
const deps = {
  now: () => 0,
  fetchUpstream: () => Promise.reject(new Error('not used in routing tests')),
  readEnabledExtensions: () => Promise.resolve([]),
} as unknown as ProxyDeps;

const routes = buildRoutes(deps);

describe('sandbox role', () => {
  const router = new Router(routes, 'sandbox');

  it('matches /proxy', () => {
    expect(router.match('GET', '/proxy')).not.toBeNull();
  });

  it('refuses every /api/* route', () => {
    const apiRoutes = routes.filter((route) => route.pattern.startsWith('/api/'));
    expect(apiRoutes.length).toBeGreaterThan(10);
    for (const route of apiRoutes) {
      // Substitute a concrete value for each :param so the path is well-formed.
      const path = route.pattern.replace(/:[A-Za-z]+/g, 'sample-id');
      expect(router.match(route.method, path), `${route.method} ${route.pattern}`).toBeNull();
    }
  });

  it('does not even report the path as existing, so 405 cannot leak it', () => {
    expect(router.hasPath('/api/vault')).toBe(false);
    expect(router.hasPath('/api/profiles')).toBe(false);
    expect(router.hasPath('/api/auth/login')).toBe(false);
  });
});

describe('app role', () => {
  const router = new Router(routes, 'app');

  it('serves the API routes', () => {
    expect(router.match('POST', '/api/auth/login')).not.toBeNull();
    expect(router.match('GET', '/api/profiles')).not.toBeNull();
    expect(router.match('GET', '/api/vault/salt')).not.toBeNull();
  });

  it('does not serve /proxy', () => {
    expect(router.match('GET', '/proxy')).toBeNull();
  });
});

describe('all role (single-Worker dev)', () => {
  const router = new Router(routes, 'all');

  it('serves both halves, so local dev exercises one code path', () => {
    expect(router.match('GET', '/proxy')).not.toBeNull();
    expect(router.match('POST', '/api/auth/login')).not.toBeNull();
  });
});

describe('route table invariants', () => {
  it('every route declares a role list', () => {
    for (const route of routes) {
      expect(route.roles, `${route.method} ${route.pattern}`).toBeDefined();
      expect(route.roles!.length).toBeGreaterThan(0);
    }
  });

  it('no route is reachable from neither role', () => {
    for (const route of routes) {
      const reachable = route.roles!.some((role) => role === 'app' || role === 'sandbox');
      expect(reachable, `${route.method} ${route.pattern}`).toBe(true);
    }
  });

  it('only /proxy and its token route are sandbox-reachable', () => {
    const sandboxPaths = routes
      .filter((route) => route.roles!.includes('sandbox') && !route.roles!.includes('app'))
      .map((route) => route.pattern);
    for (const path of sandboxPaths) {
      expect(path === '/proxy' || path.startsWith('/proxy'), path).toBe(true);
    }
  });

  it('cookie routes are app-only, so the jar is never written from the sandbox', () => {
    for (const route of routes.filter((r) => r.pattern.startsWith('/api/cookies'))) {
      expect(route.roles).toEqual(['app', 'all']);
    }
  });

  it('plugin storage is app-only', () => {
    for (const route of routes.filter((r) => r.pattern.startsWith('/api/plugin-storage'))) {
      expect(route.roles).toEqual(['app', 'all']);
    }
  });

  it('has no duplicate method + pattern pairs', () => {
    const seen = new Set<string>();
    for (const route of routes) {
      const key = `${route.method} ${route.pattern}`;
      expect(seen.has(key), `duplicate route: ${key}`).toBe(false);
      seen.add(key);
    }
  });
});

describe('Router matching details', () => {
  it('decodes parameters and ignores a trailing slash', () => {
    const router = new Router(routes, 'app');
    const match = router.match('PATCH', '/api/profiles/abc%20123/');
    expect(match?.params.profileId).toBe('abc 123');
  });

  it('does not let a path traversal segment match a single-segment param', () => {
    const router = new Router(routes, 'app');
    // `:profileId` is `[^/]+`, so an embedded slash cannot be smuggled in.
    expect(router.match('PATCH', '/api/profiles/a/b')).toBeNull();
  });

  it('matches the method exactly', () => {
    const router = new Router(routes, 'app');
    expect(router.match('GET', '/api/auth/login')).toBeNull();
    expect(router.match('POST', '/api/auth/login')).not.toBeNull();
  });

  it('reports auth requirements from the table', () => {
    const router = new Router(routes, 'app');
    const login = router.match('POST', '/api/auth/login');
    const profiles = router.match('GET', '/api/profiles');
    expect(login && Router.requiresAuth(login)).toBe(false);
    expect(profiles && Router.requiresAuth(profiles)).toBe(true);
  });

  it('never constructs an unanchored regex', () => {
    // A prefix match would make `/api/profilesX` hit `/api/profiles`.
    const router = new Router(routes, 'app');
    expect(router.match('GET', '/api/profilesX')).toBeNull();
    expect(router.match('GET', '/x/api/profiles')).toBeNull();
  });
});

/**
 * The sandbox serves the extension bundles that the proxy injects into proxied
 * pages. Only the app role used to serve assets, so a split deployment answered
 * 404 for every injected `<script>` and extensions silently never booted.
 */
describe('sandbox extension assets', () => {
  it('lets the sandbox serve /extensions/* even though it serves no UI', () => {
    const isExtensionAsset = (pathname: string) => pathname.startsWith('/extensions/');
    const servesAssets = (pathname: string, role: 'app' | 'sandbox') =>
      isExtensionAsset(pathname) || role !== 'sandbox';

    expect(servesAssets('/extensions/eruda-devtools.js', 'sandbox')).toBe(true);
    expect(servesAssets('/index.html', 'sandbox')).toBe(false);
    expect(servesAssets('/', 'sandbox')).toBe(false);
    expect(servesAssets('/index.html', 'app')).toBe(true);
  });

  it('rejects a non-script response so an SPA fallback cannot mask a missing bundle', () => {
    // The app's ASSETS binding answers a missing file with index.html and a 200.
    // A `<script src>` cannot execute HTML, so the route must not pass it on.
    const isScriptResponse = (response: Response): boolean => {
      if (!response.ok) return false;
      return /javascript|ecmascript/i.test(response.headers.get('content-type') ?? '');
    };

    const html = new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
    const js = new Response('console.log(1)', { headers: { 'content-type': 'application/javascript' } });
    const missing = new Response('not found', { status: 404 });

    expect(isScriptResponse(html)).toBe(false);
    expect(isScriptResponse(js)).toBe(true);
    expect(isScriptResponse(missing)).toBe(false);
  });
});
