/**
 * Worker entrypoint. Resolves the session once, then dispatches to the router.
 *
 * The Worker owns three surfaces:
 *   /api/*    JSON API (auth, profiles, tabs, bookmarks, history, vault)
 *   /proxy    HTMLRewriter-based page proxy with an isolated cookie jar
 *   everything else is served from the static asset binding (the built web UI)
 */
import { sha256Base64 } from './auth/crypto.js';
import { findSessionUser, listEnabledExtensions } from './db/repo.js';
import { createWorkerPluginApi } from './routes/extensions.js';
import { createPluginRegistry, enabledPagePlugins } from './extensions/host.js';
import { fail, json, readCookie, SESSION_COOKIE } from './lib/http.js';
import { parseOrigins } from '@mirenda/sdk';
import { Router } from './router.js';
import { buildRoutes } from './routes.js';
import type { Env, RouteContext, SessionUser, WorkerRole } from './types.js';

/** Coerce the configured role; anything unrecognised falls back to `all`. */
/** A genuine script bundle, as opposed to the SPA fallback's HTML shell. */
function isScriptResponse(response: Response): boolean {
  if (!response.ok) return false;
  const type = response.headers.get('content-type') ?? '';
  return /javascript|ecmascript/i.test(type);
}

function resolveRole(env: Env): WorkerRole {
  const raw = (env.WORKER_ROLE ?? 'all').toLowerCase();
  return raw === 'app' || raw === 'sandbox' ? raw : 'all';
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const role = resolveRole(env);

    if (request.method === 'OPTIONS') return preflight(request, env);

    const router = new Router(
      buildRoutes({
        createRegistry: async (user, profileId) => {
          const enabled = await listEnabledExtensions(env.DB, profileId);
          return createPluginRegistry(
            (plugin) => createWorkerPluginApi(env, plugin.manifest.id, user.id, profileId),
            enabledPagePlugins(enabled),
          );
        },
      }),
      role,
    );

    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/proxy';
    // Extension bundles are static scripts injected into proxied pages. They
    // live in the same assets directory as the UI, but the sandbox must serve
    // them too, or every injected extension would 404 on a split deployment.
    const isExtensionAsset = url.pathname.startsWith('/extensions/');

    if (!isApi) {
      const servesAssets = isExtensionAsset || role !== 'sandbox';
      // Only the app role serves the UI itself; the sandbox serves just the
      // extension bundles and must not become a second copy of the app.
      if (servesAssets && env.ASSETS) {
        const asset = await env.ASSETS.fetch(request);
        // The app's ASSETS binding uses the SPA fallback, so a missing bundle
        // would come back as `index.html` with a 200. A `<script src>` cannot
        // execute HTML and the page would fail silently, so an extension asset
        // must be a real script or a 404.
        if (isExtensionAsset && !isScriptResponse(asset)) return fail(404, 'not found');
        return withCors(asset, request, env);
      }
      return fail(404, 'not found');
    }

    // A sandbox deployment answers nothing but `/proxy`. Refusing `/api/*` here,
    // before the router, keeps the boundary obvious even if the table changes.
    if (role === 'sandbox' && !url.pathname.startsWith('/proxy')) {
      return fail(404, 'not found');
    }

    const match = router.match(request.method, url.pathname);
    if (!match) {
      if (router.hasPath(url.pathname)) return fail(405, 'method not allowed');
      return fail(404, 'not found');
    }

    const user = await resolveSession(request, env);
    if (Router.requiresAuth(match) && !user) {
      return json({ error: 'not authenticated' }, { status: 401 });
    }

    const context: RouteContext = Router.context(match, {
      request,
      env,
      url,
      user,
    });

    try {
      const response = await Router.handler(match)(context);
      return withCors(withSecurityHeaders(response), request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unexpected error';
      // Log the message only; request bodies and secrets are never echoed.
      console.error('route failure', { path: url.pathname, message });
      return withCors(withSecurityHeaders(fail(500, 'internal error')), request, env);
    }
  },
} satisfies ExportedHandler<Env>;

async function resolveSession(request: Request, env: Env): Promise<SessionUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return findSessionUser(env.DB, await sha256Base64(token));
}

/**
 * Baseline hardening headers for worker responses.
 *
 * `X-Frame-Options` is deliberately absent: the UI is served from the same
 * origin as the proxy, and proxied documents are rendered in a sandboxed iframe
 * whose `allow-same-origin` is never granted, so frame-busting headers on the
 * proxied response would only break the viewport.
 */
function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Add CORS headers when the caller is an explicitly allowlisted origin.
 *
 * Never `*`: authenticated routes depend on a scoped allowlist, and reflecting
 * an arbitrary origin with credentials would let any site read the API. When the
 * origin is absent (same-origin navigation) no header is needed.
 */
function withCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get('origin');
  if (!origin) return response;
  const allowed = parseOrigins(env.ALLOWED_ORIGINS);
  if (!allowed.includes(origin.trim().replace(/\/+$/, '').toLowerCase())) return response;

  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-credentials', 'true');
  headers.append('vary', 'origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function preflight(request: Request, env: Env): Response {
  const origin = request.headers.get('origin') ?? '';
  const allowed = parseOrigins(env.ALLOWED_ORIGINS);
  const headers = new Headers({ 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' });
  headers.set('access-control-allow-headers', 'content-type, x-mirenda-proxy-token');
  headers.set('access-control-allow-credentials', 'true');
  headers.set('vary', 'origin');
  // Never answer `*`: authenticated endpoints rely on a scoped origin allowlist.
  const normalized = origin.trim().replace(/\/+$/, '').toLowerCase();
  if (normalized !== '' && allowed.includes(normalized)) {
    headers.set('access-control-allow-origin', origin);
  }
  return new Response(null, { status: 204, headers });
}
