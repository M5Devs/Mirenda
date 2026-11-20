/**
 * HTMLRewriter handlers that make an upstream document navigable inside the
 * Mirenda viewport: every URL-bearing attribute is routed back through
 * `/proxy`, and extension payloads are appended before `</body>`.
 *
 * All state lives in `RewriteState` so a handler instance is per-request.
 */
import type { PageInjection } from '@mirenda/sdk';
import { buildClientRuntimeScript } from './client-runtime.js';
import {
  isUrlAttribute,
  PROXY_PATH,
  proxify,
  resolveAttributeUrl,
  rewriteAttribute,
  rewriteCssUrls,
  rewriteStylesheet,
  type RewriteContext,
} from './url-rewriter.js';

/** Attributes that make the document escape its frame or leak the host origin. */
const DROPPED_ATTRIBUTES = new Set(['integrity', 'nonce', 'crossorigin', 'referrerpolicy']);

/** Sentinel so the runtime is injected exactly once even if `<head>` is odd. */
const RUNTIME_MARKER = '\u0000mirenda-runtime';

export interface RewriteState {
  /** Current resolution base; `<base href>` updates it. */
  base: string;
  ctx: RewriteContext;
  injections: PageInjection[];
  /** Extension script URLs already appended, so a duplicate tag is not injected twice. */
  injected: Set<string>;
}

export function createRewriteState(ctx: RewriteContext, injections: PageInjection[] = []): RewriteState {
  return { base: ctx.pageUrl, ctx, injections, injected: new Set() };
}

function attributeHandler(state: RewriteState) {
  return {
    element(element: Element) {
      const localCtx: RewriteContext = { ...state.ctx, pageUrl: state.base };

      // Handle `<meta>` policy tags first, before the attribute loop mutates
      // anything: the check reads `http-equiv`, and removing the element makes
      // the rest of this handler a no-op for it.
      if (element.tagName === 'meta') {
        const httpEquiv = element.getAttribute('http-equiv')?.toLowerCase();
        if (httpEquiv === 'content-security-policy' || httpEquiv === 'x-frame-options') {
          element.remove();
          return;
        }
        if (httpEquiv === 'refresh') {
          const content = element.getAttribute('content');
          if (content) element.setAttribute('content', rewriteMetaRefresh(content, localCtx));
        }
      }

      for (const pair of element.attributes) {
        const name = pair[0];
        const value = pair[1];
        if (name === undefined || value === undefined) continue;
        const lower = name.toLowerCase();

        if (DROPPED_ATTRIBUTES.has(lower)) {
          element.removeAttribute(name);
          continue;
        }

        // A `<base href>` changes how later relative URLs resolve, so rewrite it
        // and adopt the resolved target as the new base.
        if (lower === 'href' && element.tagName === 'base') {
          const target = resolveAttributeUrl(value, state.base);
          if (target) {
            state.base = target;
            element.setAttribute('href', proxify(target, localCtx));
          }
          continue;
        }

        if (isUrlAttribute(lower)) {
          element.setAttribute(name, rewriteAttribute(name, value, localCtx));
          continue;
        }

        if (lower === 'style') {
          element.setAttribute(name, rewriteCssUrls(value, localCtx));
          continue;
        }

        if (lower === 'http-equiv' && value.toLowerCase() === 'refresh') {
          continue;
        }

        if (lower === 'target') {
          // Force same-frame navigation; a named target would escape the viewport.
          element.setAttribute('target', '_self');
          continue;
        }
      }

      // Inline event handlers and `javascript:` URLs are the page's own business;
      // the sandboxed iframe contains them.
    },
  };
}

/** Rewrite the URL inside `<meta http-equiv="refresh" content="5; url=/next">`. */
export function rewriteMetaRefresh(content: string, ctx: RewriteContext): string {
  const match = /^(\s*[\d.]+\s*;\s*url\s*=\s*)(['"]?)(.+?)\2(\s*)$/i.exec(content);
  if (!match) return content;
  const [, prefix, quote, rawUrl, suffix] = match;
  const target = resolveAttributeUrl(rawUrl ?? '', ctx.pageUrl);
  if (!target) return content;
  return `${prefix}${quote}${proxify(target, ctx)}${quote}${suffix}`;
}

/** Handler for `<style>` element bodies: rewrite `url(...)` and `@import` inside the CSS text. */
function styleTextHandler(state: RewriteState) {
  return {
    text(text: Text) {
      if (!text.text) return;
      const localCtx: RewriteContext = { ...state.ctx, pageUrl: state.base };
      text.replace(rewriteStylesheet(text.text, localCtx), { html: false });
    },
  };
}

/** Handler for `<head>`: install the in-page runtime before any page script. */
function headHandler(state: RewriteState) {
  return {
    element(element: Element) {
      if (state.injected.has(RUNTIME_MARKER)) return;
      state.injected.add(RUNTIME_MARKER);
      const runtime = buildClientRuntimeScript({
        proxyPath: state.ctx.proxyPath ?? PROXY_PATH,
        profileId: state.ctx.profileId,
        ...(state.ctx.proxyToken ? { proxyToken: state.ctx.proxyToken } : {}),
        pageUrl: state.ctx.pageUrl,
      });
      // `prepend` puts this ahead of every existing child, so the shim is
      // installed before the page's own scripts can issue a request.
      element.prepend(`<script data-mirenda-runtime="1">${runtime}</script>`, { html: true });
    },
  };
}

/** Handler for `<body>`: append extension payloads plus the page-runtime bridge. */
function bodyHandler(state: RewriteState) {
  return {
    element(element: Element) {
      for (const injection of state.injections) {
        if (injection.kind === 'script' && state.injected.has(injection.content)) continue;
        state.injected.add(injection.content);
        element.append(`<!-- ${escapeComment(injection.source)} -->${injection.content}`, { html: true });
      }
    },
  };
}

function escapeComment(value: string): string {
  return value.replace(/--/g, '–').replace(/>/g, '&gt;');
}

/**
 * Build the full handler set. Pass the same `state` to every handler so a
 * `<base>` seen early affects the elements that follow.
 */
export function buildHandlers(state: RewriteState) {
  return {
    state,
    attribute: attributeHandler(state),
    styleText: styleTextHandler(state),
    head: headHandler(state),
    body: bodyHandler(state),
  };
}
