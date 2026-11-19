/**
 * Mirenda Plugin SDK — public types.
 *
 * Licensed MIT so extension authors keep full freedom over their own work.
 * These types are shared by three runtimes:
 *   - `worker`:  the Cloudflare Worker proxy pipeline (onRequest / onResponse)
 *   - `page`:    a script injected into the proxied document (onPageInject)
 *   - `web`:     the Mirenda UI shell, which hosts the plugin manager
 *
 * Nothing here imports a runtime API, so the same file typechecks in all three.
 */

/** Where a plugin is allowed to run. */
export type PluginRuntime = 'page' | 'worker' | 'both';

/** Capabilities a plugin must declare before it can use the matching API. */
export type MirendaPermission = 'tabs' | 'network' | 'cookies' | 'page' | 'storage';

/** A plugin's static identity and the permissions it requests. */
export interface MirendaManifest {
  /** Stable slug, e.g. `eruda-devtools`. Lowercase, dots and dashes allowed. */
  id: string;
  name: string;
  /** Semver, e.g. `1.0.0`. */
  version: string;
  description?: string;
  author?: string;
  /** SPDX identifier of the extension's own license. */
  license?: string;
  runtime: PluginRuntime;
  /**
   * Worker-served path of the script to inject into proxied pages, e.g.
   * `/extensions/eruda-devtools.js`. Required when `runtime` is `page` or `both`.
   */
  entry?: string;
  /**
   * URL globs the extension applies to (`*` wildcard, matched against the full
   * proxied target URL). Omitted or `['*']` means every page.
   */
  matches?: readonly string[];
  permissions?: readonly MirendaPermission[];
}

/** A cookie held by the Virtual Cookie Jar for one profile + target domain. */
export interface MirendaCookie {
  name: string;
  value: string;
  /** Registrable domain the cookie belongs to. */
  domain: string;
  path: string;
  /** Unix epoch milliseconds. Absent means a session cookie. */
  expires?: number;
  /**
   * HttpOnly cookies are kept server-side by design. Page-runtime code never
   * receives them, and `MirendaCookieApi.set` ignores the flag.
   */
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** A browser tab owned by a profile. */
export interface MirendaTab {
  id: string;
  profileId: string;
  url: string;
  title: string;
  isActive: boolean;
  position: number;
  updatedAt: string;
}

/** Fields accepted when creating a tab. */
export interface MirendaTabCreate {
  url: string;
  profileId: string;
  title?: string;
}

/** Fields accepted when updating a tab. */
export interface MirendaTabPatch {
  url?: string;
  title?: string;
  isActive?: boolean;
  position?: number;
}

/** A request as it enters the proxy pipeline. Hooks may mutate this object. */
export interface ProxiedRequest {
  url: string;
  method: string;
  /** Lowercased header names. */
  headers: Record<string, string>;
  profileId: string;
  /** Hostname of `url`; the Virtual Cookie Jar key. */
  targetDomain: string;
}

/** Content a plugin wants injected before `</body>` of the proxied document. */
export interface PageInjection {
  kind: 'script' | 'style';
  content: string;
  /** Attribution shown in the injected payload's banner comment. */
  source: string;
}

/** A response on its way back to the client. Hooks may mutate this object. */
export interface ProxiedResponse {
  url: string;
  status: number;
  /** Lowercased header names. */
  headers: Record<string, string>;
  contentType: string | null;
  profileId: string;
  targetDomain: string;
  /** Extra payloads to append to the document. Only used for HTML responses. */
  injections: PageInjection[];
}

/**
 * Minimal structural view of a DOM element.
 *
 * Declared structurally instead of using the DOM lib so this package typechecks
 * in the Worker too, where `DOM` is not part of `lib`.
 */
export interface MirendaElementLike {
  textContent: string | null;
  readonly style: { cssText: string; opacity: string };
  readonly dataset: Record<string, string | undefined>;
  setAttribute(name: string, value: string): void;
  append(...nodes: unknown[]): void;
  remove(): void;
}

/** Minimal structural view of a DOM document. */
export interface MirendaDocumentLike {
  readonly title: string;
  querySelector<T = unknown>(selector: string): T | null;
  querySelectorAll<T = unknown>(selector: string): ArrayLike<T>;
  createElement(tagName: string): MirendaElementLike;
  readonly head: MirendaElementLike;
  readonly body: MirendaElementLike;
}

/** Minimal structural view of a DOM window. */
export interface MirendaWindowLike {
  readonly location: { readonly href: string };
  readonly document: MirendaDocumentLike;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void };
}

/** Context handed to `onPageInject` for the document being rendered. */
export interface PageInjectionInfo {
  /** Target URL of the proxied document. */
  url: string;
  title: string;
  profileId: string;
  /** The proxied document's own `window`; never Mirenda's host window. */
  window: MirendaWindowLike;
  document: MirendaDocumentLike;
}

/** Read access to the tab list. */
export interface MirendaTabsApi {
  list(): Promise<MirendaTab[]>;
  get(id: string): Promise<MirendaTab | undefined>;
  create(tab: MirendaTabCreate): Promise<MirendaTab>;
  update(id: string, patch: MirendaTabPatch): Promise<MirendaTab>;
  activate(id: string): Promise<void>;
  close(id: string): Promise<void>;
  /** Fires whenever a tab is created, updated or closed. Returns an unsubscribe fn. */
  onChanged(listener: (tabs: MirendaTab[]) => void): () => void;
}

/** A fetch response surfaced to plugins, decoded to text. */
export interface MirendaNetworkResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

/** Request interceptor; return a modified request or nothing to leave it alone. */
export type RequestInterceptor = (
  request: ProxiedRequest,
) => ProxiedRequest | void | Promise<ProxiedRequest | void>;

/** Network access, routed through the worker so CORS never blocks a plugin. */
export interface MirendaNetworkApi {
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<MirendaNetworkResponse>;
  addRequestInterceptor(interceptor: RequestInterceptor): () => void;
}

/** Virtual Cookie Jar access, scoped to the active profile. */
export interface MirendaCookiesApi {
  list(domain: string): Promise<MirendaCookie[]>;
  get(domain: string, name: string): Promise<MirendaCookie | undefined>;
  set(domain: string, cookie: Pick<MirendaCookie, 'name' | 'value'> & Partial<MirendaCookie>): Promise<void>;
  remove(domain: string, name: string): Promise<void>;
  clear(domain: string): Promise<void>;
}

/** Access to the document inside the proxied viewport. */
export interface MirendaPageApi {
  url(): string;
  title(): string;
  query<T = unknown>(selector: string): T | null;
  queryAll<T = unknown>(selector: string): T[];
  injectStyle(css: string): () => void;
  /** Short-lived toast inside the proxied page, styled by Mirenda. */
  notify(message: string, kind?: 'info' | 'warn' | 'error'): void;
  onNavigate(listener: (url: string) => void): () => void;
}

/** Per-plugin, per-profile key/value storage. Values must be JSON-serializable. */
export interface MirendaStorageApi {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

/** The `mirenda` object handed to every plugin hook. */
export interface MirendaApi {
  readonly plugin: { readonly id: string; readonly profileId: string };
  readonly tabs: MirendaTabsApi;
  readonly network: MirendaNetworkApi;
  readonly cookies: MirendaCookiesApi;
  readonly page: MirendaPageApi;
  readonly storage: MirendaStorageApi;
}

/**
 * A Mirenda extension. Implement only the hooks relevant to your `runtime`:
 * `onRequest`/`onResponse` run in the worker, `onPageInject` in the page.
 */
export interface MirendaPlugin {
  readonly manifest: MirendaManifest;
  /** Called once when the plugin is enabled. Use it to set up state. */
  onLoad?(api: MirendaApi): void | Promise<void>;
  /** Called in the proxied document before it is shown to the user. */
  onPageInject?(api: MirendaApi, page: PageInjectionInfo): void | Promise<void>;
  /** Called before the worker sends a request upstream. */
  onRequest?(request: ProxiedRequest, api: MirendaApi): ProxiedRequest | void | Promise<ProxiedRequest | void>;
  /** Called after the worker receives an upstream response. */
  onResponse?(response: ProxiedResponse, api: MirendaApi): ProxiedResponse | void | Promise<ProxiedResponse | void>;
  /** Called when the plugin is disabled or reloaded. */
  onUnload?(): void | Promise<void>;
}

/** Identity helper that keeps manifest inference precise. */
export function definePlugin(plugin: MirendaPlugin): MirendaPlugin {
  return plugin;
}

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const PERMISSIONS: readonly MirendaPermission[] = ['tabs', 'network', 'cookies', 'page', 'storage'];
const RUNTIMES: readonly PluginRuntime[] = ['page', 'worker', 'both'];

/** Validate an untrusted manifest object. Returns a list of problems (empty = valid). */
export function validateManifest(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) return ['manifest must be an object'];
  const m = value as Record<string, unknown>;

  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) {
    problems.push('id must be a lowercase slug such as "eruda-devtools"');
  }
  if (typeof m.name !== 'string' || m.name.trim() === '') problems.push('name is required');
  if (typeof m.version !== 'string' || !VERSION_PATTERN.test(m.version)) {
    problems.push('version must be semver, e.g. "1.0.0"');
  }
  if (typeof m.runtime !== 'string' || !RUNTIMES.includes(m.runtime as PluginRuntime)) {
    problems.push(`runtime must be one of ${RUNTIMES.join(', ')}`);
  }
  if (m.runtime === 'page' || m.runtime === 'both') {
    if (typeof m.entry !== 'string' || !m.entry.startsWith('/')) {
      problems.push('entry must be an absolute worker path, e.g. "/extensions/eruda-devtools.js"');
    }
  }
  if (m.matches !== undefined) {
    if (!Array.isArray(m.matches) || m.matches.some((p) => typeof p !== 'string')) {
      problems.push('matches must be an array of URL glob strings');
    }
  }
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      problems.push('permissions must be an array');
    } else {
      for (const p of m.permissions) {
        if (typeof p !== 'string' || !PERMISSIONS.includes(p as MirendaPermission)) {
          problems.push(`unknown permission: ${String(p)}`);
        }
      }
    }
  }
  return problems;
}

/**
 * Does this manifest apply to `url`? `*` is the only wildcard and matches any
 * run of characters; matching is case-insensitive against the full URL.
 */
export function manifestMatchesUrl(manifest: MirendaManifest, url: string): boolean {
  const patterns = manifest.matches;
  if (!patterns || patterns.length === 0 || patterns.includes('*')) return true;
  const target = url.toLowerCase();
  return patterns.some((pattern) => {
    const escaped = pattern
      .toLowerCase()
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${escaped}$`).test(target);
  });
}

/** True when the plugin declared (or defaulted to) the given permission. */
export function hasPermission(manifest: MirendaManifest, permission: MirendaPermission): boolean {
  return manifest.permissions?.includes(permission) ?? false;
}
