/** Typed client for the worker's JSON API. Cookies carry the session. */

export interface User {
  id: string;
  email: string;
}

export interface AuthResponse {
  user: User;
  /** Public per-user salt for deriving the client-side vault key. */
  vaultSalt: string;
}

export interface Profile {
  id: string;
  userId: string;
  name: string;
  color: string;
  userAgent: string | null;
  createdAt: string;
}

export interface Tab {
  id: string;
  profileId: string;
  url: string;
  title: string;
  isActive: boolean;
  position: number;
  updatedAt: string;
  /** Per-tab User-Agent override; `null` inherits the profile default. */
  userAgent?: string | null;
}

export interface Bookmark {
  id: string;
  profileId: string;
  url: string;
  title: string;
  createdAt: string;
}

export interface HistoryEntry {
  id: string;
  profileId: string;
  url: string;
  title: string;
  visitedAt: string;
}

export interface VaultItem {
  id: string;
  profileId: string;
  domain: string;
  itemType: 'cookie' | 'credential';
  encryptedBlob: string;
  iv: string;
  updatedAt: string;
}

export interface ExtensionRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
  matches: string[];
  /** Whether this profile currently injects the extension. */
  enabled: boolean;
}

export interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface ProxyToken {
  token: string;
  expiresIn: number;
  /** Sandbox origin to send proxied requests to, or `null` for same-origin. */
  sandboxOrigin: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const contentType = response.headers.get('content-type') ?? '';
  const payload: unknown = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `request failed with ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return payload as T;
}

export const api = {
  async me(): Promise<User | null> {
    try {
      const { user } = await request<{ user: User }>('/api/auth/me');
      return user;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },

  async register(email: string, password: string): Promise<AuthResponse> {
    return request<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  async login(email: string, password: string): Promise<AuthResponse> {
    return request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  /** Fetch the caller's vault salt so a new device can derive the same key. */
  async vaultSalt(): Promise<string> {
    return (await request<{ vaultSalt: string }>('/api/vault/salt')).vaultSalt;
  },

  async logout(): Promise<void> {
    await request('/api/auth/logout', { method: 'POST' });
  },

  async listProfiles(): Promise<Profile[]> {
    return (await request<{ profiles: Profile[] }>('/api/profiles')).profiles;
  },

  async createProfile(input: { name: string; color?: string; userAgent?: string | null }): Promise<Profile> {
    return (await request<{ profile: Profile }>('/api/profiles', { method: 'POST', body: JSON.stringify(input) }))
      .profile;
  },

  async updateProfile(
    id: string,
    patch: { name?: string; color?: string; userAgent?: string | null },
  ): Promise<Profile> {
    return (
      await request<{ profile: Profile }>(`/api/profiles/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
    ).profile;
  },

  async deleteProfile(id: string): Promise<void> {
    await request(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async listTabs(profileId: string): Promise<Tab[]> {
    return (await request<{ tabs: Tab[] }>(`/api/tabs?profileId=${encodeURIComponent(profileId)}`)).tabs;
  },

  async createTab(input: { profileId: string; url: string; title?: string }): Promise<Tab> {
    return (await request<{ tab: Tab }>('/api/tabs', { method: 'POST', body: JSON.stringify(input) })).tab;
  },

  async updateTab(
    id: string,
    profileId: string,
    patch: { url?: string; title?: string; isActive?: boolean; position?: number; userAgent?: string | null },
  ): Promise<Tab> {
    return (
      await request<{ tab: Tab }>(`/api/tabs/${encodeURIComponent(id)}?profileId=${encodeURIComponent(profileId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
    ).tab;
  },

  async activateTab(id: string, profileId: string): Promise<Tab[]> {
    return (
      await request<{ tabs: Tab[] }>(
        `/api/tabs/${encodeURIComponent(id)}/activate?profileId=${encodeURIComponent(profileId)}`,
        { method: 'POST' },
      )
    ).tabs;
  },

  async deleteTab(id: string, profileId: string): Promise<void> {
    await request(`/api/tabs/${encodeURIComponent(id)}?profileId=${encodeURIComponent(profileId)}`, {
      method: 'DELETE',
    });
  },

  async listBookmarks(profileId: string): Promise<Bookmark[]> {
    return (await request<{ bookmarks: Bookmark[] }>(`/api/bookmarks?profileId=${encodeURIComponent(profileId)}`))
      .bookmarks;
  },

  async createBookmark(input: { profileId: string; url: string; title?: string }): Promise<Bookmark> {
    return (
      await request<{ bookmark: Bookmark }>('/api/bookmarks', { method: 'POST', body: JSON.stringify(input) })
    ).bookmark;
  },

  async deleteBookmark(id: string): Promise<void> {
    await request(`/api/bookmarks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async listHistory(profileId: string, limit = 100): Promise<HistoryEntry[]> {
    return (
      await request<{ history: HistoryEntry[] }>(
        `/api/history?profileId=${encodeURIComponent(profileId)}&limit=${limit}`,
      )
    ).history;
  },

  async addHistory(input: { profileId: string; url: string; title?: string }): Promise<HistoryEntry> {
    return (await request<{ entry: HistoryEntry }>('/api/history', { method: 'POST', body: JSON.stringify(input) }))
      .entry;
  },

  async clearHistory(profileId: string): Promise<void> {
    await request(`/api/history?profileId=${encodeURIComponent(profileId)}`, { method: 'DELETE' });
  },

  async listVault(profileId: string, domain?: string): Promise<VaultItem[]> {
    const query = new URLSearchParams({ profileId });
    if (domain) query.set('domain', domain);
    return (await request<{ items: VaultItem[] }>(`/api/vault?${query.toString()}`)).items;
  },

  async putVaultItem(input: {
    profileId: string;
    domain: string;
    itemType: 'cookie' | 'credential';
    encryptedBlob: string;
    iv: string;
    id?: string;
  }): Promise<VaultItem> {
    return (await request<{ item: VaultItem }>('/api/vault', { method: 'POST', body: JSON.stringify(input) })).item;
  },

  async deleteVaultItem(id: string, profileId: string): Promise<void> {
    await request(`/api/vault/${encodeURIComponent(id)}?profileId=${encodeURIComponent(profileId)}`, {
      method: 'DELETE',
    });
  },

  /** Catalog plus this profile's enablement, so the drawer reflects the server. */
  async listExtensions(profileId: string): Promise<ExtensionRecord[]> {
    const query = new URLSearchParams({ profileId });
    return (await request<{ extensions: ExtensionRecord[] }>(`/api/extensions?${query.toString()}`))
      .extensions;
  },

  /** Persist an enablement choice; the proxy reads it on the next page load. */
  async toggleExtension(profileId: string, extensionId: string, enabled: boolean): Promise<void> {
    await request(`/api/extensions/${encodeURIComponent(extensionId)}`, {
      method: 'POST',
      body: JSON.stringify({ profileId, enabled }),
    });
  },

  /**
   * Mint a scoped proxy token for the sandbox origin. In a split deployment the
   * iframe `src` points at another origin, where the session cookie is absent;
   * this token is what authorises it.
   */
  async proxyToken(profileId: string): Promise<ProxyToken> {
    return request<ProxyToken>('/api/proxy-token', {
      method: 'POST',
      body: JSON.stringify({ profileId }),
    });
  },

  /** Non-HttpOnly cookies for one target domain in one profile. */
  async listCookies(profileId: string, domain: string): Promise<JarCookie[]> {
    const query = new URLSearchParams({ profileId, domain });
    return (await request<{ cookies: JarCookie[] }>(`/api/cookies?${query.toString()}`)).cookies;
  },

  async saveCookie(
    profileId: string,
    domain: string,
    cookie: Partial<JarCookie> & { name: string; value: string },
  ): Promise<JarCookie[]> {
    return (
      await request<{ cookies: JarCookie[] }>('/api/cookies', {
        method: 'POST',
        body: JSON.stringify({ profileId, domain, cookie }),
      })
    ).cookies;
  },

  async deleteCookie(profileId: string, domain: string, name: string): Promise<JarCookie[]> {
    const query = new URLSearchParams({ profileId, domain, name });
    return (await request<{ cookies: JarCookie[] }>(`/api/cookies?${query.toString()}`, { method: 'DELETE' }))
      .cookies;
  },

  /** Read one plugin's whole storage namespace for a profile. */
  async getPluginStorage(profileId: string, pluginId: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ profileId, pluginId });
    return (await request<{ data: Record<string, unknown> }>(`/api/plugin-storage?${query.toString()}`)).data;
  },

  /** Write (or, with `value === null`, delete) one key in a plugin namespace. */
  async setPluginStorage(
    profileId: string,
    pluginId: string,
    key: string,
    value: unknown,
  ): Promise<Record<string, unknown>> {
    return (
      await request<{ data: Record<string, unknown> }>('/api/plugin-storage', {
        method: 'POST',
        body: JSON.stringify({ profileId, pluginId, key, value }),
      })
    ).data;
  },

  async importCookies(
    profileId: string,
    domain: string,
    cookies: Array<Partial<JarCookie> & { name: string; value: string }>,
  ): Promise<{ imported: number; cookies: JarCookie[] }> {
    return request<{ imported: number; cookies: JarCookie[] }>('/api/cookies/import', {
      method: 'POST',
      body: JSON.stringify({ profileId, domain, cookies }),
    });
  },
};

/**
 * Build the sandboxed proxy URL for a target page.
 *
 * `token` and `sandboxOrigin` come from `/api/proxy-token`. In a split
 * deployment the URL must point at the sandbox origin and carry the token,
 * because the session cookie never crosses origins. Same-origin dev leaves both
 * empty and gets a relative `/proxy` URL.
 */
export function proxyUrl(
  target: string,
  profileId: string,
  options: { token?: string | null; sandboxOrigin?: string | null; tabId?: string | null } = {},
): string {
  const params = new URLSearchParams({ url: target, profileId });
  if (options.token) params.set('pt', options.token);
  if (options.tabId) params.set('tabId', options.tabId);
  const base = options.sandboxOrigin ? options.sandboxOrigin.replace(/\/+$/, '') : '';
  return `${base}/proxy?${params.toString()}`;
}
