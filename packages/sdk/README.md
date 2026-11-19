# `@mirenda/sdk`

Typed interfaces and a tiny runtime for building Mirenda extensions.

**License: MIT.** Core Mirenda is AGPL-3.0, but the SDK is deliberately MIT so
you can build, publish and even sell extensions with no copyleft obligation.

## Install

```bash
npm install @mirenda/sdk
```

## A minimal page extension

```ts
import { definePlugin } from '@mirenda/sdk';

export default definePlugin({
  manifest: {
    id: 'hello-world',
    name: 'Hello World',
    version: '1.0.0',
    runtime: 'page',
    entry: '/extensions/hello-world.js',
    matches: ['*'],
    permissions: ['page'],
  },
  onPageInject(api) {
    api.page.notify(`Hello from ${api.plugin.id}`);
  },
});
```

## A worker-runtime extension

`runtime: 'worker'` plugins run inside the Cloudflare Worker and may rewrite
requests and responses:

```ts
import { definePlugin } from '@mirenda/sdk';

export default definePlugin({
  manifest: {
    id: 'strip-tracking',
    name: 'Strip Tracking Parameters',
    version: '1.0.0',
    runtime: 'worker',
    permissions: ['network'],
  },
  onRequest(request) {
    const url = new URL(request.url);
    url.searchParams.delete('utm_source');
    url.searchParams.delete('fbclid');
    return { ...request, url: url.toString() };
  },
});
```

## The `mirenda` API

| Namespace | What it does |
| --- | --- |
| `mirenda.tabs` | List, create, update, activate and close tabs in the active profile. |
| `mirenda.network` | Fetch through the worker (no CORS), with jar cookies applied. |
| `mirenda.cookies` | Read and write the Virtual Cookie Jar. `HttpOnly` cookies are invisible here. |
| `mirenda.page` | Query the proxied document, inject styles, show toasts. |
| `mirenda.storage` | Per-plugin, per-profile JSON key/value storage. |

## Lifecycle hooks

| Hook | Runtime | When |
| --- | --- | --- |
| `onLoad` | both | Plugin enabled. |
| `onPageInject` | page | Proxied document is ready. |
| `onRequest` | worker | Before the upstream fetch; may return a modified request. |
| `onResponse` | worker | After the upstream response; may return a modified response. |
| `onUnload` | both | Plugin disabled or reloaded. |

## Page-runtime bridge

A proxied page runs in a sandboxed iframe with **no** `allow-same-origin`, so it
cannot reach Mirenda's session. `installPageRuntime()` gives you a `mirenda`
object whose calls are relayed to the shell over `postMessage`:

```ts
import { installPageRuntime } from '@mirenda/sdk';

const api = installPageRuntime({
  pluginId: 'hello-world',
  profileId: 'profile-uuid',
  url: location.href,
});
```

The shell enforces scope on every relayed call, so a plugin can never read
another profile's cookies or another user's tabs.
