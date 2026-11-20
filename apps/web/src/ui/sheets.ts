/** Tab switcher, profile switcher, and extension manager sheets. */
import { api, type ExtensionRecord, type Profile, type Tab } from '../lib/api.js';
import { displayUrl } from '../lib/url.js';
import type { Store } from '../lib/store.js';
import { el, icon } from './dom.js';
import { alertBox, openSheet, textField } from './sheet.js';

const PROFILE_COLORS = ['#4f8cff', '#35d399', '#ffb020', '#ff5c6c', '#a970ff', '#20c4d9'];

export interface SheetDeps {
  store: Store;
  openTab: (tab: Tab) => Promise<void>;
  closeTab: (tab: Tab) => Promise<void>;
  selectProfile: (profile: Profile) => Promise<void>;
  toggleExtension: (id: string, enabled: boolean) => void | Promise<void>;
}

/* -------------------------------------------------------------- tab sheet */

export function openTabSheet(deps: SheetDeps): void {
  const { store } = deps;
  const state = store.get();
  const sheet = openSheet({ title: `Tabs (${state.tabs.length})`, onClose: () => undefined });
  const tint = state.profiles.find((p) => p.id === state.activeProfileId)?.color ?? '#ff7a18';
  const profileName = state.profiles.find((p) => p.id === state.activeProfileId)?.name ?? 'Profile';

  // Cards rather than rows: a 2-up grid lets a thumb reach any tab without
  // scrolling and shows a page's title at a glance, the way mobile browsers do.
  const grid = el('div', { class: 'tabgrid' });

  for (const tab of state.tabs) {
    const active = tab.id === state.activeTabId;
    const card = el('button', {
      class: `tabcard${active ? ' tabcard--active' : ''}`,
      type: 'button',
      style: `--tab-tint:${tint}`,
      'aria-label': `Switch to ${tab.title || tab.url}`,
    });
    const tag = el('span', { class: 'tabcard__tag' }, el('i', {}), document.createTextNode(profileName));
    card.append(
      tag,
      el('span', { class: 'tabcard__title', text: tab.title || displayUrl(tab.url) || 'New tab' }),
      el('span', { class: 'tabcard__url', text: displayUrl(tab.url) || 'about:newtab' }),
    );

    card.addEventListener('click', () => {
      void (async () => {
        await deps.openTab(tab);
        sheet.close();
      })();
    });

    const closeButton = el('button', {
      class: 'tabcard__close',
      type: 'button',
      'aria-label': `Close ${tab.title || tab.url}`,
    });
    closeButton.append(icon('close'));
    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void (async () => {
        await deps.closeTab(tab);
        sheet.close();
      })();
    });
    card.append(closeButton);
    grid.append(card);
  }

  const newCard = el('button', { class: 'tabcard tabcard--new', type: 'button', 'aria-label': 'New tab' });
  newCard.append(icon('plus'), el('span', { class: 'tabcard__title', text: 'New tab' }));
  newCard.addEventListener('click', () => {
    sheet.close();
    store.set({ addressValue: '' });
    void deps.openTab({ id: '', profileId: state.activeProfileId ?? '', url: 'about:newtab', title: '', isActive: true, position: 0, updatedAt: '' });
  });
  grid.append(newCard);

  sheet.body.append(grid);
}

/* ---------------------------------------------------------- profile sheet */

export function openProfileSheet(deps: SheetDeps): void {
  const { store } = deps;
  const state = store.get();
  const sheet = openSheet({ title: 'Profiles', onClose: () => undefined });

  const hint = el('p', {
    class: 'hint',
    text: 'Each profile is an isolated container: separate tabs, cookie jar and vault scope.',
  });

  const list = el('ul', { class: 'list' });

  for (const profile of state.profiles) {
    const active = profile.id === state.activeProfileId;
    const swatch = el('span', { class: 'swatch', style: `background:${profile.color}` });
    const button = el(
      'button',
      { class: `list__item${active ? ' list__item--active' : ''}`, type: 'button' },
      swatch,
      el(
        'span',
        { class: 'list__main' },
        el('span', { class: 'list__title', text: profile.name }),
        el('span', { class: 'list__sub', text: profile.userAgent ?? 'Default user agent' }),
      ),
    );
    button.addEventListener('click', () => {
      void (async () => {
        await deps.selectProfile(profile);
        sheet.close();
      })();
    });
    list.append(el('li', {}, button));
  }

  const name = textField({ label: 'New profile name', placeholder: 'Work, Shopping, Personal…' });
  const color = el('input', {
    class: 'input',
    type: 'color',
    value: PROFILE_COLORS[state.profiles.length % PROFILE_COLORS.length] ?? '#4f8cff',
    'aria-label': 'Profile color',
  });
  const errorSlot = el('div', { class: 'stack' });
  const create = el('button', { class: 'button', type: 'button' });
  create.append(icon('plus'), document.createTextNode('Create profile'));

  create.addEventListener('click', () => {
    void (async () => {
      errorSlot.replaceChildren();
      const value = name.input.value.trim();
      if (value === '') {
        errorSlot.append(alertBox('Give the profile a name.'));
        return;
      }
      create.disabled = true;
      try {
        const profile = await api.createProfile({ name: value, color: color.value });
        const profiles = [...store.get().profiles, profile];
        store.set({ profiles });
        sheet.close();
        await deps.selectProfile(profile);
      } catch (error) {
        errorSlot.append(alertBox(error instanceof Error ? error.message : 'Could not create profile.'));
        create.disabled = false;
      }
    })();
  });

  sheet.body.append(
    hint,
    list,
    el('div', { class: 'stack' }, name.wrapper, el('label', { class: 'field' }, el('span', { class: 'field__label', text: 'Color' }), color), errorSlot, create),
  );
}

/* -------------------------------------------------------- extension sheet */

export function openExtensionSheet(deps: SheetDeps): void {
  const { store } = deps;
  const state = store.get();
  const sheet = openSheet({ title: 'Extensions', onClose: () => undefined });

  const hint = el('p', {
    class: 'hint',
    text: 'Enabled extensions inject into proxied pages for this profile. Toggling one reloads the current page.',
  });

  const list = el('ul', { class: 'list' });

  for (const extension of state.extensions) {
    const enabled = state.enabledExtensions.has(extension.id);
    const switchButton = el('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'aria-checked': enabled ? 'true' : 'false',
      'aria-label': `Toggle ${extension.name}`,
    });
    switchButton.addEventListener('click', () => {
      const next = switchButton.getAttribute('aria-checked') !== 'true';
      switchButton.setAttribute('aria-checked', next ? 'true' : 'false');
      deps.toggleExtension(extension.id, next);
    });

    list.append(
      el(
        'li',
        {},
        el(
          'div',
          { class: 'toggle-row' },
          el(
            'div',
            { class: 'toggle-row__text' },
            el('span', { class: 'row' }, el('span', { class: 'list__title', text: extension.name }), el('span', { class: 'badge', text: `v${extension.version}` })),
            el('span', { class: 'list__sub', text: extension.description }),
          ),
          switchButton,
        ),
      ),
    );
  }

  if (state.extensions.length === 0) list.append(el('li', { class: 'empty', text: 'No extensions installed.' }));

  sheet.body.append(hint, list);
}

/** The floating extension toggle on the viewport. */
export function openQuickExtensions(deps: SheetDeps): void {
  openExtensionSheet(deps);
}

export type { ExtensionRecord };
