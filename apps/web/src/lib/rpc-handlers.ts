/**
 * RPC handlers the shell exposes to the sandboxed viewport.
 *
 * Every handler resolves through the authenticated HTTP API, scoped to the
 * active profile. The profile id is captured here, not taken from the message,
 * so a page cannot ask about another profile's tabs or cookies.
 *
 * There is deliberately no auth or vault handler: the master key never crosses
 * this boundary, and no RPC method can read or write it.
 */
import { api } from './api.js';
import type { SandboxRpcHandlers } from './bridge.js';

export interface RpcHandlerOptions {
  /**
   * The profile every call is scoped to, read fresh per call. A getter rather
   * than a value because the user can switch profiles without the bridge being
   * reinstalled, and a stale id would scope calls to the wrong container.
   */
  getProfileId: () => string;
}

/**
 * Build handlers bound to one profile.
 *
 * `storage` is routed through `/api/plugin-storage`, which validates the plugin
 * id against the built-in catalog. The id comes from the RPC envelope, and the
 * worker refuses anything not in the catalog, so a page cannot invent a
 * namespace — it can only address a real built-in plugin's storage.
 */
export function createRpcHandlers(options: RpcHandlerOptions): SandboxRpcHandlers {
  const profileId = (): string => {
    const id = options.getProfileId();
    if (!id) throw new Error('no active profile');
    return id;
  };

  return {
    tabs: {
      list: () => api.listTabs(profileId()),
      get: async (id) => (await api.listTabs(profileId())).find((tab) => tab.id === id) ?? null,
      create: async (input) => {
        const candidate = input as { url?: unknown; title?: unknown };
        const url = typeof candidate.url === 'string' ? candidate.url : 'about:newtab';
        const title = typeof candidate.title === 'string' ? candidate.title : '';
        return api.createTab({ profileId: profileId(), url, title });
      },
      update: async (id, patch) => {
        const candidate = (patch ?? {}) as { url?: unknown; title?: unknown };
        return api.updateTab(id, profileId(), {
          ...(typeof candidate.url === 'string' ? { url: candidate.url } : {}),
          ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
        });
      },
      activate: async (id) => {
        await api.activateTab(id, profileId());
      },
      close: async (id) => {
        await api.deleteTab(id, profileId());
      },
    },

    cookies: {
      list: (domain) => api.listCookies(profileId(), domain),
      get: async (domain, name) => (await api.listCookies(profileId(), domain)).find((c) => c.name === name) ?? null,
      set: async (domain, cookie) => {
        const candidate = (cookie ?? {}) as { name?: unknown; value?: unknown };
        if (typeof candidate.name !== 'string' || typeof candidate.value !== 'string') {
          throw new Error('cookie name and value are required');
        }
        await api.saveCookie(profileId(), domain, {
          name: candidate.name,
          value: candidate.value,
          ...(cookie as Record<string, unknown>),
        });
      },
      remove: async (domain, name) => {
        await api.deleteCookie(profileId(), domain, name);
      },
      clear: async (domain) => {
        // The API has no bulk clear; delete each visible cookie in turn.
        const cookies = await api.listCookies(profileId(), domain);
        for (const cookie of cookies) await api.deleteCookie(profileId(), domain, cookie.name);
      },
    },

    storage: {
      get: async (pluginId, key) => {
        const data = await api.getPluginStorage(profileId(), pluginId);
        return data[key];
      },
      set: async (pluginId, key, value) => {
        await api.setPluginStorage(profileId(), pluginId, key, value);
      },
      remove: async (pluginId, key) => {
        await api.setPluginStorage(profileId(), pluginId, key, null);
      },
      keys: async (pluginId) => Object.keys(await api.getPluginStorage(profileId(), pluginId)),
      clear: async (pluginId) => {
        // Delete each key individually: the worker has no bulk-clear endpoint,
        // and a delete-per-key keeps the API surface small.
        const data = await api.getPluginStorage(profileId(), pluginId);
        for (const key of Object.keys(data)) {
          await api.setPluginStorage(profileId(), pluginId, key, null);
        }
      },
    },
  };
}
