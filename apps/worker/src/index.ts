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
import { Router } from './router.js';
import { buildRoutes } from './routes.js';
import type { Env, RouteContext, SessionUser } from './types.js';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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
    );

    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/proxy';

    if (!isApi) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
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
      return withSecurityHeaders(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unexpected error';
      // Log the message only; request bodies and secrets are never echoed.
      console.error('route failure', { path: url.pathname, message });
      return withSecurityHeaders(fail(500, 'internal error'));
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

function preflight(request: Request, env: Env): Response {
  const origin = request.headers.get('origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const headers = new Headers({ 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' });
  headers.set('access-control-allow-headers', 'content-type');
  headers.set('access-control-allow-credentials', 'true');
  headers.set('vary', 'origin');
  // Never answer `*`: authenticated endpoints rely on a scoped origin allowlist.
  if (allowed.includes(origin)) headers.set('access-control-allow-origin', origin);
  return new Response(null, { status: 204, headers });
}
