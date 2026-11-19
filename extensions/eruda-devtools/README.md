# Eruda DevTools

Mobile-friendly developer tools injected into every proxied page: Console,
Elements, Network, Resources and Cookie inspection.

- **Wrapper license:** AGPL-3.0-only (part of Mirenda)
- **Upstream:** [`eruda`](https://github.com/liriliri/eruda) v3.4.x — **MIT**

## What it does

Eruda runs *inside the proxied document*, in the sandboxed viewport iframe. It
inspects that page — its DOM, its console, its requests — and never Mirenda's
own shell, because the iframe has no `allow-same-origin`.

## Build

The bundle is emitted straight into the worker's static assets so the same
Worker that injects the script also serves it:

```bash
npm run build -w @mirenda/eruda-devtools
# → apps/web/dist/extensions/eruda-devtools.js
```

## Use

Open the extension drawer in Mirenda and switch **Eruda DevTools** on. The
proxied page reloads with the script injected before `</body>`, and an eruda
button appears in the page's bottom corner.

Toggling it off removes the script on the next reload.

## Notes

- The bundle is an IIFE so it needs no module loader inside the sandbox.
- `eruda.init()` is guarded by a module-level flag: a second init would attach a
  duplicate panel tree.
- The extension declares only the `page` permission. It cannot read the cookie
  jar, other profiles, or the vault.
