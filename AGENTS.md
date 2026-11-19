# AGENTS.md — Mirenda Engineering Rules

Mirenda is an open-source, mobile-first cloud browser that runs inside the browser:
a Cloudflare Worker proxy/renderer, a thumb-friendly web UI, a modular extension SDK,
and a future Go tunneling service. These rules are binding for every coding session.

---

## 1. Monorepo structure

Keep the layout exactly as below. Do not add sibling top-level apps or renames without
updating this file in the same change.

```
apps/worker        Cloudflare Worker (TypeScript + Wrangler + D1 + HTMLRewriter)
apps/web           Mobile-first browser UI (Vite + TypeScript)
packages/sdk       @mirenda/sdk — MirendaPlugin interfaces (MIT)
extensions/        Built-in extensions built on packages/sdk (starts with eruda-devtools)
services/proxy-go  Placeholder Go module for the future WireGuard/SOCKS5 tunnel service
```

- `apps/worker`: request handling only. Business logic that is unit-testable must live in
  `src/lib` or `src/proxy` as pure functions taking explicit inputs; route handlers stay thin.
- `apps/web`: no framework runtime beyond Vite + TypeScript. Keep DOM code in `src/ui`,
  pure/portable logic (crypto, URL handling, state) in `src/lib` so it can be tested in Node.
- `packages/sdk`: types and tiny runtime helpers only. It must never import from `apps/*`
  or `extensions/*`. It must stay dependency-free at runtime.
- `extensions/*`: one directory per extension, each importing types from `@mirenda/sdk`.
  Extensions must not import `apps/worker` internals.
- `services/proxy-go`: a separate Go module. No cross-imports with the TS workspaces.

## 2. License policy

| Path | License |
| --- | --- |
| Repository root, `apps/worker`, `apps/web`, `services/proxy-go`, `extensions/*` | **AGPL-3.0** |
| `packages/sdk` | **MIT** |

- `packages/sdk` is MIT on purpose: plugin developers must be able to build and ship
  extensions with no copyleft obligation. Keep `packages/sdk/LICENSE` = MIT and its
  `package.json` `"license": "MIT"`.
- Every other package.json must declare `"license": "AGPL-3.0-only"`.
- Do **not** introduce dependencies with licenses incompatible with AGPL-3.0
  (no proprietary, no SSPL, no Commons-Clause, no non-commercial licenses). Permitted:
  MIT, ISC, BSD-2/3, Apache-2.0, MPL-2.0, 0BSD, Unlicense.
- Vendored/minified third-party assets (e.g. `eruda`) must keep their license notice and
  be recorded in the extension's README with upstream name, version and license.

## 3. Security policy (non-negotiable)

### 3.1 No plaintext secrets in D1

- Never store target-website passwords, cookies, tokens, or session vaults in plaintext
  in D1.
- Vault payloads are encrypted **client-side** with the Web Crypto API before sync:
  `PBKDF2` (SHA-256, ≥ 310,000 iterations, per-user random salt) derives an AES-256 key,
  and `AES-GCM` (random 96-bit IV per record) encrypts the payload.
- The server only ever sees `{ encrypted_blob, iv }` — base64 opaque bytes. The master
  password and derived key never leave the device and are never logged or sent.
- The server must reject or ignore attempts to store a plaintext vault payload. Treat any
  `encrypted_blob`/`iv` pair that fails base64 validation as invalid input.

### 3.2 Cookie isolation (Virtual Cookie Jar)

- Never forward a proxied site's `Set-Cookie` header onto Mirenda's own host origin.
  Strip it from the upstream response before it reaches the browser.
- Persist proxied cookies in the Virtual Cookie Jar keyed by
  `(user_id, profile_id, target_domain)`. One profile must never see another profile's
  cookies, even for the same domain, and users must never see each other's jars.
- Only re-inject cookies on outgoing proxied requests whose target domain matches the jar
  key. Never inject a jar's cookies into a different domain.
- Cookies marked `HttpOnly` stay server-side only; never expose them to client JS or the
  extension API.

### 3.3 General

- Validate and normalize every user-controlled input (URLs, profile ids, tab ids, domains).
- Never log credentials, JWTs, cookie values, or decrypted vault payloads.
- Never widen CORS to `*` on authenticated endpoints.
- Treat all proxied content as hostile: it is untrusted HTML/JS rendered in a sandboxed frame.
- Do not weaken the sandbox attributes on the viewport iframe (`allow-scripts` only, never
  `allow-same-origin` together with `allow-scripts`).

## 4. Engineering conventions

- TypeScript `strict` everywhere. No `any` in public SDK types; `unknown` + narrowing instead.
- No dead placeholders or `TODO`-only functions in core TS files. If a module exists, it works.
- Pure logic gets a unit test. Cookie isolation, URL rewriting and the crypto helper are
  mandatory test targets on every change that touches them.
- Keep the local dev flow working out of the box: `npm install && npm run typecheck && npm test`
  must pass from a clean clone.
- Formatting: 2-space indent, single quotes, semicolons, trailing commas in multiline.

## 5. Extension SDK contract (frozen)

`@mirenda/sdk` is a public API. Treat a change to these names as a breaking change:
bump the major version and note it in `packages/sdk/README.md`.

A plugin is `MirendaPlugin` with an optional lifecycle hook and a manifest:

| Hook | When it runs |
| --- | --- |
| `onLoad` | Once when the plugin is registered for a profile. |
| `onPageInject` | When the plugin contributes markup to a proxied page. |
| `onRequest` | Before a proxied request is sent upstream (may rewrite it). |
| `onResponse` | After an upstream response returns (may rewrite it). |

The `mirenda` API handed to hooks is scoped to one `(user, profile)` pair by
construction, and exposes: `mirenda.tabs`, `mirenda.network`, `mirenda.cookies`,
`mirenda.page`, `mirenda.storage`. Never widen that scope.

Page-runtime plugins run inside an **opaque-origin** sandboxed iframe and talk to
the shell over `postMessage` (see `packages/sdk/src/page-runtime.ts`). Never
assume they share an origin with the shell.
