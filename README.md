# Mirenda

A mobile-first **cloud browser inside a browser**. Mirenda fetches pages on
Cloudflare's edge, rewrites them so they render inside a sandboxed viewport, and
keeps every site's cookies in a per-profile jar on the server — never on
Mirenda's own origin.

- **Worker proxy** — `HTMLRewriter` strips framing restrictions, rewrites URLs,
  and isolates `Set-Cookie` into a virtual jar keyed by `(user, profile, domain)`.
- **Profiles** — Chrome-like containers. Cookies, tabs, bookmarks, history and
  vault entries are all scoped to a profile.
- **Zero-knowledge vault** — credentials are sealed with `PBKDF2` + `AES-GCM` in
  the browser. The server only ever stores ciphertext and the IV.
- **Extension SDK** — MIT-licensed `@mirenda/sdk` with lifecycle hooks and a
  `mirenda.{tabs,network,cookies,page,storage}` API. Ships with Eruda DevTools.

## Layout

```
apps/worker        Cloudflare Worker: D1, HTMLRewriter proxy, JSON API
apps/web           Mobile-first UI (Vite + TypeScript)
packages/sdk       @mirenda/sdk — plugin interfaces (MIT)
extensions/        Built-in extensions (eruda-devtools)
services/proxy-go  Placeholder Go module for the future tunnel service
```

## Requirements

- Node.js **20+**
- npm **10+**
- Go **1.22+** (only for `services/proxy-go`)

## Quick start

```bash
npm install

# 1. Create the local D1 database and apply migrations
npm run db:migrate

# 2. Build the web UI (also builds the extension bundle into dist/extensions)
npm run build

# 3. Run the worker on :8787 and the Vite dev server on :5173
npm run dev
```

Open <http://localhost:5173>, register an account, and pick a profile.

The Vite dev server proxies `/api`, `/proxy` and `/extensions` to `wrangler dev`
on `:8787`, so the UI and the worker share one origin in development exactly as
they do in production.

### Why build before `dev`?

The worker serves the built UI from its assets binding. `npm run build` writes
`apps/web/dist`, and the Eruda bundle lands in `apps/web/dist/extensions` so the
same worker that injects the script also serves it. `wrangler dev` serves a stale
or missing UI until you build once.

## Two-role local dev

Local dev runs the whole stack in one Worker (`WORKER_ROLE=all`), which is the
fastest loop. To exercise the **split** deployment — the one where a hostile
proxied page genuinely cannot reach the session — run two Workers on separate
origins:

```bash
npm run dev:app       # :8787 — /api/*, auth, vault, UI
npm run dev:sandbox   # :8788 — /proxy + extension bundles only
```

Three things bite here, and all three are silent in the browser:

**1. The sandbox must serve the extension bundles.** In the split deployment the
viewport iframe's origin *is* the sandbox, so the sandbox is the only Worker that
can serve the injected `<script src="/extensions/…">`. `wrangler dev` snapshots
its asset directory **at boot**, so a sandbox started before
`apps/worker/sandbox-assets/` exists answers `{"error":"not found"}` for every
bundle and extensions silently never boot. `npm run dev:sandbox` therefore runs
`build:sandbox-assets` first. If you start the sandbox by hand, rebuild the
assets *and restart* it:

```bash
npm run build:extensions && npm run build:sandbox-assets
# then restart `wrangler dev --env sandbox`
```

**2. The sandbox needs `PROXY_TOKEN_SECRET` at boot.** It is a **secret**, not a
`[vars]` entry, so `[env.sandbox.vars]` does not provide it and a bare
`wrangler dev --env sandbox` returns `503 {"error":"proxy tokens are not
configured"}` with an empty viewport. `npm run dev:sandbox` passes the dev value
for you. By hand:

```bash
npx wrangler dev --env sandbox --port 8788 --local \
  --var PROXY_TOKEN_SECRET:dev-only-proxy-token-secret-change-me-32chars
```

The app and sandbox roles must use the **same** value — the app signs a proxy
token, the sandbox verifies it.

**3. Each Worker must know its own public origin.** `APP_ORIGIN`,
`SANDBOX_ORIGIN` and `ALLOWED_ORIGINS` drive CORS and the proxy-token audience.
Over a tunnel, `localhost` is the wrong answer, so pass the tunnel URLs at boot
(see below).

### Testing on a phone with Quick Tunnels

`npm run dev:tunnel` builds, opens a Quick Tunnel per role, then starts both
Workers with the resulting `*.trycloudflare.com` origins wired in:

```bash
npm run dev:tunnel
#   app      https://<random>.trycloudflare.com
#   sandbox  https://<random>.trycloudflare.com
```

Open the **app** URL on the phone. Each tunnel URL is random per run, and the
Workers are started *after* the tunnels so the origins match. Logs land in
`/tmp/mirenda/`. Set `CLOUDFLARED=/path/to/cloudflared` if the binary is not on
`PATH`.

Because `trycloudflare.com` is on the Public Suffix List, the two URLs are
separate registrable domains — the same isolation you get in production.

### Troubleshooting extensions

If an extension is enabled and its `<script>` tag appears in the proxied HTML but
nothing happens in the page:

- `curl -sI https://<sandbox>/extensions/eruda-devtools.js` — must be `200` with
  `content-type: application/javascript`. A 21-byte JSON body means the sandbox
  started without its assets (cause 1 above).
- Errors inside the sandboxed iframe are masked to `"Script error."` by design,
  because its origin is opaque. Debug by fetching the bundle and evaluating it
  in a `try`/`catch` *inside the frame*, which surfaces the real message.
- `window.eruda` is **not** the library: eruda mounts `<div id="eruda">`, and
  HTML named-element lookup makes `window.eruda` resolve to that element. Assert
  on `document.getElementById('eruda').shadowRoot` instead.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Worker (`:8787`) + Vite (`:5173`) together. |
| `npm run dev:worker` | Worker only. |
| `npm run dev:web` | Vite only. |
| `npm run dev:app` | Split role: app Worker (`:8787`), `/api/*` + UI. |
| `npm run dev:sandbox` | Split role: rebuilds sandbox assets, then the sandbox Worker (`:8788`). |
| `npm run dev:tunnel` | Both split roles behind Quick Tunnels, with origins wired in. |
| `npm run build` | Web UI, then all extension bundles, then the sandbox asset copy. |
| `npm run build:web` | Build the mobile UI only. |
| `npm run build:extensions` | Rebuild the Eruda, cookie-manager and js/css-studio bundles. |
| `npm run build:sandbox-assets` | Copy **only** the bundles into `apps/worker/sandbox-assets`. |
| `npm run typecheck` | `tsc --noEmit` across every workspace. |
| `npm test` | Vitest: URL rewriter, cookie jar, crypto, rate limit, proxy token, bridge, SDK. |
| `npm run db:migrate` | Apply `migrations/*.sql` to the local D1. |
| `npm run deploy` | Deploy the worker to Cloudflare. |

## Configuration

`apps/worker/wrangler.toml` declares the D1 binding as `DB`. For production:

```bash
npx wrangler d1 create mirenda          # prints a database_id
npx wrangler d1 migrations apply mirenda --remote
```

Put the printed id into both `database_id` fields in `wrangler.toml`, then
`npm run deploy`.

### Two-role deployment (recommended)

The same Worker runs as two roles, selected by `WORKER_ROLE`:

```bash
npm run build
npx wrangler deploy --env app        # /api/* + UI
npx wrangler deploy --env sandbox    # /proxy + extension bundles only
npx wrangler secret put PROXY_TOKEN_SECRET --env app
npx wrangler secret put PROXY_TOKEN_SECRET --env sandbox   # same value
```

Set `APP_ORIGIN` / `SANDBOX_ORIGIN` / `ALLOWED_ORIGINS` in each env. The sandbox
gets a session-free `/proxy` through short-lived HMAC proxy tokens, publishes
only extension bundles (no UI, so it cannot host a phishing login), and answers
404 to every `/api/*` route. Local dev uses `WORKER_ROLE=all`, one Worker
serving both — the same code paths, one process.

## How the proxy works

`GET /proxy?url=<absolute-url>&profileId=<id>`:

1. Validates the target is absolute `http(s)` with no embedded credentials.
2. Confirms the caller owns `profileId`.
3. Loads the jar for `(user, profile, target domain)` and sends the matching
   cookies upstream. `HttpOnly` cookies live here, so page scripts never see them.
4. Fetches upstream with `redirect: 'manual'`.
5. Reads `Set-Cookie`, merges it into the jar, and **drops it from the response** —
   a proxied site can never set a cookie on Mirenda's origin.
6. Rewrites `href`/`src`/`action`/`srcset`/CSS `url()` through `/proxy`, and
   removes `X-Frame-Options` and framing-blocking `Content-Security-Policy`.
7. Injects enabled extension scripts before `</body>`.

Responses carry `x-mirenda-proxied: 1`.

## Security model

| Concern | Mitigation |
| --- | --- |
| Site cookies on Mirenda's origin | Intercepted into a per-profile jar; `Set-Cookie` never reaches the client. |
| `HttpOnly` cookies exposed to scripts | Jar is server-side; the plugin API filters them out. |
| Cross-profile leakage | Every jar/tab/vault query is scoped by `(user_id, profile_id)`. |
| Site passwords | Sealed client-side (`PBKDF2` 310k → `AES-GCM`); D1 stores ciphertext + IV only. |
| Session theft from a DB leak | Sessions store only the SHA-256 of the token. |
| Hostile proxied markup | Viewport iframe is sandboxed **without** `allow-same-origin`. |
| Forged sandbox messages | Accepted only from the exact viewport frame (`event.source`), not by origin. |
| Compromised page reaching auth/vault | RPC is an allowlist: no `auth.*`, `vault.*`, `profiles.*`, or `network.fetch`. |
| Credential abuse / proxy flooding | Per-user fixed-window limits; 429 + `Retry-After`. |
| Sandbox origin used for phishing | Sandbox ships no UI at all — only extension bundles. |
| Cross-origin session reuse | `/proxy` uses a scoped 5-minute HMAC token, not the session cookie. |
| Password timing | Verification uses a constant-time comparison. |

The vault key is held in memory only. Reloading the page locks the vault; unlock
with your master password to derive the same key from the server-issued salt.

## Extensions

```bash
npm run build:extensions   # rebuild all three bundles
```

Ships with three built-ins:

| Extension | What it adds |
| --- | --- |
| `eruda-devtools` | Mobile console, elements, network and cookie inspector. |
| `cookie-manager` | View, edit, delete and export/import the virtual jar per site. |
| `js-css-studio` | Per-domain JS/CSS snippets with auto-run, plus three utilities. |

Toggle extensions per profile in the drawer. Enablement is stored server-side,
so the proxy injects only what the active profile has switched on.

See [`packages/sdk/README.md`](packages/sdk/README.md) for the plugin API and
[`extensions/eruda-devtools/README.md`](extensions/eruda-devtools/README.md) for
the shipped example.

## Testing

```bash
npm test
```

Covers URL rewriting (including `srcset` and CSS `url()`), cookie parsing and
isolation, PBKDF2/AES-GCM seal and open (including tamper detection), address-bar
normalization, and the plugin registry.

## Roadmap

- `services/proxy-go` — WireGuard/SOCKS5 tunnel for egress regions.
- Worker-runtime extensions that rewrite requests and responses.
- Session restore across devices.

## License

Mirenda is **AGPL-3.0-only**. `packages/sdk` is deliberately **MIT** so
extension authors keep full freedom, including for commercial extensions.

`extensions/eruda-devtools` bundles [eruda](https://github.com/liriliri/eruda)
(MIT); the wrapper is AGPL-3.0-only.
