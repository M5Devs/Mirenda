/**
 * `/proxy` — fetch an upstream page, isolate its cookies, rewrite its URLs, and
 * stream the result back into Mirenda's sandboxed viewport.
 */
import {
  buildCookieHeader,
  cookiesForRequest,
  mergeCookies,
  parseSetCookie,
  readSetCookies,
} from '../proxy/cookie-jar.js';
import { loadJar, saveJar } from '../db/repo.js';
import { buildHandlers, createRewriteState } from '../proxy/rewrite-handlers.js';
import {
  parseProxyTarget,
  PROXY_PATH,
  rewriteCssUrls,
  targetDomainOf,
  type RewriteContext,
} from '../proxy/url-rewriter.js';
import { fail } from '../lib/http.js';
import { findOwnedProfile } from '../db/repo.js';
import type { PageInjection, PluginRegistry } from '@mirenda/sdk';
import type { RouteContext } from '../types.js';

/**
 * Request headers copied upstream. Everything else — notably `cookie`,
 * `authorization` and the host's own `origin` — is dropped: the jar supplies
 * cookies and nothing about Mirenda's origin may leak to the target.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'accept-encoding',
  'content-type',
  'content-length',
  'cache-control',
  'pragma',
  'range',
  'if-none-match',
  'if-modified-since',
  'user-agent',
  'x-requested-with',
]);

/** Response headers worth returning to the client unchanged. */
const PASSTHROUGH_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-language',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'accept-ranges',
  'content-range',
  'content-disposition',
]);

export interface ProxyDeps {
  /**
   * Build the plugin registry for the authenticated caller. Called once per
   * proxied request so plugin APIs are bound to that user and profile, and so
   * the enabled-extension set is read fresh from storage.
   */
  createRegistry: (
    user: { id: string; email: string },
    profileId: string,
  ) => Promise<PluginRegistry> | PluginRegistry;
}

/**
 * The proxy route. `GET /proxy?url=<absolute>&profileId=<id>` (any method is
 * forwarded, so form posts work).
 */
export function createProxyHandler(deps: ProxyDeps) {
  return async function proxyRoute(ctx: RouteContext): Promise<Response> {
    const { request, env, url } = ctx;
    const user = ctx.user;
    if (!user) return fail(401, 'not authenticated');

    const target = parseProxyTarget(url.searchParams.get('url'));
    if (!target) return fail(400, 'url must be an absolute http(s) URL');

    const profileId = url.searchParams.get('profileId') ?? '';
    if (!profileId) return fail(400, 'profileId is required');
    const profile = await findOwnedProfile(env.DB, user.id, profileId);
    if (!profile) return fail(404, 'profile not found');

    const targetDomain = targetDomainOf(target);

    // ---- outgoing request: build headers, inject jar cookies ----------------
    const outgoing = new Headers();
    for (const [name, value] of request.headers) {
      if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) outgoing.set(name, value);
    }
    if (profile.user_agent) outgoing.set('user-agent', profile.user_agent);
    // Never leak the target's own `Referer` to a third party through the proxy.
    const referer = request.headers.get('referer');
    if (referer) {
      try {
        const refUrl = new URL(referer);
        const refTarget = refUrl.searchParams.get('url');
        if (refTarget) outgoing.set('referer', refTarget);
      } catch {
        /* a malformed referer is simply dropped */
      }
    }

    const jar = await loadJar(env.DB, { userId: user.id, profileId, domain: targetDomain });
    const outgoingCookies = cookiesForRequest(jar, target);
    if (outgoingCookies.length > 0) outgoing.set('cookie', buildCookieHeader(outgoingCookies));

    const registry = await deps.createRegistry(user, profileId);

    let proxiedRequest = {
      url: target,
      method: request.method,
      headers: Object.fromEntries(outgoing),
      profileId,
      targetDomain,
    };
    proxiedRequest = await registry.runRequestHooks(proxiedRequest);
    const finalHeaders = new Headers(proxiedRequest.headers);

    const method = proxiedRequest.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const body = hasBody ? await request.arrayBuffer() : undefined;

    let upstream: Response;
    try {
      upstream = await fetch(proxiedRequest.url, {
        method,
        headers: finalHeaders,
        body,
        redirect: 'manual',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'upstream fetch failed';
      return fail(502, `could not reach ${targetDomain}: ${message}`);
    }

    // ---- cookie isolation ---------------------------------------------------
    // `Set-Cookie` never reaches the client. It is parsed into the jar, merged,
    // and persisted keyed by (user, profile, domain).
    const setCookies = readSetCookies(upstream.headers);
    if (setCookies.length > 0) {
      const received = setCookies
        .map((header) => parseSetCookie(header, proxiedRequest.url))
        .filter((cookie): cookie is NonNullable<typeof cookie> => cookie !== null);
      if (received.length > 0) {
        await saveJar(
          env.DB,
          { userId: user.id, profileId, domain: targetDomain },
          mergeCookies(jar, received),
        );
      }
    }

    // ---- redirects ----------------------------------------------------------
    const location = upstream.headers.get('location');
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      const resolved = new URL(location, proxiedRequest.url).toString();
      const params = new URLSearchParams({ url: resolved, profileId });
      const headers = new Headers({ location: `${PROXY_PATH}?${params.toString()}`, 'cache-control': 'no-store' });
      return new Response(null, { status: upstream.status, headers });
    }

    // ---- response headers ---------------------------------------------------
    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
      if (PASSTHROUGH_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
    }
    responseHeaders.delete('content-encoding');
    responseHeaders.set('x-mirenda-proxied', '1');
    // The proxied document is hostile; never let it set a cookie on our origin.
    responseHeaders.delete('set-cookie');

    const contentType = upstream.headers.get('content-type') ?? '';
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
    const isCss = /text\/css/i.test(contentType);

    const pluginInjections = registry.collectInjections(proxiedRequest.url, profileId);

    let proxiedResponse = {
      url: proxiedRequest.url,
      status: upstream.status,
      headers: Object.fromEntries(upstream.headers),
      contentType: contentType || null,
      profileId,
      targetDomain,
      injections: pluginInjections,
    };
    proxiedResponse = await registry.runResponseHooks(proxiedResponse);
    const injections: PageInjection[] = proxiedResponse.injections;

    // ---- body rewriting -----------------------------------------------------
    const rewriteCtx: RewriteContext = { pageUrl: proxiedRequest.url, profileId };

    if (!isHtml) {
      if (isCss) {
        const css = await upstream.text();
        return new Response(rewriteCssUrls(css, rewriteCtx), {
          status: upstream.status,
          headers: responseHeaders,
        });
      }
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    }

    const state = createRewriteState(rewriteCtx, injections);
    const handlers = buildHandlers(state);

    const rewritten = new HTMLRewriter()
      .on('*', handlers.attribute)
      .on('style', handlers.styleText)
      .on('body', handlers.body)
      .transform(
        new Response(upstream.body, {
          status: upstream.status,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );

    return new Response(rewritten.body, { status: upstream.status, headers: responseHeaders });
  };
}
