/**
 * User-Agent switcher.
 *
 * Two scopes, because they solve different problems:
 *   - **This tab** — override for the active tab only, so a single desktop-only
 *     site can be viewed in desktop mode without changing the whole container.
 *   - **This profile** — the default every new tab in the container inherits.
 *
 * Both are persisted server-side (profile `user_agent`, tab `user_agent`), and
 * the proxy applies tab-then-profile precedence on the upstream fetch.
 */
import { api, type Profile, type Tab } from '../lib/api.js';
import {
  CUSTOM_USER_AGENT,
  DEFAULT_USER_AGENT,
  USER_AGENT_PRESETS,
  isValidUserAgent,
  selectedPresetId,
} from '../lib/user-agents.js';
import type { Store } from '../lib/store.js';
import { el } from './dom.js';
import { alertBox, openSheet, textField } from './sheet.js';

export interface UserAgentSheetDeps {
  store: Store;
  /** Re-render the viewport so the new User-Agent takes effect immediately. */
  refresh: () => void;
}

/** One selectable chip. */
function presetChip(
  label: string,
  hint: string,
  selected: boolean,
  onSelect: () => void,
): HTMLButtonElement {
  const button = el(
    'button',
    {
      class: `ua-chip${selected ? ' ua-chip--active' : ''}`,
      type: 'button',
      'aria-pressed': selected ? 'true' : 'false',
      title: hint,
    },
    el('span', { class: 'ua-chip__label', text: label }),
  );
  button.addEventListener('click', onSelect);
  return button;
}

/**
 * Render the switcher. A `target` of `'tab'` writes the tab override; `'profile'`
 * writes the container default. Passing `null` clears the override.
 */
export function openUserAgentSheet(deps: UserAgentSheetDeps, target: 'tab' | 'profile'): void {
  const state = deps.store.get();
  const profile = state.profiles.find((p) => p.id === state.activeProfileId) ?? null;
  const tab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;

  if (!profile) return;

  const currentValue = target === 'tab' ? tab?.userAgent ?? null : profile.userAgent;
  const sheet = openSheet({
    title: target === 'tab' ? 'User-Agent for this tab' : 'User-Agent for this profile',
    onClose: () => undefined,
  });

  const errorSlot = el('div', {});
  const chips = el('div', { class: 'ua-chips' });

  const custom = textField({
    label: 'Custom User-Agent',
    value: selectedPresetId(currentValue) === CUSTOM_USER_AGENT ? currentValue ?? '' : '',
    placeholder: 'Mozilla/5.0 (...) ...',
  });

  const apply = async (value: string | null): Promise<void> => {
    errorSlot.replaceChildren();
    try {
      if (target === 'tab') {
        if (!tab) {
          errorSlot.append(alertBox('Open a page first to override its User-Agent.'));
          return;
        }
        const updated = await api.updateTab(tab.id, profile.id, { userAgent: value });
        deps.store.set({ tabs: state.tabs.map((t) => (t.id === updated.id ? updated : t)) });
      } else {
        const updated: Profile = await api.updateProfile(profile.id, { userAgent: value });
        deps.store.set({ profiles: state.profiles.map((p) => (p.id === updated.id ? updated : p)) });
      }
      sheet.close();
      deps.refresh();
    } catch (error) {
      errorSlot.append(alertBox(error instanceof Error ? error.message : 'Could not save the User-Agent.'));
    }
  };

  // "Default" plus each preset. Selecting a chip applies immediately: this is a
  // one-handed mobile UI, so an extra confirm step would only add friction.
  const selectedId = selectedPresetId(currentValue);
  chips.append(
    presetChip('Default', 'Use the proxy default', selectedId === DEFAULT_USER_AGENT, () => {
      void apply(null);
    }),
    ...USER_AGENT_PRESETS.map((preset) =>
      presetChip(preset.label, preset.hint, selectedId === preset.id, () => {
        void apply(preset.value);
      }),
    ),
  );

  const customApply = el('button', { class: 'button button--primary', type: 'button', text: 'Use custom value' });
  customApply.addEventListener('click', () => {
    const value = custom.input.value.trim();
    if (!isValidUserAgent(value)) {
      errorSlot.replaceChildren(alertBox('That does not look like a User-Agent string.'));
      return;
    }
    void apply(value);
  });

  const hint = el('p', {
    class: 'hint',
    text:
      target === 'tab'
        ? 'Applies to this tab only. New tabs inherit the profile default.'
        : 'Every new tab in this profile starts with this User-Agent.',
  });

  sheet.body.append(
    hint,
    chips,
    el('div', { class: 'ua-divider' }),
    custom.wrapper,
    customApply,
    errorSlot,
  );
}

/** The tab the switcher would affect, for the toolbar's label. */
export function activeTabOf(state: { tabs: Tab[]; activeTabId: string | null }): Tab | null {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
}
