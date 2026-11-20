/**
 * The in-page runtime is generated source, so the only meaningful test is to
 * run it. Each test installs the shim in a real DOM (happy-dom) and then
 * exercises the browser APIs it patches, exactly as a page would.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { buildClientRuntimeScript } from '../src/proxy/client-runtime.js';

const PAGE = 'https://www.google.com/';
const CFG = {
  proxyPath: '/proxy',
  profileId: 'profile-1',
  proxyToken: 'tok-123',
  pageUrl: PAGE,
};

/** Decode the upstream target from a `/proxy` URL. */
function targetOf(value: string): string | null {
  const index = value.indexOf('?');
  if (index === -1) return null;
  return new URLSearchParams(value.slice(index + 1)).get('url');
}

let window: Window;

/** Install a fresh shim into a fresh window and return it. */
function install(): Window {
  const w = new Window({ url: PAGE });
  // `eval` runs the generated script in the window's own realm, which is what
  // the browser does when it executes the injected `<script>`.
  w.eval(buildClientRuntimeScript(CFG));
  return w;
}

beforeEach(() => {
  window = install();
});

describe('client runtime: installation', () => {
  it('exposes the runtime and installs once', () => {
    expect(window.__mirendaRuntime).toBeDefined();
    const first = window.__mirendaRuntime;
    // Re-running must not replace or double-patch.
    window.eval(buildClientRuntimeScript(CFG));
    expect(window.__mirendaRuntime).toBe(first);
  });

  it('reports the current logical target', () => {
    expect(window.__mirendaRuntime.currentTarget()).toBe(PAGE);
  });

  it('proxifies with the profile and token', () => {
    const out = window.__mirendaRuntime.proxify('https://a.test/x?y=1');
    expect(out).toBe('/proxy?url=https%3A%2F%2Fa.test%2Fx%3Fy%3D1&profileId=profile-1&pt=tok-123');
    expect(targetOf(out)).toBe('https://a.test/x?y=1');
  });

  it('resolves a relative reference against the upstream page', () => {
    expect(window.__mirendaRuntime.resolve('/search')).toBe('https://www.google.com/search');
  });

  it('refuses a non-http scheme', () => {
    expect(window.__mirendaRuntime.resolve('javascript:alert(1)')).toBeNull();
    expect(window.__mirendaRuntime.resolve('#anchor')).toBeNull();
  });
});

describe('client runtime: fetch', () => {
  it('routes a string URL through the proxy', async () => {
    const calls: string[] = [];
    const w = new Window({ url: PAGE });
    w.fetch = (async (input: unknown) => {
      calls.push(String(input));
      return new Response('ok');
    }) as unknown as typeof w.fetch;
    w.eval(buildClientRuntimeScript(CFG));

    await w.fetch('/api/data');
    expect(calls[0]).toBe('/proxy?url=https%3A%2F%2Fwww.google.com%2Fapi%2Fdata&profileId=profile-1&pt=tok-123');
  });

  it('does not wrap an already-proxied URL a second time', async () => {
    const seen: string[] = [];
    const w = new Window({ url: PAGE });
    w.fetch = (async (input: unknown) => {
      seen.push(String(input));
      return new Response('ok');
    }) as unknown as typeof w.fetch;
    w.eval(buildClientRuntimeScript(CFG));

    await w.fetch('/proxy?url=https%3A%2F%2Fa.test%2Fx&profileId=profile-1&pt=tok-123');
    expect(seen[0]!.match(/\/proxy\?/g)).toHaveLength(1);
  });

  it('leaves a cross-origin absolute URL proxied, not escaped', async () => {
    const seen: string[] = [];
    const w = new Window({ url: PAGE });
    w.fetch = (async (input: unknown) => {
      seen.push(String(input));
      return new Response('ok');
    }) as unknown as typeof w.fetch;
    w.eval(buildClientRuntimeScript(CFG));

    await w.fetch('https://cdn.example.com/x.js');
    expect(targetOf(seen[0]!)).toBe('https://cdn.example.com/x.js');
  });
});

describe('client runtime: XHR', () => {
  it('rewrites the URL passed to open()', () => {
    const w = new Window({ url: PAGE });
    // Record what the *native* layer receives, then let the shim wrap it.
    const received: string[] = [];
    w.XMLHttpRequest.prototype.open = function (_method: string, url: string) {
      received.push(String(url));
    } as never;
    w.eval(buildClientRuntimeScript(CFG));

    const xhr = new w.XMLHttpRequest();
    xhr.open('GET', '/rpc');
    expect(received[0]).toBe(
      '/proxy?url=https%3A%2F%2Fwww.google.com%2Frpc&profileId=profile-1&pt=tok-123',
    );
  });
});

describe('client runtime: GET forms', () => {
  it('prevents the native submit and navigates through the proxy', () => {
    const w = new Window({ url: PAGE });
    const assign = vi.fn();
    // happy-dom's location is read-only; replace `assign` before the shim runs.
    Object.defineProperty(w.location, 'assign', { value: assign, configurable: true });
    w.eval(buildClientRuntimeScript(CFG));

    w.document.body.innerHTML =
      '<form action="/search" method="GET"><input name="q" value="cloudflare workers"></form>';
    const form = w.document.querySelector('form')!;
    const event = new w.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    // The proxy params must survive; only the *target* gains `q`.
    const navigated = String(assign.mock.calls[0]![0]);
    expect(navigated.startsWith('/proxy?')).toBe(true);
    expect(targetOf(navigated)).toBe('https://www.google.com/search?q=cloudflare+workers');
  });

  it('keeps a query the action already carries', () => {
    const w = new Window({ url: PAGE });
    const assign = vi.fn();
    Object.defineProperty(w.location, 'assign', { value: assign, configurable: true });
    w.eval(buildClientRuntimeScript(CFG));

    w.document.body.innerHTML =
      '<form action="/search?hl=en" method="get"><input name="q" value="x"></form>';
    w.document
      .querySelector('form')!
      .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

    expect(targetOf(String(assign.mock.calls[0]![0]))).toBe('https://www.google.com/search?hl=en&q=x');
  });

  it('defaults to GET when the form has no method', () => {
    const w = new Window({ url: PAGE });
    const assign = vi.fn();
    Object.defineProperty(w.location, 'assign', { value: assign, configurable: true });
    w.eval(buildClientRuntimeScript(CFG));

    w.document.body.innerHTML = '<form action="/find"><input name="q" value="v"></form>';
    w.document
      .querySelector('form')!
      .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

    expect(targetOf(String(assign.mock.calls[0]![0]))).toBe('https://www.google.com/find?q=v');
  });

  it('leaves a POST form to the browser but repoints its action', () => {
    const w = new Window({ url: PAGE });
    w.eval(buildClientRuntimeScript(CFG));

    w.document.body.innerHTML =
      '<form action="/login" method="POST"><input name="user" value="a"></form>';
    const form = w.document.querySelector('form')!;
    const event = new w.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(targetOf(form.getAttribute('action')!)).toBe('https://www.google.com/login');
  });
});

describe('client runtime: history', () => {
  it('does not throw when pushState is rejected', () => {
    const w = new Window({ url: PAGE });
    // Simulate an opaque origin: the *native* call throws SecurityError. The
    // shim must swallow it so the page's own state machine keeps running.
    w.history.pushState = () => {
      throw new w.DOMException('blocked', 'SecurityError');
    };
    w.eval(buildClientRuntimeScript(CFG));

    expect(() => w.history.pushState({}, '', '/next')).not.toThrow();
    // The logical target still advances so later relative URLs resolve.
    expect(w.__mirendaRuntime.currentTarget()).toBe('https://www.google.com/next');
  });

  it('still forwards the call when the browser accepts it', () => {
    const w = new Window({ url: PAGE });
    const seen: unknown[] = [];
    w.history.replaceState = (_state: unknown, _title: string, url?: string) => {
      seen.push(url);
    };
    w.eval(buildClientRuntimeScript(CFG));

    w.history.replaceState({ a: 1 }, '', '/a/b');
    expect(seen).toEqual(['/a/b']);
    expect(w.__mirendaRuntime.currentTarget()).toBe('https://www.google.com/a/b');
  });
});

describe('client runtime: DOM attributes', () => {
  it('rewrites src set through setAttribute', () => {
    const w = new Window({ url: PAGE });
    w.eval(buildClientRuntimeScript(CFG));

    const img = w.document.createElement('img');
    img.setAttribute('src', '/logo.png');
    expect(targetOf(img.getAttribute('src')!)).toBe('https://www.google.com/logo.png');
  });

  it('rewrites src assigned through the property', () => {
    const w = new Window({ url: PAGE });
    w.eval(buildClientRuntimeScript(CFG));

    const img = w.document.createElement('img');
    img.src = '/logo.png';
    expect(targetOf(img.getAttribute('src')!)).toBe('https://www.google.com/logo.png');
  });

  it('leaves a non-URL attribute alone', () => {
    const w = new Window({ url: PAGE });
    w.eval(buildClientRuntimeScript(CFG));

    const div = w.document.createElement('div');
    div.setAttribute('data-id', '/not-a-url');
    expect(div.getAttribute('data-id')).toBe('/not-a-url');
  });
});

describe('client runtime: storage fallback', () => {
  it('provides a working in-memory store when the real one throws', () => {
    const w = new Window({ url: PAGE });
    // An opaque-origin frame throws on any storage access.
    Object.defineProperty(w, 'localStorage', {
      configurable: true,
      get() {
        throw new w.DOMException('blocked', 'SecurityError');
      },
    });
    w.eval(buildClientRuntimeScript(CFG));

    w.localStorage.setItem('k', 'v');
    expect(w.localStorage.getItem('k')).toBe('v');
    expect(w.localStorage.length).toBe(1);
    w.localStorage.removeItem('k');
    expect(w.localStorage.getItem('k')).toBeNull();
  });

  it('keeps the real storage when it works', () => {
    const w = new Window({ url: PAGE });
    w.localStorage.setItem('before', 'kept');
    w.eval(buildClientRuntimeScript(CFG));
    expect(w.localStorage.getItem('before')).toBe('kept');
  });
});

/**
 * An opaque-origin frame (sandbox without `allow-same-origin`) throws
 * SecurityError on cookie/storage/IDB/Cache/serviceWorker access. These tests
 * model that by making the native accessors throw, then assert the shim keeps
 * page code running instead of aborting.
 *
 * The behaviour was measured in Chromium: `document.cookie`, `localStorage`,
 * `sessionStorage`, `indexedDB.open()`, `caches` (property access) and
 * `navigator.serviceWorker` all throw, while `BroadcastChannel` works.
 */
function makeOpaque(w: Window): void {
  Object.defineProperty(w, 'origin', { configurable: true, get: () => 'null' });
  Object.defineProperty(w.Document.prototype, 'cookie', {
    configurable: true,
    get() {
      throw new w.DOMException('blocked', 'SecurityError');
    },
    set() {
      throw new w.DOMException('blocked', 'SecurityError');
    },
  });
  Object.defineProperty(w, 'localStorage', {
    configurable: true,
    get() {
      throw new w.DOMException('blocked', 'SecurityError');
    },
  });
  Object.defineProperty(w, 'sessionStorage', {
    configurable: true,
    get() {
      throw new w.DOMException('blocked', 'SecurityError');
    },
  });
  Object.defineProperty(w, 'caches', {
    configurable: true,
    get() {
      throw new w.DOMException('blocked', 'SecurityError');
    },
  });
}

function installOpaque(): Window {
  const w = new Window({ url: PAGE });
  makeOpaque(w);
  w.eval(buildClientRuntimeScript(CFG));
  return w;
}

describe('client runtime: opaque origin detection', () => {
  it('reports whether the frame is opaque', () => {
    expect(install().__mirendaRuntime.opaque).toBe(false);
    expect(installOpaque().__mirendaRuntime.opaque).toBe(true);
  });
});

describe('client runtime: document.cookie shim', () => {
  it('does not throw when the page reads or writes cookies', () => {
    const w = installOpaque();
    expect(() => {
      w.document.cookie = 'a=1';
    }).not.toThrow();
    expect(w.document.cookie).toBe('a=1');
  });

  it('keeps several cookies and reads them back as a single string', () => {
    const w = installOpaque();
    w.document.cookie = 'one=1';
    w.document.cookie = 'two=2';
    const value = w.document.cookie;
    expect(value).toContain('one=1');
    expect(value).toContain('two=2');
    expect(value).toContain('; ');
  });

  it('replaces an existing cookie of the same name', () => {
    const w = installOpaque();
    w.document.cookie = 'a=first';
    w.document.cookie = 'a=second';
    expect(w.document.cookie).toBe('a=second');
  });

  it('ignores attributes such as path and domain when storing', () => {
    const w = installOpaque();
    w.document.cookie = 'token=abc; Path=/; Domain=example.com; Secure';
    expect(w.document.cookie).toBe('token=abc');
  });

  it('deletes a cookie when max-age is zero or negative', () => {
    const w = installOpaque();
    w.document.cookie = 'gone=1';
    expect(w.document.cookie).toBe('gone=1');
    w.document.cookie = 'gone=1; Max-Age=0';
    expect(w.document.cookie).toBe('');
  });

  it('leaves a real origin cookie untouched', () => {
    const w = new Window({ url: PAGE });
    w.eval(buildClientRuntimeScript(CFG));
    // A same-origin frame keeps the platform implementation, which happy-dom
    // backs with a real store.
    w.document.cookie = 'real=1';
    expect(w.document.cookie).toContain('real=1');
  });
});

describe('client runtime: indexedDB shim', () => {
  it('opens a database and resolves requests without throwing', async () => {
    const w = installOpaque();
    const opened = await new Promise<{ ok: boolean; store?: unknown }>((resolve) => {
      const req = w.indexedDB.open('db1');
      req.onsuccess = (event: { target: { result: unknown } }) => resolve({ ok: true, store: event.target.result });
      req.onerror = () => resolve({ ok: false });
    });
    expect(opened.ok).toBe(true);
  });

  it('round-trips a value through an object store', async () => {
    const w = installOpaque();
    const db = await new Promise<{
      createObjectStore(n: string): {
        put(v: unknown, k?: unknown): { onsuccess: unknown };
        get(k: unknown): { onsuccess: unknown; result: unknown };
      };
      transaction(n: string): { objectStore(n: string): unknown };
    }>((resolve) => {
      const req = w.indexedDB.open('db2');
      req.onsuccess = (event: { target: { result: never } }) => resolve(event.target.result);
    });

    const store = db.createObjectStore('items');
    await new Promise<void>((resolve) => {
      const put = store.put({ id: 'a', value: 42 }, 'a');
      put.onsuccess = () => resolve();
    });

    const fetched = await new Promise<unknown>((resolve) => {
      const get = db.transaction('items').objectStore('items') as {
        get(k: unknown): { onsuccess: unknown; result: unknown };
      };
      const req = get.get('a');
      req.onsuccess = () => resolve(req.result);
    });
    expect(fetched).toEqual({ id: 'a', value: 42 });
  });
});

describe('client runtime: caches shim', () => {
  it('exposes a CacheStorage that resolves instead of throwing', async () => {
    const w = installOpaque();
    const cache = await w.caches.open('v1');
    expect(await w.caches.has('v1')).toBe(true);
    expect(await cache.match('/missing')).toBeUndefined();
    expect(await w.caches.keys()).toContain('v1');
  });

  it('stores and returns a cached response', async () => {
    const w = installOpaque();
    const cache = await w.caches.open('v2');
    const response = new Response('body');
    await cache.put('/page', response);
    expect(await cache.match('/page')).toBe(response);
  });
});

describe('client runtime: service worker shim', () => {
  it('provides a resolvable registration surface', async () => {
    const w = installOpaque();
    await expect(w.navigator.serviceWorker.getRegistrations()).resolves.toEqual([]);
    await expect(w.navigator.serviceWorker.getRegistration()).resolves.toBeUndefined();
    const registration = await w.navigator.serviceWorker.register('/sw.js');
    expect(registration).toHaveProperty('scope');
  });

  it('exposes a resolved ready promise so startup does not hang', async () => {
    const w = installOpaque();
    await expect(w.navigator.serviceWorker.ready).resolves.toBeDefined();
  });
});

describe('client runtime: frame error reporting', () => {
  it('posts uncaught errors to the parent with the runtime channel', async () => {
    const w = new Window({ url: PAGE });
    const received: unknown[] = [];
    Object.defineProperty(w, 'parent', {
      configurable: true,
      value: { postMessage: (message: unknown) => received.push(message) },
    });
    w.eval(buildClientRuntimeScript(CFG));

    w.__mirendaRuntime.reportError('error', 'boom', 'file.js');
    expect(received).toHaveLength(1);
    const message = received[0] as { channel: string; kind: string; message: string };
    expect(message.channel).toBe('mirenda-frame-error');
    expect(message.kind).toBe('error');
    expect(message.message).toBe('boom');
  });

  it('reports an unhandled rejection', async () => {
    const w = new Window({ url: PAGE });
    const received: unknown[] = [];
    Object.defineProperty(w, 'parent', {
      configurable: true,
      value: { postMessage: (message: unknown) => received.push(message) },
    });
    w.eval(buildClientRuntimeScript(CFG));

    const event = new w.Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = new Error('async boom');
    w.dispatchEvent(event);

    expect(received.length).toBeGreaterThan(0);
    const message = received[received.length - 1] as { kind: string; message: string };
    expect(message.kind).toBe('unhandledrejection');
    expect(message.message).toBe('async boom');
  });
});

describe('client runtime: target attribute rewriting', () => {
  it('forces _top and _parent to _self via setAttribute', () => {
    const w = install();
    const anchor = w.document.createElement('a');
    anchor.setAttribute('target', '_top');
    expect(anchor.getAttribute('target')).toBe('_self');

    const form = w.document.createElement('form');
    form.setAttribute('target', '_parent');
    expect(form.getAttribute('target')).toBe('_self');
  });

  it('leaves other target values alone', () => {
    const w = install();
    const anchor = w.document.createElement('a');
    anchor.setAttribute('target', 'someframe');
    expect(anchor.getAttribute('target')).toBe('someframe');
  });
});

describe('client runtime: link interception', () => {
  it('routes a same-frame link click through the proxy', () => {
    const w = install();
    const assigned: string[] = [];
    Object.defineProperty(w.location, 'assign', {
      configurable: true,
      value: (url: string) => assigned.push(url),
    });

    const anchor = w.document.createElement('a');
    anchor.setAttribute('href', '/next');
    w.document.body.append(anchor);

    const click = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(click);

    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toContain('/proxy?url=');
    expect(decodeURIComponent(assigned[0]!)).toContain('https://www.google.com/next');
  });

  it('does not intercept a download link', () => {
    const w = install();
    const anchor = w.document.createElement('a');
    anchor.setAttribute('href', '/file.zip');
    anchor.setAttribute('download', '');
    w.document.body.append(anchor);

    // Assert on prevention rather than on `location.assign`: happy-dom also
    // performs a native navigation for an unhandled anchor click, so watching
    // `assign` cannot distinguish "our handler ran" from "the engine did it".
    const click = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it('prevents the default action for a normal link', () => {
    const w = install();
    const anchor = w.document.createElement('a');
    anchor.setAttribute('href', '/next');
    w.document.body.append(anchor);

    const click = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });
});
