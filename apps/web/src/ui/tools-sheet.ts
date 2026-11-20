/**
 * The `⚡ Tools` sheet.
 *
 * This is the one place a user can reach everything that is not "type a URL
 * and go": per-page extensions, the User-Agent override, reloads, profiles, and
 * the encrypted vault. It exists as a bottom sheet with large tiles because it
 * is the primary surface on a phone — the equivalent of a desktop browser's
 * menu, but thumb-reachable and one row deep.
 */
import type { ExtensionRecord } from '../lib/api.js';
import { el, icon } from './dom.js';
import { openSheet } from './sheet.js';

export interface ToolsSheetDeps {
  extensions: ExtensionRecord[];
  /** Extension ids currently switched on for this profile. */
  enabled: Set<string>;
  vaultUnlocked: boolean;
  onToggleExtension: (id: string, enabled: boolean) => void | Promise<void>;
  onOpenUserAgent: () => void;
  onReload: () => void;
  onHardReload: () => void;
  onOpenProfiles: () => void;
  onOpenVault: () => void;
  onOpenExtensions: () => void;
}

interface TileSpec {
  icon: Parameters<typeof icon>[0];
  label: string;
  on: boolean;
  badge?: number;
  onClick: () => void;
}

export function openToolsSheet(deps: ToolsSheetDeps): void {
  const sheet = openSheet({ title: 'Tools', onClose: () => {} });
  const body = sheet.body;
  const close = sheet.close;

  const tiles = el('div', { class: 'tiles' });

  const specs: TileSpec[] = [
    {
      icon: 'extensions',
      label: 'Extensions',
      on: deps.enabled.size > 0,
      badge: deps.extensions.length || undefined,
      onClick: deps.onOpenExtensions,
    },
    {
      icon: 'ua',
      label: 'User-Agent',
      on: false,
      onClick: deps.onOpenUserAgent,
    },
    {
      icon: 'reload',
      label: 'Reload',
      on: false,
      onClick: deps.onReload,
    },
    {
      icon: 'profiles',
      label: 'Profiles',
      on: false,
      onClick: deps.onOpenProfiles,
    },
    {
      icon: 'lock',
      label: deps.vaultUnlocked ? 'Vault open' : 'Vault',
      on: deps.vaultUnlocked,
      onClick: deps.onOpenVault,
    },
    {
      icon: 'bolt',
      label: 'Hard reload',
      on: false,
      onClick: deps.onHardReload,
    },
  ];

  for (const spec of specs) {
    const tile = el('button', { class: 'tile' + (spec.on ? ' tile--on' : ''), type: 'button' });
    const iconWrap = el('span', { class: 'tile__icon' });
    iconWrap.append(icon(spec.icon));
    tile.append(iconWrap, el('span', { class: 'tile__label', text: spec.label }));
    if (spec.badge) tile.append(el('span', { class: 'tile__badge', text: String(spec.badge) }));
    tile.addEventListener('click', () => {
      close();
      spec.onClick();
    });
    tiles.append(tile);
  }

  body.append(tiles);

  // Per-page extension toggles, so a page can be instrumented without opening
  // the full manager.
  if (deps.extensions.length > 0) {
    body.append(el('p', { class: 'field__label', text: 'On this site' }));
    const list = el('div', { class: 'stack' });
    for (const ext of deps.extensions) {
      const on = deps.enabled.has(ext.id);
      const row = el('div', { class: 'toggle-row' });
      const text = el('div', { class: 'toggle-row__text' });
      text.append(
        el('span', { class: 'list__title', text: ext.name }),
        el('span', { class: 'list__sub', text: ext.description || ext.version }),
      );
      const toggle = el('button', {
        class: 'switch',
        type: 'button',
        role: 'switch',
        'aria-checked': String(on),
        'aria-label': `Toggle ${ext.name}`,
      });
      toggle.addEventListener('click', () => {
        const next = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', String(next));
        row.classList.toggle('list__item--active', false);
        void deps.onToggleExtension(ext.id, next);
      });
      row.append(text, toggle);
      list.append(row);
    }
    body.append(list);
  } else {
    body.append(el('p', { class: 'empty', text: 'No extensions installed.' }));
  }

  body.append(
    el('p', {
      class: 'hint',
      text: 'Extensions run inside the sandboxed viewport and can only reach the current page.',
    }),
  );
}
