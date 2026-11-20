/**
 * The in-page proxy runtime.
 *
 * Server-side HTML rewriting can only fix what is in the markup at response
 * time. A modern page keeps issuing requests afterwards — `fetch`, `XHR`,
 * `history.pushState`, and elements built in JS — and every one of those would
 * bypass `/proxy`, either hitting the sandbox origin (404) or escaping to the
 * target directly (and then being blocked by CORS or the opaque origin).
 *
 * This shim is injected as the *first* thing in `<head>` so it is installed
 * before any page script runs, and patches just enough of the platform to keep
 * that traffic inside the proxy. It is deliberately dependency-free and does
 * not touch `@mirenda/sdk` plugin payloads, which are appended separately.
 *
 * The script is emitted as a string rather than authored as a module: the worker
 * is compiled with `lib: ["ES2022"]` and no DOM types, so browser globals would
 * not typecheck here. Keep it self-contained — it cannot close over imports.
 */

export interface ClientRuntimeConfig {
  /** Mount path of the proxy, e.g. `/proxy`. */
  proxyPath: string;
  /** Profile the page belongs to; every rewritten request carries it. */
  profileId: string;
  /** Scoped proxy token, when the deployment is split across origins. */
  proxyToken?: string;
  /** Absolute upstream URL of the document being served. */
  pageUrl: string;
}

/** Escape a value for embedding inside a `<script>` body. */
function jsString(value: string): string {
  // `</script>` inside a string literal would terminate the element early.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Build the runtime `<script>` body for one proxied document.
 *
 * Returned text is wrapped in an IIFE and is safe to inject with
 * `{ html: false }` (it contains no markup).
 */
export function buildClientRuntimeScript(config: ClientRuntimeConfig): string {
  const cfg = [
    `proxyPath: ${jsString(config.proxyPath)}`,
    `profileId: ${jsString(config.profileId)}`,
    `proxyToken: ${config.proxyToken ? jsString(config.proxyToken) : 'null'}`,
    `pageUrl: ${jsString(config.pageUrl)}`,
  ].join(', ');

  return `(function () {
  "use strict";
  if (window.__mirendaRuntime) return;
  var CFG = { ${cfg} };

  // Virtual document URL. With a sandboxed (opaque-origin) frame the real URL
  // cannot be changed by pushState, so the logical location is tracked here.
  var currentTarget = CFG.pageUrl;
  var proxyPrefix = CFG.proxyPath + "?";

  function isPassthrough(u) {
    return /^(?:javascript|mailto|tel|sms|data|blob|about|chrome|file|magnet|intent):/i.test(u) || u.charAt(0) === "#";
  }

  // Resolve a possibly-relative reference against the *upstream* document.
  function absolute(u) {
    if (u === null || u === undefined) return null;
    var s = String(u).trim();
    if (!s || isPassthrough(s)) return null;
    try {
      var r = new URL(s, currentTarget);
      if (r.protocol !== "http:" && r.protocol !== "https:") return null;
      return r.toString();
    } catch (e) {
      return null;
    }
  }

  function proxify(target) {
    var out = CFG.proxyPath + "?url=" + encodeURIComponent(target) +
      "&profileId=" + encodeURIComponent(CFG.profileId);
    if (CFG.proxyToken) out += "&pt=" + encodeURIComponent(CFG.proxyToken);
    return out;
  }

  // If a value is already a proxy URL, recover its upstream target so it is not
  // wrapped a second time (which would nest /proxy inside /proxy).
  function unwrap(u) {
    if (u.indexOf(proxyPrefix) !== 0) return null;
    try {
      return new URLSearchParams(u.slice(proxyPrefix.length)).get("url");
    } catch (e) {
      return null;
    }
  }

  function toProxy(u) {
    var inner = unwrap(u);
    if (inner) return proxify(inner);
    var abs = absolute(u);
    return abs ? proxify(abs) : null;
  }

  function navigate(u) {
    var p = toProxy(u);
    if (!p) return false;
    currentTarget = absolute(unwrap(p) || u) || currentTarget;
    try {
      window.location.assign(p);
    } catch (e) {
      window.location.href = p;
    }
    return true;
  }

  /* ---------------------------------------------------------------- fetch */
  if (typeof window.fetch === "function") {
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string" || input instanceof URL) {
          var p = toProxy(String(input));
          if (p) input = p;
        } else if (input && typeof input === "object" && typeof input.url === "string") {
          var target = toProxy(input.url);
          if (target) {
            // Rebuild the Request so method/headers/body survive the swap.
            input = new Request(target, input);
          }
        }
      } catch (e) {
        /* fall through to the native call */
      }
      return nativeFetch.call(window, input, init);
    };
  }

  /* ------------------------------------------------------------------ XHR */
  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
    var nativeOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      try {
        var p = toProxy(String(url));
        if (p) args[1] = p;
      } catch (e) {
        /* keep the original URL */
      }
      return nativeOpen.apply(this, args);
    };
  }

  /* --------------------------------------------------------------- forms */
  // A GET form submits by *replacing* the query string, which would wipe the
  // proxy's own url/pt params. Intercept it, fold the fields into the
  // upstream URL, and navigate through the proxy instead.
  function formEntries(form) {
    var out = [];
    var data;
    try {
      data = new FormData(form);
    } catch (e) {
      return out;
    }
    data.forEach(function (value, name) {
      if (typeof value === "string") out.push([name, value]);
    });
    return out;
  }

  document.addEventListener(
    "submit",
    function (event) {
      var form = event.target;
      if (!form || form.tagName !== "FORM") return;
      var method = (form.getAttribute("method") || "get").toLowerCase();
      var action = form.getAttribute("action") || currentTarget;

      // A POST form can be left to the browser: its body is forwarded by the
      // worker, and only the action needs to point at the proxy.
      if (method === "post") {
        var postTarget = toProxy(action);
        if (postTarget) form.setAttribute("action", postTarget);
        return;
      }
      if (method !== "get") return;

      var inner = unwrap(action);
      var base = inner ? absolute(inner) : absolute(action);
      if (!base) return;
      event.preventDefault();

      var url;
      try {
        url = new URL(base);
      } catch (e) {
        return;
      }
      formEntries(form).forEach(function (pair) {
        url.searchParams.append(pair[0], pair[1]);
      });
      navigate(url.toString());
    },
    true,
  );

  /* ------------------------------------------------------------- history */
  // pushState throws SecurityError in an opaque origin. Track the logical URL
  // and forward the call only when the browser will accept it.
  function patchHistory(name) {
    var native = window.history && window.history[name];
    if (typeof native !== "function") return;
    window.history[name] = function (state, title, url) {
      if (url !== undefined && url !== null) {
        var abs = absolute(String(url));
        if (abs) currentTarget = abs;
      }
      try {
        return native.call(window.history, state, title, url);
      } catch (e) {
        // Opaque origin: the entry cannot be created, but the page's own state
        // machine still expects the call to succeed.
        return undefined;
      }
    };
  }
  patchHistory("pushState");
  patchHistory("replaceState");

  /* ------------------------------------------------------- DOM attributes */
  var URL_ATTRS = { src: 1, href: 1, action: 1, formaction: 1, poster: 1, data: 1 };

  function rewriteAttr(name, value) {
    if (value === null || value === undefined) return value;
    var lower = String(name).toLowerCase();
    if (!URL_ATTRS[lower]) return value;
    var p = toProxy(String(value));
    return p || value;
  }

  if (window.Element && window.Element.prototype) {
    var nativeSetAttribute = window.Element.prototype.setAttribute;
    window.Element.prototype.setAttribute = function (name, value) {
      try {
        return nativeSetAttribute.call(this, name, rewriteAttr(name, value));
      } catch (e) {
        return nativeSetAttribute.call(this, name, value);
      }
    };

    // img.src = ... bypasses setAttribute, so the common URL properties are
    // given accessors that route through the same rewrite.
    var PROP_HOSTS = [
      [window.HTMLImageElement, "src"],
      [window.HTMLScriptElement, "src"],
      [window.HTMLLinkElement, "href"],
      [window.HTMLIFrameElement, "src"],
      [window.HTMLSourceElement, "src"],
      [window.HTMLMediaElement, "src"],
      [window.HTMLFormElement, "action"],
      [window.HTMLAnchorElement, "href"],
      [window.HTMLAreaElement, "href"],
    ];
    PROP_HOSTS.forEach(function (entry) {
      var ctor = entry[0];
      var prop = entry[1];
      if (!ctor || !ctor.prototype) return;
      var desc = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
      if (!desc || !desc.set || !desc.configurable) return;
      var proto = ctor.prototype;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (value) {
          var p = null;
          try {
            p = toProxy(String(value));
          } catch (e) {
            p = null;
          }
          desc.set.call(this, p || value);
        },
      });
    });
  }

  /* ------------------------------------------------------------- storage */
  // An opaque origin throws SecurityError on storage access. Sites commonly
  // treat that as fatal (DuckDuckGo's bundle aborts to a black screen), so fall
  // back to an in-memory store with the same surface.
  function memoryStorage() {
    var map = Object.create(null);
    return {
      getItem: function (k) {
        k = String(k);
        return k in map ? map[k] : null;
      },
      setItem: function (k, v) {
        map[String(k)] = String(v);
      },
      removeItem: function (k) {
        delete map[String(k)];
      },
      clear: function () {
        map = Object.create(null);
      },
      key: function (i) {
        return Object.keys(map)[i] || null;
      },
      get length() {
        return Object.keys(map).length;
      },
    };
  }

  function guardStorage(name) {
    try {
      var store = window[name];
      // Touching a method is what actually throws under an opaque origin.
      store.setItem("__mirenda_probe__", "1");
      store.removeItem("__mirenda_probe__");
      return;
    } catch (e) {
      /* install the fallback below */
    }
    var fallback = memoryStorage();
    try {
      Object.defineProperty(window, name, { configurable: true, value: fallback });
    } catch (e) {
      /* if it cannot be replaced, the page simply keeps its SecurityError */
    }
  }
  guardStorage("localStorage");
  guardStorage("sessionStorage");

  /* ---------------------------------------------------------- public API */
  // Exposed for extensions and for debugging; read-only in spirit.
  window.__mirendaRuntime = {
    proxify: proxify,
    resolve: absolute,
    currentTarget: function () {
      return currentTarget;
    },
  };
})();`;
}
