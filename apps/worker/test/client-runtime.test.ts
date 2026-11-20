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
