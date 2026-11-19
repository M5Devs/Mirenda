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

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Worker (`:8787`) + Vite (`:5173`) together. |
| `npm run dev:worker` | Worker only. |
| `npm run dev:web` | Vite only. |
| `npm run build` | Web UI, then the extension bundle. |
| `npm run build:extensions` | Rebuild only the Eruda bundle. |
| `npm run typecheck` | `tsc --noEmit` across every workspace. |
| `npm test` | Vitest: URL rewriter, cookie jar, crypto, URL parsing, SDK. |
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
| Password timing | Verification uses a constant-time comparison. |

The vault key is held in memory only. Reloading the page locks the vault; unlock
with your master password to derive the same key from the server-issued salt.

## Extensions

```bash
npm run build:extensions   # rebuild extensions/eruda-devtools
```

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
