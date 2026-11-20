/**
 * Eruda DevTools plugin definition.
 *
 * Kept separate from `index.ts` so the built bundle has a single side-effectful
 * entry with no exports: an injected script has no consumer to import from.
 */
import eruda from 'eruda';
import {
  definePlugin,
  installPageRuntime,
  resolveProfileId,
  type MirendaApi,
  type MirendaManifest,
} from '@mirenda/sdk';

export const manifest: MirendaManifest = {
  id: 'eruda-devtools',
  name: 'Eruda DevTools',
  version: '1.0.0',
  description: 'Mobile console, elements, network and cookie inspection inside the proxied page.',
  author: 'Mirenda contributors',
  license: 'AGPL-3.0-only',
  runtime: 'page',
  entry: '/extensions/eruda-devtools.js',
  matches: ['*'],
  permissions: ['page'],
};

/** A second `eruda.init()` would attach a duplicate panel tree. */
let booted = false;

export function bootEruda(api: MirendaApi): void {
  if (booted) return;
  booted = true;

  eruda.init({
    defaults: {
      displaySize: 50,
      transparency: 0.92,
      theme: 'Dark',
    },
  });

  const consoleTool = eruda.get('console');
  if (consoleTool) {
    eruda.show('console');
    consoleTool.config.set('catchGlobalErr', true);
    consoleTool.config.set('overrideConsole', true);
  }

  api.page.notify('Eruda DevTools ready — tap the eruda button', 'info');

  // Keep the panel above the proxied page's own fixed chrome.
  api.page.injectStyle(`
    .eruda-container { z-index: 2147483600 !important; }
    .eruda-dev-tools { z-index: 2147483600 !important; }
  `);
}

export function activate(): void {
  const api = installPageRuntime({
    pluginId: manifest.id,
    profileId: resolveProfileId(manifest.id),
    url: window.location.href,
  });
  bootEruda(api);
}

export const plugin = definePlugin({
  manifest,
  onPageInject(api: MirendaApi) {
    bootEruda(api);
  },
});

export default plugin;
