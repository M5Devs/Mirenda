/** The browser shell: viewport, floating chrome, and sheet wiring. */
import { api, proxyUrl, type Tab } from '../lib/api.js';
import { installSandboxBridge, type SandboxBridge } from '../lib/bridge.js';
import { createRpcHandlers } from '../lib/rpc-handlers.js';
import { openUserAgentSheet } from './user-agent-sheet.js';
import type { Store } from '../lib/store.js';
import { displayUrl, normalizeAddressInput, originOf } from '../lib/url.js';
import { el, icon } from './dom.js';
import { openAuthSheet } from './auth-sheet.js';
import { openVaultSheet } from './vault-sheet.js';
import { openExtensionSheet, openProfileSheet, openTabSheet, type SheetDeps } from './sheets.js';

/** Blank-tab sentinel; mirrors the worker's `NEW_TAB_URL`. */
export const NEW_TAB_URL = 'about:newtab';

export interface BootOptions {
  store: Store;
  /**
   * Vault key derived at sign-in, held in memory only. `null` after a reload:
   * the shell still browses, and the vault stays locked until unlocked.
   */
  vaultKey: CryptoKey | null;
}

export class BrowserApp {
  private readonly store: Store;
  private vaultKey: CryptoKey | null;
  private readonly history: string[] = [];
  private historyIndex = -1;

  private iframe: HTMLIFrameElement | null = null;
  private bridge!: SandboxBridge;
  /**
   * Cached sandbox origin from `/api/proxy-token`. `null` means same-origin:
   * the iframe then uses a relative `/proxy` URL and needs no token at all.
   */
  private sandboxOrigin: string | null = null;
  private addressInput!: HTMLInputElement;
  private backButton!: HTMLButtonElement;
  private forwardButton!: HTMLButtonElement;
  private statusDomain!: HTMLSpanElement;
  private statusProfile!: HTMLSpanElement;
  private tabCount!: HTMLSpanElement;
  private fab!: HTMLButtonElement;
  private vaultButton!: HTMLButtonElement;

  constructor(options: BootOptions) {
    this.store = options.store;
    this.vaultKey = options.vaultKey;
  }

  /** The unlocked vault key, or `null` while locked. */
  get key(): CryptoKey | null {
    return this.vaultKey;
  }

  /** Adopt a freshly derived key after an unlock. */
  unlock(key: CryptoKey): void {
    this.vaultKey = key;
  }

  mount(root: HTMLElement): void {
    root.replaceChildren();
    const viewport = el('div', { class: 'viewport' });
    const statusbar = el('div', { class: 'statusbar' });
    const chrome = el('div', { class: 'chrome' });
    const loadbarSlot = el('div', { class: 'loadbar-slot' });

    this.statusDomain = el('span', { class: 'statusbar__domain', text: 'No page' });
    this.statusProfile = el('span', { class: 'statusbar__profile' });
    statusbar.append(this.statusDomain, this.statusProfile);

    // ---- address bar ------------------------------------------------------
    this.backButton = this.iconButton('back', 'Back', () => this.goBack());
    this.forwardButton = this.iconButton('forward', 'Forward', () => this.goForward());

    this.addressInput = el('input', {
      class: 'addressbar__input',
      type: 'text',
      inputmode: 'url',
      enterkeyhint: 'go',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      placeholder: 'Search or enter address',
      'aria-label': 'Address bar',
    });

    const reloadButton = this.iconButton('reload', 'Reload', () => this.reload());
    const goButton = this.iconButton('go', 'Go', () => this.navigateFromInput(), 'iconbtn--primary');
    goButton.type = 'submit';

    this.addressInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.navigateFromInput();
      }
    });
    this.addressInput.addEventListener('focus', () => this.addressInput.select());

    const form = el('form', { class: 'addressbar' }, this.backButton, this.forwardButton, this.addressInput, reloadButton, goButton);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.navigateFromInput();
    });

    // ---- toolbar ----------------------------------------------------------
    this.tabCount = el('span', { class: 'tabcount', text: '1' });
    const tabsButton = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Tabs' }, this.tabCount);
    tabsButton.addEventListener('click', () => this.openTabs());

    const profilesButton = this.iconButton('profiles', 'Profiles', () => this.openProfiles());
    const extensionsButton = this.iconButton('extensions', 'Extensions', () => this.openExtensions());
    this.vaultButton = this.iconButton('lock', 'Vault', () => this.openVault());

    const uaButton = this.iconButton('ua', 'User-Agent', () => this.openUserAgent('tab'));
    // Long-press is not reliable on mobile, so the sheet itself offers the
    // profile-wide scope alongside the per-tab one.
    const left = el('div', { class: 'toolbar__group' }, tabsButton, profilesButton, uaButton);
    const right = el('div', { class: 'toolbar__group' }, this.vaultButton, extensionsButton);
    const toolbar = el('div', { class: 'toolbar' }, left, right);

    chrome.append(form, toolbar);

    this.fab = el('button', { class: 'fab', type: 'button', 'aria-label': 'Toggle extensions on this page' });
    this.fab.append(icon('extensions'));
    this.fab.addEventListener('click', () => this.openExtensions());

    root.append(viewport, loadbarSlot, statusbar, chrome, this.fab);
    this.viewportEl = viewport;

    // Install the RPC bridge once. It answers nothing until `setViewport` is
    // called with the iframe this shell created, so any other frame is ignored.
    this.bridge = installSandboxBridge({
      handlers: createRpcHandlers({
        getProfileId: () => this.store.get().activeProfileId ?? '',
      }),
      onReject: (reason) => console.warn('sandbox bridge rejected message:', reason),
    });

    this.store.subscribe((state) => this.render(state));
    void this.bootstrap();
  }

  private viewportEl!: HTMLDivElement;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Show a transient message in the status bar. Used for failures that would
   * otherwise be silent, so the UI never claims a state the worker rejected.
   */
  private showStatus(message: string, isError = false): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusDomain.textContent = message;
    this.statusDomain.classList.toggle('statusbar__domain--error', isError);
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.statusDomain.classList.remove('statusbar__domain--error');
      this.statusDomain.textContent = this.store.get().addressValue
        ? originOf(this.store.get().addressValue)
        : 'No page';
    }, 4000);
  }

  /* ------------------------------------------------------------ rendering */

  private render(state: ReturnType<Store['get']>): void {
    this.tabCount.textContent = String(state.tabs.length);
    this.statusDomain.textContent = state.addressValue ? originOf(state.addressValue) : 'No page';

    const profile = state.profiles.find((p) => p.id === state.activeProfileId) ?? null;
    this.statusProfile.replaceChildren(
      el('span', { class: 'dot', style: `background:${profile?.color ?? '#4f8cff'}` }),
      document.createTextNode(profile?.name ?? 'No profile'),
    );

    this.vaultButton.className = `iconbtn${this.vaultKey ? ' iconbtn--active' : ''}`;
    this.vaultButton.setAttribute('aria-label', this.vaultKey ? 'Vault (unlocked)' : 'Vault (locked)');
    this.vaultButton.replaceChildren(icon(this.vaultKey ? 'unlock' : 'lock'));

    const enabledCount = state.enabledExtensions.size;
    this.fab.className = `fab${enabledCount > 0 ? ' fab--on' : ''}`;
    this.fab.setAttribute(
      'aria-label',
      enabledCount > 0 ? `${enabledCount} extension(s) active on this page` : 'Extensions',
    );

    if (document.activeElement !== this.addressInput) {
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      this.addressInput.value = tab && tab.url !== NEW_TAB_URL ? displayUrl(tab.url) : '';
    }

    this.backButton.disabled = this.historyIndex <= 0;
    this.forwardButton.disabled = this.historyIndex >= this.history.length - 1;
  }

  /**
   * Render a page into the sandboxed viewport.
   *
   * Async because a split deployment must mint a scoped proxy token first: the
   * sandbox origin never receives the app's session cookie, so the token is the
   * only thing that authorises the iframe's request and every subresource the
   * rewritten HTML points at.
   */
  private async renderViewport(url: string | null): Promise<void> {
    this.viewportEl.replaceChildren();

    if (!url || url === NEW_TAB_URL) {
      this.iframe = null;
      this.bridge?.setViewport(null);
      this.viewportEl.append(
        el(
          'div',
          { class: 'viewport__empty' },
          el('h1', { text: 'Mirenda' }),
          el('p', { text: 'Type an address below. Pages render inside an isolated, sandboxed viewport.' }),
        ),
      );
      return;
    }

    const state = this.store.get();
    const profileId = state.activeProfileId ?? '';
    const tabId = state.activeTabId;

    // Same-origin dev has no sandbox origin, so no token is needed. Only mint
    // one when the proxy actually lives on another origin.
    let token: string | null = null;
    try {
      const minted = await api.proxyToken(profileId);
      this.sandboxOrigin = minted.sandboxOrigin;
      token = minted.sandboxOrigin ? minted.token : null;
    } catch {
      // Without a token a split deployment cannot load the page; a same-origin
      // deployment does not need one. Falling through keeps local dev working.
      this.sandboxOrigin = null;
    }

    const frame = el('iframe', {
      src: proxyUrl(url, profileId, { token, sandboxOrigin: this.sandboxOrigin, tabId }),
      // No `allow-same-origin`: the proxied document must never share an origin
      // with Mirenda's own UI, even when it is same-origin at the HTTP level.
      // This is what makes `event.origin` opaque inside the frame.
      sandbox: 'allow-scripts allow-forms allow-popups allow-modals allow-downloads',
      referrerpolicy: 'no-referrer',
      allow: 'fullscreen',
      title: 'Proxied page',
    });
    this.iframe = frame;
    this.viewportEl.append(frame);
    // Tell the bridge which frame is trustworthy. Until this call the bridge
    // answers nothing, so a frame created elsewhere can never reach the API.
    this.bridge?.setViewport(frame);
  }

  /* -------------------------------------------------------------- actions */

  private async bootstrap(): Promise<void> {
    const state = this.store.get();
    if (!state.user) return;
    if (state.profiles.length === 0) {
      const profile = await api.createProfile({ name: 'Personal', color: '#4f8cff' });
      this.store.set({ profiles: [profile], activeProfileId: profile.id });
      await this.ensureTab(profile.id);
      return;
    }
    const activeProfileId = state.activeProfileId ?? state.profiles[0]?.id ?? null;
    this.store.set({ activeProfileId });
    if (activeProfileId) await this.loadTabs(activeProfileId);
  }

  private async ensureTab(profileId: string): Promise<void> {
    const tabs = await api.listTabs(profileId);
    if (tabs.length === 0) {
      const tab = await api.createTab({ profileId, url: NEW_TAB_URL, title: 'New tab' });
      this.store.set({ tabs: [tab], activeTabId: tab.id });
      void this.renderViewport(null);
      return;
    }
    this.store.set({ tabs, activeTabId: tabs[0]?.id ?? null });
    const active = tabs.find((t) => t.isActive) ?? tabs[0];
    if (active) void this.renderViewport(active.url);
  }

  private async loadTabs(profileId: string): Promise<void> {
    const tabs = await api.listTabs(profileId);
    const active = tabs.find((t) => t.isActive) ?? tabs[0] ?? null;
    this.store.set({ tabs, activeTabId: active?.id ?? null });
    void this.renderViewport(active?.url ?? null);
  }

  private navigateFromInput(): void {
    const raw = this.addressInput.value;
    const target = normalizeAddressInput(raw);
    if (!target) {
      this.addressInput.value = '';
      return;
    }
    void this.navigate(target);
  }

  async navigate(target: string): Promise<void> {
    const state = this.store.get();
    const profileId = state.activeProfileId;
    if (!profileId) return;

    this.addressInput.blur();
    void this.renderViewport(target);
    this.store.set({ addressValue: target, loading: true });

    // Truncate any forward history before pushing the new entry.
    this.history.splice(this.historyIndex + 1);
    this.history.push(target);
    this.historyIndex = this.history.length - 1;

    try {
      let tabId = state.activeTabId;
      if (!tabId) {
        const tab = await api.createTab({ profileId, url: target, title: originOf(target) });
        tabId = tab.id;
        this.store.set({ tabs: [tab], activeTabId: tab.id });
      } else {
        const tab = await api.updateTab(tabId, profileId, { url: target, title: originOf(target) });
        const tabs = this.store.get().tabs.map((t) => (t.id === tab.id ? tab : t));
        this.store.set({ tabs });
      }
      // History is best-effort: a failed sync must not block navigation.
      void api.addHistory({ profileId, url: target, title: originOf(target) }).catch(() => undefined);
    } catch {
      /* navigation already happened client-side */
    } finally {
      this.store.set({ loading: false, addressValue: target });
    }
  }

  private goBack(): void {
    if (this.historyIndex <= 0) return;
    this.historyIndex -= 1;
    const target = this.history[this.historyIndex];
    if (target) void this.renderViewport(target);
    this.store.set({ addressValue: target ?? '' });
  }

  private goForward(): void {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex += 1;
    const target = this.history[this.historyIndex];
    if (target) void this.renderViewport(target);
    this.store.set({ addressValue: target ?? '' });
  }

  private reload(): void {
    const state = this.store.get();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab || tab.url === NEW_TAB_URL) return;
    void this.renderViewport(tab.url);
  }

  private openTabs(): void {
    openTabSheet(this.sheetDeps());
  }

  private openProfiles(): void {
    openProfileSheet(this.sheetDeps());
  }

  private openUserAgent(target: 'tab' | 'profile'): void {
    openUserAgentSheet({ store: this.store, refresh: () => this.refreshViewport() }, target);
  }

  /** Re-render the current page, e.g. after a User-Agent change. */
  private refreshViewport(): void {
    const state = this.store.get();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (tab && tab.url !== NEW_TAB_URL) void this.renderViewport(tab.url);
  }

  private openExtensions(): void {
    openExtensionSheet(this.sheetDeps());
  }

  private openVault(): void {
    openVaultSheet({
      store: this.store,
      key: () => this.vaultKey,
      requestUnlock: () => this.requestUnlock(),
    });
  }

  private sheetDeps(): SheetDeps {
    return {
      store: this.store,
      openTab: async (tab) => {
        if (tab.id === '') {
          const profileId = this.store.get().activeProfileId;
          if (!profileId) return;
          const created = await api.createTab({ profileId, url: NEW_TAB_URL, title: 'New tab' });
          this.store.set({ tabs: [...this.store.get().tabs, created], activeTabId: created.id });
          void this.renderViewport(null);
          return;
        }
        const profileId = this.store.get().activeProfileId;
        if (profileId) {
          const tabs = await api.activateTab(tab.id, profileId);
          this.store.set({ tabs, activeTabId: tab.id });
        }
        void this.renderViewport(tab.url);
        this.resetHistory(tab.url);
      },
      closeTab: async (tab) => {
        const profileId = this.store.get().activeProfileId;
        if (!profileId) return;
        await api.deleteTab(tab.id, profileId);
        const tabs = this.store.get().tabs.filter((t) => t.id !== tab.id);
        if (tabs.length === 0) {
          const created = await api.createTab({ profileId, url: NEW_TAB_URL, title: 'New tab' });
          this.store.set({ tabs: [created], activeTabId: created.id });
          void this.renderViewport(null);
          return;
        }
        const state = this.store.get();
        const stillActive = state.activeTabId !== tab.id;
        const nextActive = stillActive ? tabs.find((t) => t.id === state.activeTabId) ?? tabs[0] ?? null : tabs[0] ?? null;
        this.store.set({ tabs, activeTabId: nextActive?.id ?? null });
        if (nextActive) void this.renderViewport(nextActive.url);
      },
      selectProfile: async (profile) => {
        this.store.set({ activeProfileId: profile.id, tabs: [], activeTabId: null });
        this.resetHistory(null);
        // Extensions are per profile, so the drawer must be re-read.
        const extensions = await api.listExtensions(profile.id).catch(() => []);
        this.store.set({
          extensions,
          enabledExtensions: new Set(extensions.filter((e) => e.enabled).map((e) => e.id)),
        });
        await this.loadTabs(profile.id);
      },
      toggleExtension: async (id, enabled) => {
        const enabledSet = new Set(this.store.get().enabledExtensions);
        if (enabled) enabledSet.add(id);
        else enabledSet.delete(id);
        this.store.set({ enabledExtensions: enabledSet });

        const profileId = this.store.get().activeProfileId;
        if (profileId) {
          try {
            await api.toggleExtension(profileId, id, enabled);
          } catch {
            // Roll the switch back so the UI never claims a state the proxy
            // will not honour on the next load.
            const reverted = new Set(this.store.get().enabledExtensions);
            if (enabled) reverted.delete(id);
            else reverted.add(id);
            this.store.set({ enabledExtensions: reverted });
            this.showStatus('Could not save the extension choice.', true);
            return;
          }
        }
        // Reload so the injected script set matches the new selection.
        this.reload();
      },
    };
  }

  private resetHistory(url: string | null): void {
    this.history.length = 0;
    this.historyIndex = -1;
    if (url && url !== NEW_TAB_URL) {
      this.history.push(url);
      this.historyIndex = 0;
    }
  }

  /** Prompt for the master password to unlock the vault on this session. */
  requestUnlock(): void {
    openAuthSheet({
      store: this.store,
      mode: 'unlock',
      onAuthenticated: (result) => {
        this.unlock(result.vaultKey);
        this.render(this.store.get());
      },
    });
  }

  private iconButton(name: Parameters<typeof icon>[0], label: string, onClick: () => void, extra = ''): HTMLButtonElement {
    const button = el('button', {
      class: `iconbtn ${extra}`.trim(),
      type: 'button',
      'aria-label': label,
      title: label,
    });
    button.append(icon(name));
    button.addEventListener('click', onClick);
    return button;
  }
}

/** Boot the shell for an authenticated session. */
export async function bootAuthenticated(
  root: HTMLElement,
  store: Store,
  vaultKey: CryptoKey | null,
): Promise<void> {
  const app = new BrowserApp({ store, vaultKey });
  app.mount(root);

  const profiles = await api.listProfiles();
  const activeProfileId = store.get().activeProfileId ?? profiles[0]?.id ?? null;
  const extensions = activeProfileId ? await api.listExtensions(activeProfileId) : [];
  store.set({
    profiles,
    extensions,
    enabledExtensions: new Set(extensions.filter((extension) => extension.enabled).map((e) => e.id)),
    activeProfileId,
  });
}

/** Show the auth sheet when there is no session. */
export function bootUnauthenticated(root: HTMLElement, store: Store): void {
  root.replaceChildren(
    el(
      'div',
      { class: 'viewport__empty' },
      el('h1', { text: 'Mirenda' }),
      el('p', { text: 'A mobile-first cloud browser. Sign in to open your profiles and tabs.' }),
    ),
  );
  const button = el('button', { class: 'button button--primary', type: 'button', text: 'Sign in or create account' });
  button.addEventListener('click', () => {
    openAuthSheet({
      store,
      onAuthenticated: (result) => {
        void (async () => {
          const me = await api.me();
          store.set({ user: me });
          await bootAuthenticated(root, store, result.vaultKey);
        })();
      },
    });
  });
  root.append(el('div', { class: 'chrome' }, button));
}

