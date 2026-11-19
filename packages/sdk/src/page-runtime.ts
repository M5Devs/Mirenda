/**
 * Page-runtime bridge.
 *
 * A proxied page is rendered in an iframe with `allow-scripts` and deliberately
 * **without** `allow-same-origin`, so its origin is opaque: it has no access to
 * Mirenda's cookies and cannot call the authenticated API. Extensions therefore
 * reach privileged APIs over `postMessage` to the Mirenda shell, which holds the
 * session and enforces scope.
 *
 * `window.mirenda` is installed by this module before any extension script runs.
 */
import type {
  MirendaApi,
  MirendaCookie,
  MirendaDocumentLike,
  MirendaElementLike,
  MirendaNetworkResponse,
  MirendaStorageApi,
  MirendaTab,
  MirendaTabCreate,
  MirendaTabPatch,
  MirendaWindowLike,
} from './types.js';

/** Message envelope: page → shell request, shell → page reply. */
export interface BridgeRequest {
  channel: 'mirenda-rpc';
  id: number;
  method: string;
  params: unknown;
}

export interface BridgeResponse {
  channel: 'mirenda-rpc-reply';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Methods the shell implements. Kept explicit so the contract is auditable. */
export type BridgeMethod =
  | 'tabs.list'
  | 'tabs.get'
  | 'tabs.create'
  | 'tabs.update'
  | 'tabs.activate'
  | 'tabs.close'
  | 'network.fetch'
  | 'cookies.list'
  | 'cookies.get'
  | 'cookies.set'
  | 'cookies.remove'
  | 'cookies.clear'
  | 'storage.get'
  | 'storage.set'
  | 'storage.remove'
  | 'storage.keys'
  | 'storage.clear';

export interface PageRuntimeOptions {
  pluginId: string;
  profileId: string;
  /** Target URL of the document being extended. */
  url: string;
  /** Reply timeout in ms. Defaults to 15s. */
  timeoutMs?: number;
  /** The window to install onto; defaults to the global. */
  target?: MirendaWindowLike;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Install `window.mirenda` for one plugin. Returns the API object so a plugin
 * can also receive it through `onPageInject`.
 */
export function installPageRuntime(options: PageRuntimeOptions): MirendaApi {
  const target = options.target ?? (globalThis as unknown as { window: MirendaWindowLike }).window;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pending = new Map<number, Pending>();
  let nextId = 1;

  target.addEventListener('message', (event: unknown) => {
    const data = (event as { data?: Partial<BridgeResponse> }).data ?? null;
    if (!data || data.channel !== 'mirenda-rpc-reply' || typeof data.id !== 'number') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error ?? 'bridge call failed'));
  });

  function call<T>(method: BridgeMethod, params: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`mirenda bridge timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const request: BridgeRequest = { channel: 'mirenda-rpc', id, method, params };
      // `*` is safe here: the payload is a request, never a secret, and the shell
      // validates the sender window before answering.
      target.parent.postMessage(request, '*');
    });
  }

  const storage: MirendaStorageApi = {
    get: <T = unknown>(key: string) => call<T | undefined>('storage.get', { key }),
    set: async (key: string, value: unknown) => {
      await call<void>('storage.set', { key, value });
    },
    remove: async (key: string) => {
      await call<void>('storage.remove', { key });
    },
    keys: () => call<string[]>('storage.keys', {}),
    clear: async () => {
      await call<void>('storage.clear', {});
    },
  };

  const api: MirendaApi = {
    plugin: { id: options.pluginId, profileId: options.profileId },
    tabs: {
      list: () => call<MirendaTab[]>('tabs.list', {}),
      get: (id: string) => call<MirendaTab | undefined>('tabs.get', { id }),
      create: (tab: MirendaTabCreate) => call<MirendaTab>('tabs.create', tab),
      update: (id: string, patch: MirendaTabPatch) => call<MirendaTab>('tabs.update', { id, patch }),
      activate: async (id: string) => {
        await call<void>('tabs.activate', { id });
      },
      close: async (id: string) => {
        await call<void>('tabs.close', { id });
      },
      onChanged: () => {
        // Tab change events are delivered by the shell as a DOM event on the
        // iframe element, which the page cannot observe. Polling is not offered;
        // extensions that need liveness re-read `list()` on user action.
        return () => undefined;
      },
    },
    network: {
      fetch: (url, init) => call<MirendaNetworkResponse>('network.fetch', { url, init }),
      addRequestInterceptor: () => () => undefined,
    },
    cookies: {
      list: (domain: string) => call<MirendaCookie[]>('cookies.list', { domain }),
      get: (domain: string, name: string) => call<MirendaCookie | undefined>('cookies.get', { domain, name }),
      set: async (domain, cookie) => {
        await call<void>('cookies.set', { domain, cookie });
      },
      remove: async (domain: string, name: string) => {
        await call<void>('cookies.remove', { domain, name });
      },
      clear: async (domain: string) => {
        await call<void>('cookies.clear', { domain });
      },
    },
    page: createPageApi(target, options.url),
    storage,
  };

  Object.defineProperty(target, 'mirenda', {
    value: api,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  return api;
}

/** The page API needs no shell: it operates on the document it is installed in. */
function createPageApi(target: MirendaWindowLike, initialUrl: string): MirendaApi['page'] {
  let currentUrl = initialUrl;
  const navigationListeners = new Set<(url: string) => void>();

  return {
    url: () => currentUrl,
    title: () => target.document.title,
    query: <T = unknown>(selector: string) => target.document.querySelector<T>(selector),
    queryAll: <T = unknown>(selector: string) => {
      const nodes = target.document.querySelectorAll<T>(selector);
      return Array.from({ length: nodes.length }, (_, index) => nodes[index] as T);
    },
    injectStyle(css: string) {
      const style = target.document.createElement('style');
      style.textContent = css;
      style.dataset['mirendaStyle'] = 'true';
      target.document.head.append(style);
      return () => style.remove();
    },
    notify(message: string, kind: 'info' | 'warn' | 'error' = 'info') {
      const toast: MirendaElementLike = target.document.createElement('div');
      toast.textContent = message;
      toast.setAttribute('role', 'status');
      const color = kind === 'error' ? '#ff5c6c' : kind === 'warn' ? '#ffb020' : '#4f8cff';
      toast.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:96px',
        'transform:translateX(-50%)',
        'max-width:80vw',
        'padding:10px 16px',
        'border-radius:999px',
        'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
        'color:#fff',
        `background:${color}`,
        'box-shadow:0 10px 30px rgba(0,0,0,.4)',
        'z-index:2147483647',
        'pointer-events:none',
        'transition:opacity .2s ease',
      ].join(';');
      target.document.body.append(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 220);
      }, 2200);
    },
    onNavigate(listener) {
      navigationListeners.add(listener);
      const update = (): void => {
        const next = target.location.href;
        if (next === currentUrl) return;
        currentUrl = next;
        for (const entry of navigationListeners) entry(next);
      };
      // A proxied page is a full document load per navigation, so a poll is the
      // only signal available inside the sandbox; it is cheap and self-cancelling.
      const interval = setInterval(update, 1000);
      return () => {
        clearInterval(interval);
        navigationListeners.delete(listener);
      };
    },
  };
}
