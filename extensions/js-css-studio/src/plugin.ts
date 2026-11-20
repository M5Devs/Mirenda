/**
 * js-css-studio plugin definition.
 *
 * On load it applies any snippet marked "run on page load" for the current URL,
 * then mounts a floating trigger that opens the editor. Everything runs inside
 * the sandboxed page; persistence goes through `mirenda.storage`, which the
 * shell brokers to D1 scoped by (profile, plugin).
 */
import {
  definePlugin,
  installPageRuntime,
  resolveProfileId,
  type MirendaApi,
  type MirendaManifest,
} from '@mirenda/sdk';
import { openStudio } from './panel.js';
import { applyRules } from './executor.js';
import { STORAGE_KEY_RULES, autoRunRules, parseRules } from './rules.js';

export const manifest: MirendaManifest = {
  id: 'js-css-studio',
  name: 'JS & CSS Studio',
  version: '1.0.0',
  description: 'Write, save and auto-run custom JavaScript and CSS on proxied pages.',
  author: 'Mirenda contributors',
  license: 'AGPL-3.0-only',
  runtime: 'page',
  entry: '/extensions/js-css-studio.js',
  matches: ['*'],
  permissions: ['page', 'storage'],
};

const BUTTON_ID = 'mirenda-studio-fab';

function mountTrigger(api: MirendaApi): void {
  if (document.getElementById(BUTTON_ID)) return;

  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.textContent = '⌨';
  button.setAttribute('aria-label', 'JS & CSS Studio');
  button.title = 'JS & CSS Studio';
  button.style.cssText = [
    'position:fixed',
    'right:14px',
    'bottom:206px',
    'z-index:2147482500',
    'width:48px',
    'height:48px',
    'border-radius:50%',
    'border:0',
    'background:#1b2330',
    'color:#e8ecf3',
    'font-size:19px',
    'line-height:1',
    'box-shadow:0 8px 24px rgba(0,0,0,.5)',
    'cursor:pointer',
  ].join(';');

  button.addEventListener('click', () => openStudio(api, window.location.href));
  document.body.append(button);
}

/** Apply every auto-run snippet that matches this page. */
async function runAutoSnippets(api: MirendaApi): Promise<void> {
  try {
    const rules = parseRules(await api.storage.get(STORAGE_KEY_RULES));
    const due = autoRunRules(rules, window.location.href);
    if (due.length === 0) return;
    const results = applyRules(due);
    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0) {
      console.warn('[mirenda] some auto-run snippets failed', failed);
    }
  } catch (error) {
    // Never let a storage failure break the page the user is viewing.
    console.warn('[mirenda] could not load auto-run snippets', error);
  }
}

export function activate(): void {
  const api = installPageRuntime({
    pluginId: manifest.id,
    profileId: resolveProfileId(manifest.id),
    url: window.location.href,
  });
  mountTrigger(api);
  void runAutoSnippets(api);
}


export const plugin = definePlugin({
  manifest,
  onPageInject(api: MirendaApi) {
    mountTrigger(api);
    void runAutoSnippets(api);
  },
});

export default plugin;
