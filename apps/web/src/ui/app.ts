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
import { openToolsSheet } from './tools-sheet.js';

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
    const loadbarSlot = el('div', { class: 'loadbar-slot' });
    this.viewportEl = viewport;

    /* ---------------------------------------------------------- the pill */
    this.backButton = this.pillButton('back', 'Back', () => this.goBack());
    this.forwardButton = this.pillButton('forward', 'Forward', () => this.goForward());

    // The URL field doubles as the address bar: tapping it swaps in a real
    // input in place, so the pill never jumps and no separate bar is needed.
    this.urlDisplay = el('button', { class: 'pill__url pill__url--empty', type: 'button', 'aria-label': 'Address' });
    this.urlLock = icon('lock');
    this.urlText = el('span', { class: 'pill__url__text', text: 'Search or enter address' });
    this.urlDisplay.append(this.urlLock, this.urlText);
    this.urlDisplay.addEventListener('click', () => this.beginEditing());

    this.addressInput = el('input', {
      class: 'pill__input',
      type: 'text',
      inputmode: 'url',
      enterkeyhint: 'go',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      placeholder: 'Search or enter address',
      'aria-label': 'Address bar',
    });
    this.addressInput.hidden = true;
    this.addressInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.navigateFromInput();
      } else if (event.key === 'Escape') {
        this.endEditing();
      }
    });
    this.addressInput.addEventListener('blur', () => this.endEditing());
    this.addressInput.addEventListener('focus', () => this.addressInput.select());

    this.tabCount = el('span', { class: 'pill__count', text: '1' });
    this.tabsButton = el('button', { class: 'pill__btn', type: 'button', 'aria-label': 'Tabs' }, this.tabCount);
    this.tabsButton.addEventListener('click', () => this.openTabs());

    const toolsButton = this.pillButton('bolt', 'Tools', () => this.openTools());
    toolsButton.classList.add('pill__btn--accent');

    this.zenButton = this.pillButton('zen', 'Zen mode', () => this.toggleZen());
    // Zen lives at the far right, out of the way of the thumb's main path.
    this.zenButton.classList.add('pill__btn--zen');

    this.pill = el(
      'div',
      { class: 'pill', role: 'toolbar', 'aria-label': 'Browser controls' },
      this.backButton,
      this.urlDisplay,
      this.addressInput,
      this.tabsButton,
      toolsButton,
      this.zenButton,
    );

    /* --------------------------------------------------- zen-mode bubble */
    this.zenBubble = el('button', { class: 'zenbubble', type: 'button', 'aria-label': 'Exit zen mode' });
    this.zenBubble.append(icon('zen'));
    this.zenBubble.hidden = true;
    this.makeDraggable(this.zenBubble);

    /* ------------------------------------------------------ diagnostics */
    this.diag = el('div', { class: 'diag', role: 'status' });
    this.diag.hidden = true;
    this.diag.addEventListener('click', () => {
      this.diag.hidden = true;
    });

    root.append(viewport, loadbarSlot, this.pill, this.zenBubble, this.diag);

    // Install the RPC bridge once. It answers nothing until `setViewport` is
    // called with the iframe this shell created, so any other frame is ignored.
    this.bridge = installSandboxBridge({
      handlers: createRpcHandlers({
        getProfileId: () => this.store.get().activeProfileId ?? '',
      }),
      onReject: (reason) => console.warn('sandbox bridge rejected message:', reason),
      onFrameError: (report) => this.showDiagnostic(report),
    });

    this.store.subscribe((state) => this.render(state));
    void this.bootstrap();
  }

  private viewportEl!: HTMLDivElement;
  private pill!: HTMLDivElement;
  private zenBubble!: HTMLButtonElement;
  private zenButton!: HTMLButtonElement;
  private tabsButton!: HTMLButtonElement;
  private urlDisplay!: HTMLButtonElement;
  private urlText!: HTMLSpanElement;
  private urlLock!: SVGSVGElement;
  private diag!: HTMLDivElement;
  private editing = false;
  private zen = false;
  private diagTimer: ReturnType<typeof setTimeout> | null = null;
  private loadbarTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Surface a diagnostic from the proxied frame.
   *
   * The frame cannot write to the shell's console, so a page that dies on a
   * script error would otherwise fail silently. This shows one compact line and
   * auto-dismisses; tapping it dismisses immediately.
   */
  private showDiagnostic(report: { kind: string; message: string; detail: string | null }): void {
    if (this.diagTimer) clearTimeout(this.diagTimer);
    const label = report.kind === 'unhandledrejection' ? 'Page error (async)' : 'Page error';
    this.diag.replaceChildren(
      el('span', { class: 'diag__dot' }),
      el('span', { class: 'diag__text', text: `${label}: ${report.message}` }),
    );
    this.diag.hidden = false;
    this.diagTimer = setTimeout(() => {
      this.diagTimer = null;
      this.diag.hidden = true;
    }, 8000);
  }

  /* ------------------------------------------------------------- pill UX */

  /** Swap the URL label for a real input, keeping the pill's geometry. */
  private beginEditing(): void {
    if (this.editing) return;
    this.editing = true;
    const state = this.store.get();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    this.addressInput.value = tab && tab.url !== NEW_TAB_URL ? displayUrl(tab.url) : '';
    this.urlDisplay.hidden = true;
    this.addressInput.hidden = false;
    this.addressInput.focus();
  }

  private endEditing(): void {
    if (!this.editing) return;
    this.editing = false;
    this.addressInput.hidden = true;
    this.urlDisplay.hidden = false;
    this.renderUrlLabel(this.store.get());
  }

  /** Show the current page's host, or a hint when there is no page. */
  private renderUrlLabel(state: ReturnType<Store['get']>): void {
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    const hasPage = !!tab && tab.url !== NEW_TAB_URL;
    this.urlDisplay.classList.toggle('pill__url--empty', !hasPage);
    this.urlText.textContent = hasPage ? displayUrl(tab.url) : 'Search or enter address';
    // A padlock on a proxied page would imply a TLS guarantee Mirenda cannot
    // make about the target; the glyph signals "contained", not "verified".
    this.urlLock.style.opacity = hasPage ? '1' : '0.45';
  }

  /* ------------------------------------------------------------ zen mode */

  private toggleZen(): void {
    this.zen = !this.zen;
    this.pill.classList.toggle('pill--hidden', this.zen);
    this.zenBubble.hidden = !this.zen;
    if (this.zen) {
      this.zenBubble.style.left = '';
      this.zenBubble.style.top = '';
      this.zenBubble.style.right = '14px';
      this.zenBubble.style.bottom = 'calc(18px + var(--safe-bottom))';
    }
  }

  /**
   * Let the zen bubble be dragged anywhere in the viewport.
   *
   * Pointer events (not mouse events) so a touch drag works without the page
   * scrolling underneath. A tap without movement exits zen mode.
   */
  private makeDraggable(handle: HTMLElement): void {
    let dragging = false;
    let moved = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = handle.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      dragging = true;
      moved = false;
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      if (Math.abs(event.movementX) + Math.abs(event.movementY) > 0) moved = true;
      const x = Math.min(Math.max(0, event.clientX - offsetX), window.innerWidth - handle.offsetWidth);
      const y = Math.min(Math.max(0, event.clientY - offsetY), window.innerHeight - handle.offsetHeight);
      handle.style.left = `${x}px`;
      handle.style.top = `${y}px`;
      handle.style.right = 'auto';
      handle.style.bottom = 'auto';
    });

    const end = (event: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      // A tap (no movement) is the exit gesture; a drag just repositions.
      if (!moved) this.toggleZen();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /* ------------------------------------------------------------ rendering */

  private render(state: ReturnType<Store['get']>): void {
    this.tabCount.textContent = String(state.tabs.length);
    this.tabCount.classList.toggle('pill__count--busy', state.loading);
    if (!this.editing) this.renderUrlLabel(state);

    const profile = state.profiles.find((p) => p.id === state.activeProfileId) ?? null;
    // Tint the pill's hairline with the active profile's colour.
    document.documentElement.style.setProperty('--profile-tint', profile?.color ?? '#ff7a18');

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
      this.viewportEl.append(this.buildHomeScreen());
      return;
    }

    this.setLoading(true);
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
      // This is what makes `event.origin` opaque inside the frame, and it is
      // also why the runtime shim has to virtualise cookies and storage.
      sandbox: 'allow-scripts allow-forms allow-popups allow-modals allow-downloads',
      referrerpolicy: 'no-referrer',
      allow: 'fullscreen',
      title: 'Proxied page',
    });
    frame.addEventListener('load', () => this.setLoading(false));
    this.iframe = frame;
    this.viewportEl.append(frame);
    // Tell the bridge which frame is trustworthy. Until this call the bridge
    // answers nothing, so a frame created elsewhere can never reach the API.
    this.bridge?.setViewport(frame);
    // A frame that never fires `load` (blocked upstream) must not leave the
    // pill pulsing forever.
    this.loadbarTimer = setTimeout(() => this.setLoading(false), 20_000);
  }

  /** Toggle the pill's busy affordance and the top load bar. */
  private setLoading(loading: boolean): void {
    this.store.set({ loading });
    const slot = document.querySelector('.loadbar-slot');
    if (!slot) return;
    if (loading) {
      if (!slot.firstChild) slot.append(el('div', { class: 'loadbar' }));
    } else {
      slot.replaceChildren();
      if (this.loadbarTimer) {
        clearTimeout(this.loadbarTimer);
        this.loadbarTimer = null;
      }
    }
  }

  /** The new-tab screen: branding, a search field, and quick-launch chips. */
  private buildHomeScreen(): HTMLElement {
    const mark = el('div', { class: 'home__mark' });
    mark.append(icon('shield'));

    const input = el('input', {
      type: 'text',
      inputmode: 'search',
      enterkeyhint: 'go',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      placeholder: 'Search or enter address',
      'aria-label': 'Search or enter address',
    });

    const submit = (): void => {
      const target = normalizeAddressInput(input.value);
      if (!target) return;
      input.value = '';
      void this.navigate(target);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });

    const searchRow = el('div', { class: 'home__search' }, icon('search'), input);
    searchRow.addEventListener('click', () => input.focus());

    const chips = el('div', { class: 'home__chips' });
    const quick = this.store.get().bookmarks.slice(0, 6);
    if (quick.length > 0) {
      for (const bookmark of quick) {
        const chip = el(
          'button',
          { class: 'home__chip', type: 'button' },
          el('span', { class: 'home__chip__dot' }),
          document.createTextNode(bookmark.title || originOf(bookmark.url)),
        );
        chip.addEventListener('click', () => void this.navigate(bookmark.url));
        chips.append(chip);
      }
    } else {
      // No bookmarks yet: offer the sites that exercise the proxy hardest.
      for (const site of [
        { label: 'Wikipedia', url: 'https://en.wikipedia.org/' },
        { label: 'DuckDuckGo', url: 'https://duckduckgo.com/' },
        { label: 'Google', url: 'https://www.google.com/' },
      ]) {
        const chip = el(
          'button',
          { class: 'home__chip', type: 'button' },
          el('span', { class: 'home__chip__dot' }),
          document.createTextNode(site.label),
        );
        chip.addEventListener('click', () => void this.navigate(site.url));
        chips.append(chip);
      }
    }

    return el(
      'div',
      { class: 'home' },
      mark,
      el('h1', { class: 'home__title', text: 'Mirenda' }),
      el('p', { class: 'home__subtitle', text: 'Private browsing, in your browser' }),
      searchRow,
      chips,
    );
  }

  /* -------------------------------------------------------------- actions */

  private async bootstrap(): Promise<void> {
    const state = this.store.get();
    if (!state.user) return;
    if (state.profiles.length === 0) {
      // Re-check with the server before creating anything: an empty local list
      // can simply mean the profile load has not finished yet.
      const existing = await api.listProfiles();
      const first = existing[0];
      if (first) {
        const activeProfileId = first.id;
        this.store.set({ profiles: existing, activeProfileId });
        await this.loadProfileScoped(activeProfileId);
        await this.loadTabs(activeProfileId);
        return;
      }
      const profile = await api.createProfile({ name: 'Personal', color: '#4f8cff' });
      this.store.set({ profiles: [profile], activeProfileId: profile.id });
      await this.loadProfileScoped(profile.id);
      await this.ensureTab(profile.id);
      return;
    }
    const activeProfileId = state.activeProfileId ?? state.profiles[0]?.id ?? null;
    this.store.set({ activeProfileId });
    if (activeProfileId) {
      await this.loadProfileScoped(activeProfileId);
      await this.loadTabs(activeProfileId);
    }
  }

  /**
   * Load the per-profile data the shell renders outside the viewport:
   * bookmarks for the home screen and the extension registry for the Tools
   * sheet. A failure here must not break browsing, so it is contained.
   */
  private async loadProfileScoped(profileId: string): Promise<void> {
    try {
      const [extensions, bookmarks] = await Promise.all([
        api.listExtensions(profileId),
        api.listBookmarks(profileId),
      ]);
      this.store.set({
        extensions,
        bookmarks,
        enabledExtensions: new Set(extensions.filter((e) => e.enabled).map((e) => e.id)),
      });
    } catch {
      this.store.set({ extensions: [], bookmarks: [] });
    }
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

  /** The `⚡ Tools` sheet: extensions, UA, reload, profiles, and the vault. */
  private openTools(): void {
    const state = this.store.get();
    openToolsSheet({
      extensions: state.extensions,
      enabled: state.enabledExtensions,
      vaultUnlocked: this.vaultKey !== null,
      onToggleExtension: (id, enabled) => this.sheetDeps().toggleExtension(id, enabled),
      onOpenUserAgent: () => this.openUserAgent('tab'),
      onReload: () => this.reload(),
      onHardReload: () => this.hardReload(),
      onOpenProfiles: () => this.openProfiles(),
      onOpenVault: () => this.openVault(),
      onOpenExtensions: () => this.openExtensions(),
    });
  }

  /** Reload bypassing every cache the worker and browser might hold. */
  private hardReload(): void {
    const state = this.store.get();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab || tab.url === NEW_TAB_URL) return;
    void this.renderViewport(`${tab.url}${tab.url.includes('?') ? '&' : '?'}mirenda_cachebust=${Date.now()}`);
  }

  /** A pill button that matches the shell's visual language. */
  private pillButton(
    name: Parameters<typeof icon>[0],
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = el('button', { class: 'pill__btn', type: 'button', 'aria-label': label, title: label });
    button.append(icon(name));
    button.addEventListener('click', onClick);
    return button;
  }

  /** Surface a transient status message; kept for legacy call sites. */
  private showStatus(message: string, isError = false): void {
    if (this.diagTimer) clearTimeout(this.diagTimer);
    this.diag.replaceChildren(
      el('span', { class: 'diag__dot' }),
      el('span', { class: 'diag__text', text: message }),
    );
    this.diag.style.borderColor = isError ? 'rgba(255, 92, 108, 0.42)' : 'rgba(255, 255, 255, 0.16)';
    this.diag.hidden = false;
    this.diagTimer = setTimeout(() => {
      this.diagTimer = null;
      this.diag.hidden = true;
    }, isError ? 6000 : 3000);
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
  // Load profiles before mounting: mount() kicks off bootstrap(), which creates
  // a default profile whenever it sees an empty list. Mounting first made every
  // reload spawn another profile.
  const profiles = await api.listProfiles();
  const activeProfileId = store.get().activeProfileId ?? profiles[0]?.id ?? null;
  const extensions = activeProfileId ? await api.listExtensions(activeProfileId) : [];
  store.set({
    profiles,
    extensions,
    enabledExtensions: new Set(extensions.filter((extension) => extension.enabled).map((e) => e.id)),
    activeProfileId,
  });

  const app = new BrowserApp({ store, vaultKey });
  app.mount(root);
}

/** Show the auth sheet when there is no session. */
export function bootUnauthenticated(root: HTMLElement, store: Store): void {
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

  // The button lives inside the empty state so its flex column positions it.
  // A sibling wrapper would sit under the opaque overlay, which is
  // `position:absolute; inset:0` — the button renders but is unreachable.
  root.replaceChildren(
    el(
      'div',
      { class: 'viewport__empty' },
      el('h1', { text: 'Mirenda' }),
      el('p', { text: 'A mobile-first cloud browser. Sign in to open your profiles and tabs.' }),
      button,
    ),
  );
}

