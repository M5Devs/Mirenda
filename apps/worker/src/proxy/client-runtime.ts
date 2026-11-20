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
 * ## Opaque-origin hardening
 *
 * Mirenda renders pages in `sandbox="allow-scripts"` *without*
 * `allow-same-origin`, so the frame's origin is opaque (`window.origin` is
 * `"null"`). That is a deliberate security boundary — it stops a proxied page
 * from reaching the shell's DOM or the derived master key — but it makes a
 * handful of storage APIs throw `SecurityError` on mere access. Measured in
 * Chromium from inside such a frame:
 *
 * | API                        | Behaviour                        |
 * | -------------------------- | -------------------------------- |
 * | `document.cookie` (r/w)    | throws `SecurityError`           |
 * | `localStorage`             | throws `SecurityError`           |
 * | `sessionStorage`           | throws `SecurityError`           |
 * | `indexedDB.open()`         | throws `SecurityError`           |
 * | `caches` (property access) | throws `SecurityError`           |
 * | `navigator.serviceWorker`  | throws `SecurityError` on access |
 * | `BroadcastChannel`         | works natively                   |
 *
 * Real sites treat those throws as fatal: DuckDuckGo's `home-toggle-prehydrate`
 * reads `document.cookie` during startup and aborts to a blank page; Google
 * fails the same way. Each throwing API therefore gets a memory-backed
 * stand-in with the same surface, so page code runs instead of dying.
 *
 * The fallbacks are *not* pretending to be durable storage. The authoritative
 * cookie store is the server-side jar keyed by (user, profile, domain), which
 * is what actually rides on outgoing HTTP requests. The in-page cookie shim
 * only keeps a synchronous mirror so a page that sets then reads a cookie
 * behaves sanely within one document's lifetime.
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

  // An opaque origin cannot touch cookies, real storage, IndexedDB, the Cache
  // API, or service workers. Detect it once; every fallback below keys off it.
  var OPAQUE = (function () {
    try {
      return window.origin === null || String(window.origin) === "null";
    } catch (e) {
      return true;
    }
  })();

  /* ------------------------------------------------------- error reporting */
  // Uncaught frame errors are invisible to the shell (it cannot read this
  // document), so surface them over postMessage for the diagnostic toast.
  // The shell validates event.source against its own iframe, so a hostile page
  // cannot use this channel to forge UI.
  function report(kind, message, detail) {
    try {
      parent.postMessage(
        {
          channel: "mirenda-frame-error",
          kind: kind,
          message: String(message == null ? "unknown" : message).slice(0, 400),
          detail: detail == null ? null : String(detail).slice(0, 200),
          pageUrl: currentTarget,
          profileId: CFG.profileId,
        },
        "*",
      );
    } catch (e) {
      /* the parent may be gone; nothing else to do */
    }
  }

  window.addEventListener("error", function (event) {
    var msg = event && event.message ? event.message : "script error";
    // A cross-origin "Script error." carries no detail; still worth surfacing.
    report("error", msg, event && event.filename ? event.filename : null);
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event ? event.reason : null;
    report(
      "unhandledrejection",
      reason && reason.message ? reason.message : reason,
      reason && reason.name ? reason.name : null,
    );
  });

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

  /* ---------------------------------------------------- link interception */
  // Server-side rewriting forces target="_self" in the markup, but links built
  // by JS — and _top/_parent on elements we could not reach — would escape the
  // sandbox by breaking out of the frame. The capture phase is the only
  // reliable place to stop that.
  document.addEventListener(
    "click",
    function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var node = event.target;
      while (node && node !== document && node.tagName !== "A") node = node.parentNode;
      if (!node || node.tagName !== "A") return;

      var href = node.getAttribute("href");
      if (!href || isPassthrough(href)) return;
      // A download is the page's own business; leave it alone.
      if (node.hasAttribute("download")) return;

      var p = toProxy(href);
      if (!p) return;
      event.preventDefault();
      event.stopPropagation();
      navigate(href);
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

  /* ---------------------------------------------------------- window.open */
  // A popup would open on the sandbox origin (404) or the bare target. Route it
  // through the proxy in the same frame so the navigation stays contained.
  if (typeof window.open === "function") {
    var nativeOpenWindow = window.open;
    window.open = function (url, name, features) {
      if (url && !isPassthrough(String(url))) {
        var p = toProxy(String(url));
        if (p) {
          navigate(String(url));
          return window;
        }
      }
      try {
        return nativeOpenWindow.call(window, url, name, features);
      } catch (e) {
        return null;
      }
    };
  }

  /* ------------------------------------------------------- DOM attributes */
  var URL_ATTRS = { src: 1, href: 1, action: 1, formaction: 1, poster: 1, data: 1 };

  function rewriteAttr(name, value) {
    if (value === null || value === undefined) return value;
    var lower = String(name).toLowerCase();
    // target="_top" / "_parent" escape the frame; force same-frame instead.
    if (lower === "target") {
      var t = String(value).toLowerCase();
      return t === "_top" || t === "_parent" ? "_self" : value;
    }
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
  // treat that as fatal, so fall back to an in-memory store with the same
  // surface.
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

  /* ------------------------------------------------------ document.cookie */
  // Reading or writing document.cookie throws SecurityError in an opaque
  // origin, and sites read it during startup (DuckDuckGo's prehydrate step
  // aborts the whole bundle). Keep a synchronous in-memory mirror keyed by
  // cookie name so the page's own logic works within this document.
  //
  // This is NOT the authoritative store: real cookies live in the server-side
  // jar and ride on outgoing requests. The mirror exists so set-then-get
  // behaves, not so cookies survive a reload.
  if (OPAQUE) {
    var cookieJar = Object.create(null);

    function parseCookieAssign(value) {
      var text = String(value);
      var semi = text.indexOf(";");
      var pair = semi === -1 ? text : text.slice(0, semi);
      var eq = pair.indexOf("=");
      if (eq <= 0) return;
      var name = pair.slice(0, eq).trim();
      if (!name) return;
      var val = pair.slice(eq + 1).trim();
      // Expiry is honoured loosely: a non-positive max-age deletes the entry.
      var attrs = semi === -1 ? "" : text.slice(semi + 1).toLowerCase();
      var maxAge = /max-age\\s*=\\s*(-?\\d+)/.exec(attrs);
      if (maxAge && Number(maxAge[1]) <= 0) {
        delete cookieJar[name];
        return;
      }
      cookieJar[name] = val;
    }

    function readCookies() {
      var parts = [];
      for (var name in cookieJar) parts.push(name + "=" + cookieJar[name]);
      return parts.join("; ");
    }

    // Define on the instance first: an own property is guaranteed to shadow
    // whatever the prototype chain provides, and some engines put the accessor
    // on an intermediate prototype where a Document.prototype patch would be
    // hidden. Fall back to the prototype only if the instance is sealed.
    var cookieDescriptor = {
      configurable: true,
      get: function () {
        return readCookies();
      },
      set: function (value) {
        parseCookieAssign(value);
      },
    };
    try {
      Object.defineProperty(document, "cookie", cookieDescriptor);
    } catch (e) {
      try {
        Object.defineProperty(Document.prototype, "cookie", cookieDescriptor);
      } catch (e2) {
        /* if it cannot be replaced, the page keeps its SecurityError */
      }
    }
  }

  /* ------------------------------------------------------------ indexedDB */
  // indexedDB.open() throws in an opaque origin. Provide a compact in-memory
  // implementation covering the calls sites make during startup, so feature
  // detection and version checks succeed instead of aborting.
  function createIndexedDbStub() {
    var stores = Object.create(null);

    function makeRequest() {
      var req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      req.addEventListener = function (type, fn) {
        if (type === "success") req.onsuccess = fn;
        else if (type === "error") req.onerror = fn;
        else if (type === "upgradeneeded") req.onupgradeneeded = fn;
      };
      req.removeEventListener = function () {};
      return req;
    }

    function fire(req, type, value) {
      setTimeout(function () {
        req.result = value;
        var handler = req["on" + type];
        if (typeof handler === "function") {
          try {
            handler({ target: req, type: type });
          } catch (e) {
            /* a page handler throwing is its own problem */
          }
        }
      }, 0);
    }

    function makeStore(name, data) {
      function valueRequest(fn) {
        var req = makeRequest();
        setTimeout(function () {
          try {
            req.result = fn();
            if (typeof req.onsuccess === "function") req.onsuccess({ target: req, type: "success" });
          } catch (e) {
            req.error = e;
            if (typeof req.onerror === "function") req.onerror({ target: req, type: "error" });
          }
        }, 0);
        return req;
      }

      function keyOf(keyOrRange) {
        return keyOrRange && typeof keyOrRange === "object" && "id" in keyOrRange
          ? keyOrRange.id
          : keyOrRange;
      }

      return {
        name: name,
        keyPath: "id",
        autoIncrement: false,
        get: function (key) {
          return valueRequest(function () {
            return data[keyOf(key)];
          });
        },
        getAll: function () {
          return valueRequest(function () {
            return Object.keys(data).map(function (k) {
              return data[k];
            });
          });
        },
        put: function (value, key) {
          return valueRequest(function () {
            var k = key === undefined ? value && value.id : key;
            data[k] = value;
            return k;
          });
        },
        add: function (value, key) {
          return this.put(value, key);
        },
        delete: function (key) {
          return valueRequest(function () {
            delete data[keyOf(key)];
            return undefined;
          });
        },
        clear: function () {
          return valueRequest(function () {
            for (var k in data) delete data[k];
            return undefined;
          });
        },
        count: function () {
          return valueRequest(function () {
            return Object.keys(data).length;
          });
        },
        createIndex: function () {
          return { name: name + "_index" };
        },
        index: function () {
          return { get: this.get, getAll: this.getAll };
        },
      };
    }

    function open(name) {
      var req = makeRequest();
      if (!stores[name]) stores[name] = Object.create(null);
      var data = stores[name];

      setTimeout(function () {
        var db = {
          name: name,
          version: 1,
          objectStoreNames: {
            contains: function (n) {
              return n in data;
            },
            length: 0,
          },
          createObjectStore: function (n) {
            if (!data[n]) data[n] = Object.create(null);
            return makeStore(n, data[n]);
          },
          deleteObjectStore: function (n) {
            delete data[n];
          },
          transaction: function (names) {
            var list = typeof names === "string" ? [names] : names || [];
            list.forEach(function (n) {
              if (!data[n]) data[n] = Object.create(null);
            });
            var tx = {
              mode: "readonly",
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore: function (n) {
                if (!data[n]) data[n] = Object.create(null);
                return makeStore(n, data[n]);
              },
              abort: function () {},
              addEventListener: function (type, fn) {
                if (type === "complete") tx.oncomplete = fn;
              },
            };
            // Transactions "complete" on the next tick, which is what pages
            // awaiting oncomplete before proceeding expect.
            setTimeout(function () {
              if (typeof tx.oncomplete === "function") tx.oncomplete({ target: tx, type: "complete" });
            }, 0);
            return tx;
          },
          close: function () {},
        };
        req.result = db;
        if (typeof req.onupgradeneeded === "function") {
          try {
            req.onupgradeneeded({ target: req, type: "upgradeneeded" });
          } catch (e) {
            /* ignore */
          }
        }
        if (typeof req.onsuccess === "function") req.onsuccess({ target: req, type: "success" });
      }, 0);

      return req;
    }

    return {
      open: open,
      deleteDatabase: function (name) {
        var req = makeRequest();
        delete stores[name];
        fire(req, "success", undefined);
        return req;
      },
      cmp: function (a, b) {
        return a === b ? 0 : a < b ? -1 : 1;
      },
      databases: function () {
        return Promise.resolve(
          Object.keys(stores).map(function (n) {
            return { name: n, version: 1 };
          }),
        );
      },
    };
  }

  function guardIndexedDb() {
    try {
      var idb = window.indexedDB;
      if (!idb || typeof idb.open !== "function") throw new Error("absent");
      if (!OPAQUE) return; // a real origin keeps the real implementation
    } catch (e) {
      /* fall through and install the stub */
    }
    try {
      Object.defineProperty(window, "indexedDB", {
        configurable: true,
        value: createIndexedDbStub(),
      });
    } catch (e) {
      /* leave whatever the platform provides */
    }
  }
  guardIndexedDb();

  /* ------------------------------------------------------------- Cache API */
  // Merely reading window.caches throws in an opaque origin (typeof caches
  // throws too), so the property itself has to be replaced, not just its
  // methods. The stub is a memory-backed no-op: service-worker style caching is
  // meaningless for a document that has no service worker.
  function guardCaches() {
    try {
      void window.caches;
      if (!OPAQUE) return;
    } catch (e) {
      /* fall through */
    }
    var cacheStore = Object.create(null);
    function makeCache(name) {
      var entries = cacheStore[name] || (cacheStore[name] = Object.create(null));
      function keyOf(request) {
        return typeof request === "string" ? request : (request && request.url) || String(request);
      }
      return {
        add: function () {
          return Promise.resolve();
        },
        addAll: function () {
          return Promise.resolve();
        },
        put: function (request, response) {
          entries[keyOf(request)] = response;
          return Promise.resolve();
        },
        match: function (request) {
          return Promise.resolve(entries[keyOf(request)]);
        },
        matchAll: function () {
          return Promise.resolve(
            Object.keys(entries).map(function (k) {
              return entries[k];
            }),
          );
        },
        delete: function (request) {
          var key = keyOf(request);
          var had = key in entries;
          delete entries[key];
          return Promise.resolve(had);
        },
        keys: function () {
          return Promise.resolve(
            Object.keys(entries).map(function (k) {
              return new Request(k);
            }),
          );
        },
      };
    }
    var storageStub = {
      open: function (name) {
        return Promise.resolve(makeCache(String(name)));
      },
      has: function (name) {
        return Promise.resolve(String(name) in cacheStore);
      },
      delete: function (name) {
        var had = String(name) in cacheStore;
        delete cacheStore[String(name)];
        return Promise.resolve(had);
      },
      keys: function () {
        return Promise.resolve(Object.keys(cacheStore));
      },
      match: function () {
        return Promise.resolve(undefined);
      },
    };
    try {
      Object.defineProperty(window, "caches", { configurable: true, value: storageStub });
    } catch (e) {
      /* leave whatever the platform provides */
    }
  }
  guardCaches();

  /* -------------------------------------------------------- service worker */
  // navigator.serviceWorker throws on access. A proxied page cannot register
  // one (there is no origin to scope it to), so expose an inert stand-in whose
  // promises resolve rather than hang — ready in particular is awaited by
  // many bundles during startup.
  function guardServiceWorker() {
    try {
      void navigator.serviceWorker;
      if (!OPAQUE) return;
    } catch (e) {
      /* fall through */
    }
    var container = {
      controller: null,
      oncontrollerchange: null,
      onmessage: null,
      ready: Promise.resolve({ active: null, scope: currentTarget }),
      register: function () {
        return Promise.resolve({
          active: null,
          scope: currentTarget,
          update: function () {
            return Promise.resolve();
          },
        });
      },
      getRegistration: function () {
        return Promise.resolve(undefined);
      },
      getRegistrations: function () {
        return Promise.resolve([]);
      },
      addEventListener: function () {},
      removeEventListener: function () {},
      startMessages: function () {},
    };
    try {
      Object.defineProperty(Navigator.prototype, "serviceWorker", {
        configurable: true,
        get: function () {
          return container;
        },
      });
    } catch (e) {
      /* leave whatever the platform provides */
    }
  }
  guardServiceWorker();

  /* ---------------------------------------------------- BroadcastChannel */
  // BroadcastChannel works in an opaque origin, but a page may still construct
  // it defensively; guard so a future browser tightening cannot break pages.
  if (typeof window.BroadcastChannel === "undefined") {
    window.BroadcastChannel = function () {
      return {
        postMessage: function () {},
        close: function () {},
        addEventListener: function () {},
        removeEventListener: function () {},
        onmessage: null,
      };
    };
  }

  /* ---------------------------------------------------------- public API */
  // Exposed for extensions and for debugging; read-only in spirit.
  window.__mirendaRuntime = {
    proxify: proxify,
    resolve: absolute,
    reportError: report,
    opaque: OPAQUE,
    currentTarget: function () {
      return currentTarget;
    },
  };
})();`;
}
