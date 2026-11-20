/**
 * Application state. A tiny observable store — no framework, no build magic.
 *
 * Tabs and profiles mirror the worker; the vault key lives only here, in
 * memory, and is never persisted to localStorage or sent to the server.
 */
import type { Bookmark, ExtensionRecord, Profile, Tab, User } from './api.js';

export interface BrowserState {
  user: User | null;
  profiles: Profile[];
  activeProfileId: string | null;
  tabs: Tab[];
  activeTabId: string | null;
  extensions: ExtensionRecord[];
  /** Extension ids the user has switched on. */
  enabledExtensions: Set<string>;
  /** Quick-launch bookmarks for the active profile, shown on the home screen. */
  bookmarks: Bookmark[];
  /** True when the vault key is unlocked for the active profile. */
  vaultUnlocked: boolean;
  addressValue: string;
  loading: boolean;
  error: string | null;
}

type Listener = (state: BrowserState) => void;

export class Store {
  private state: BrowserState;
  private readonly listeners = new Set<Listener>();

  constructor(initial: Partial<BrowserState> = {}) {
    this.state = {
      user: null,
      profiles: [],
      activeProfileId: null,
      tabs: [],
      activeTabId: null,
      extensions: [],
      enabledExtensions: new Set(),
      bookmarks: [],
      vaultUnlocked: false,
      addressValue: '',
      loading: false,
      error: null,
      ...initial,
    };
  }

  get(): Readonly<BrowserState> {
    return this.state;
  }

  set(patch: Partial<BrowserState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  /** Functional update for derived fields (e.g. toggling a set member). */
  update(producer: (state: BrowserState) => Partial<BrowserState>): void {
    this.set(producer(this.state));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  activeProfile(): Profile | null {
    return this.state.profiles.find((profile) => profile.id === this.state.activeProfileId) ?? null;
  }

  activeTab(): Tab | null {
    return this.state.tabs.find((tab) => tab.id === this.state.activeTabId) ?? null;
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

export const store = new Store();
