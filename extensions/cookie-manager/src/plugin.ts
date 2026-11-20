/**
 * Cookie-manager plugin definition.
 *
 * A floating button opens a bottom-sheet panel for the current domain's cookies
 * in the active profile. All reads and writes go through `mirenda.cookies`,
 * which the shell brokers over the RPC bridge — so the panel never touches the
 * session, the vault, or another profile's jar.
 */
import {
  definePlugin,
  installPageRuntime,
  resolveProfileId,
  type MirendaApi,
  type MirendaManifest,
} from '@mirenda/sdk';
import { openCookieManager } from './panel.js';

export const manifest: MirendaManifest = {
  id: 'cookie-manager',
  name: 'Cookie Manager',
  version: '1.0.0',
  description: 'Inspect, edit, export and import cookies for the current site in this profile.',
  author: 'Mirenda contributors',
  license: 'AGPL-3.0-only',
  runtime: 'page',
  entry: '/extensions/cookie-manager.js',
  matches: ['*'],
  permissions: ['page', 'cookies'],
};

const BUTTON_ID = 'mirenda-cookie-manager-fab';

/** Add the floating trigger. A second call is a no-op. */
function mountTrigger(api: MirendaApi): void {
  if (document.getElementById(BUTTON_ID)) return;

  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.textContent = '🍪';
  button.setAttribute('aria-label', 'Cookie manager');
  button.title = 'Cookie manager';
  button.style.cssText = [
    'position:fixed',
    'right:14px',
    'bottom:150px',
    'z-index:2147482500',
    'width:48px',
    'height:48px',
    'border-radius:50%',
    'border:0',
    'background:#171d27',
    'color:#fff',
    'font-size:20px',
    'line-height:1',
    'box-shadow:0 8px 24px rgba(0,0,0,.5)',
    'cursor:pointer',
  ].join(';');

  button.addEventListener('click', () => openCookieManager(api));
  document.body.append(button);
}

export function activate(): void {
  const api = installPageRuntime({
    pluginId: manifest.id,
    profileId: resolveProfileId(manifest.id),
    url: window.location.href,
  });
  mountTrigger(api);
}


export const plugin = definePlugin({
  manifest,
  onPageInject(api: MirendaApi) {
    mountTrigger(api);
  },
});

export default plugin;
