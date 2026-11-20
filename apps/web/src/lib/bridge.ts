/**
 * Shell side of the app ⇄ sandbox RPC bridge.
 *
 * The sandboxed viewport runs proxied pages and extension scripts. It is an
 * opaque-origin frame, so nothing it sends can be trusted by default. This
 * module is the *only* place that answers it, and it enforces three rules:
 *
 *   1. **Source, not origin.** `event.source` must be the exact iframe this
 *      shell created. `event.origin` is `'null'` for every sandboxed frame, so
 *      it cannot distinguish our viewport from any other opaque frame a hostile
 *      page might create — using it alone would be a real vulnerability.
 *   2. **Method allowlist.** Only `SANDBOX_RPC_METHODS` are answered. There is no
 *      auth, vault, or profile-mutation path, so a compromised page cannot reach
 *      the master key even if it guesses a method name.
 *   3. **Server-side scoping.** Every call is executed against the API with the
 *      active profile, and the profile id is never taken from the message.
 *
 * Replies go to the viewport with `'*'` because the viewport's origin is opaque:
 * there is no origin string to target. That is safe *because* the request was
 * validated by source and the payload never contains secrets.
 */
import { isSandboxRpcMethod, isTrustedViewportMessage, type SandboxRpcMethod } from '@mirenda/sdk';

/** Envelope the page runtime sends (`mirenda-rpc`). */
interface RpcRequest {
  channel: 'mirenda-rpc';
  id: number;
  /** Which plugin is calling; scopes `storage`. Validated by the worker. */
  pluginId: string;
  method: string;
  params: unknown;
}

interface RpcReply {
  channel: 'mirenda-rpc-reply';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** The capabilities the shell exposes. Deliberately narrow. */
export interface SandboxRpcHandlers {
  tabs: {
    list(): Promise<unknown>;
    get(id: string): Promise<unknown>;
    create(input: unknown): Promise<unknown>;
    update(id: string, patch: unknown): Promise<unknown>;
    activate(id: string): Promise<void>;
    close(id: string): Promise<void>;
  };
  cookies: {
    list(domain: string): Promise<unknown>;
    get(domain: string, name: string): Promise<unknown>;
    set(domain: string, cookie: unknown): Promise<void>;
    remove(domain: string, name: string): Promise<void>;
    clear(domain: string): Promise<void>;
  };
  storage: {
    /** `pluginId` scopes the namespace; it comes from the validated envelope. */
    get(pluginId: string, key: string): Promise<unknown>;
    set(pluginId: string, key: string, value: unknown): Promise<void>;
    remove(pluginId: string, key: string): Promise<void>;
    keys(pluginId: string): Promise<string[]>;
    clear(pluginId: string): Promise<void>;
  };
}

/** Narrow an unknown params object to a string field, or throw. */
function requireString(params: unknown, field: string): string {
  if (typeof params !== 'object' || params === null) throw new Error(`${field} is required`);
  const value = (params as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value === '') throw new Error(`${field} must be a non-empty string`);
  return value;
}

/**
 * Execute one allowlisted method. Split out from the message plumbing so the
 * dispatch table is easy to audit: every branch here is a method in
 * `SANDBOX_RPC_METHODS`, and nothing else is reachable.
 */
async function dispatch(
  handlers: SandboxRpcHandlers,
  method: SandboxRpcMethod,
  params: unknown,
  pluginId: string,
): Promise<unknown> {
  switch (method) {
    case 'tabs.list':
      return handlers.tabs.list();
    case 'tabs.get':
      return handlers.tabs.get(requireString(params, 'id'));
    case 'tabs.create':
      return handlers.tabs.create(params);
    case 'tabs.update':
      return handlers.tabs.update(requireString(params, 'id'), (params as { patch?: unknown }).patch);
    case 'tabs.activate':
      return handlers.tabs.activate(requireString(params, 'id'));
    case 'tabs.close':
      return handlers.tabs.close(requireString(params, 'id'));

    case 'cookies.list':
      return handlers.cookies.list(requireString(params, 'domain'));
    case 'cookies.get':
      return handlers.cookies.get(requireString(params, 'domain'), requireString(params, 'name'));
    case 'cookies.set':
      return handlers.cookies.set(requireString(params, 'domain'), (params as { cookie?: unknown }).cookie);
    case 'cookies.remove':
      return handlers.cookies.remove(requireString(params, 'domain'), requireString(params, 'name'));
    case 'cookies.clear':
      return handlers.cookies.clear(requireString(params, 'domain'));

    case 'storage.get':
      return handlers.storage.get(pluginId, requireString(params, 'key'));
    case 'storage.set':
      return handlers.storage.set(
        pluginId,
        requireString(params, 'key'),
        (params as { value?: unknown }).value,
      );
    case 'storage.remove':
      return handlers.storage.remove(pluginId, requireString(params, 'key'));
    case 'storage.keys':
      return handlers.storage.keys(pluginId);
    case 'storage.clear':
      return handlers.storage.clear(pluginId);

    default: {
      // Exhaustive: a new method in the SDK union must be handled here.
      const never: never = method;
      throw new Error(`unhandled method: ${String(never)}`);
    }
  }
}

export interface BridgeOptions {
  handlers: SandboxRpcHandlers;
  /** Called for every rejected message, for diagnostics. Never logs payloads. */
  onReject?: (reason: string) => void;
}

export interface SandboxBridge {
  /** Attach the iframe whose messages are trusted. Pass `null` to detach. */
  setViewport(frame: HTMLIFrameElement | null): void;
  /** Stop listening entirely. */
  dispose(): void;
}

/**
 * Install the bridge on the shell window.
 *
 * Returns a handle so the caller can point it at a new iframe on every
 * navigation, and detach it when the viewport is torn down.
 */
export function installSandboxBridge(options: BridgeOptions): SandboxBridge {
  let viewport: HTMLIFrameElement | null = null;

  const listener = (event: MessageEvent): void => {
    const data = event.data as Partial<RpcRequest> | null;
    if (!data || typeof data !== 'object' || data.channel !== 'mirenda-rpc') return;

    // Rule 1: only the viewport we created. Shared with the SDK so the shell
    // and any other consumer of the trust boundary cannot drift apart.
    const contentWindow = viewport?.contentWindow ?? null;
    if (!isTrustedViewportMessage({ source: event.source, origin: event.origin }, contentWindow)) {
      options.onReject?.('untrusted source or origin');
      return;
    }
    // `isTrustedViewportMessage` proves the frame is ours; this narrows the type
    // so the reply path below has a non-null window.
    if (contentWindow === null) return;

    // Rule 2: allowlisted methods only.
    if (typeof data.id !== 'number' || !isSandboxRpcMethod(data.method)) {
      options.onReject?.('method not allowed');
      // Answer a known id so the caller's promise settles instead of hanging.
      if (typeof data.id === 'number') {
        reply(contentWindow, { channel: 'mirenda-rpc-reply', id: data.id, ok: false, error: 'method not allowed' });
      }
      return;
    }

    const id = data.id;
    const method = data.method;
    const pluginId = typeof data.pluginId === 'string' ? data.pluginId : '';
    void dispatch(options.handlers, method, data.params, pluginId)
      .then((result) => reply(contentWindow, { channel: 'mirenda-rpc-reply', id, ok: true, result }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'bridge call failed';
        reply(contentWindow, { channel: 'mirenda-rpc-reply', id, ok: false, error: message });
      });
  };

  window.addEventListener('message', listener);

  return {
    setViewport(frame) {
      viewport = frame;
    },
    dispose() {
      window.removeEventListener('message', listener);
      viewport = null;
    },
  };
}

/**
 * Send a reply to the viewport. The target origin is `'*'` because the sandbox
 * has an opaque origin; the request was already validated by source, and the
 * reply never contains credentials.
 */
function reply(target: Window, message: RpcReply): void {
  try {
    target.postMessage(message, '*');
  } catch {
    // A torn-down frame throws on postMessage; nothing to do.
  }
}
