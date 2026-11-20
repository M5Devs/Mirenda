/** The full route table. Order matters only within the same method + shape. */
import { login, logout, me, register, vaultSalt } from './routes/auth.js';
import { createProxyHandler, type ProxyDeps } from './routes/proxy.js';
import {
  deleteCookie,
  getCookies,
  getExtensions,
  importCookies,
  getPluginStorage,
  setPluginStorage,
  toggleExtension,
  upsertCookie,
} from './routes/extensions.js';
import { createProxyToken } from './routes/proxy-token.js';
import {
  activateTabRoute,
  clearHistoryRoute,
  createBookmark,
  createHistoryEntry,
  createProfile,
  createTab,
  getBookmarks,
  getHistory,
  getProfiles,
  getTabs,
  getVault,
  patchProfile,
  patchTab,
  putVaultItem,
  removeBookmark,
  removeProfile,
  removeTab,
  removeVaultItem,
} from './routes/sync.js';
import type { Route } from './types.js';

export function buildRoutes(deps: ProxyDeps): Route[] {
  const proxy = createProxyHandler(deps);
  /**
   * `/api/*` belongs to the app role (UI, auth, sync). `/proxy` belongs to the
   * sandbox role. In a split deployment each Worker refuses the other's routes
   * with 404, so a request that reaches the wrong origin cannot do anything —
   * the sandbox has no vault endpoint and the app has no proxy.
   */
  const appOnly = ['app', 'all'] as const;
  const sandboxOnly = ['sandbox', 'all'] as const;
  return [
    // ---- auth (public) ----------------------------------------------------
    { method: 'POST', pattern: '/api/auth/register', handler: register, auth: false, roles: appOnly },
    { method: 'POST', pattern: '/api/auth/login', handler: login, auth: false, roles: appOnly },
    { method: 'POST', pattern: '/api/auth/logout', handler: logout, auth: false, roles: appOnly },
    { method: 'GET', pattern: '/api/auth/me', handler: me, auth: false, roles: appOnly },
    { method: 'GET', pattern: '/api/vault/salt', handler: vaultSalt, auth: true, roles: appOnly },

    // ---- extensions -------------------------------------------------------
    { method: 'GET', pattern: '/api/extensions', handler: getExtensions, auth: true, roles: appOnly },
    { method: 'POST', pattern: '/api/extensions/:extensionId', handler: toggleExtension, auth: true, roles: appOnly },

    // ---- profiles ---------------------------------------------------------
    { method: 'GET', pattern: '/api/profiles', handler: getProfiles, auth: true, roles: appOnly },
    { method: 'POST', pattern: '/api/profiles', handler: createProfile, auth: true, roles: appOnly },
    { method: 'PATCH', pattern: '/api/profiles/:profileId', handler: patchProfile, auth: true, roles: appOnly },
    { method: 'DELETE', pattern: '/api/profiles/:profileId', handler: removeProfile, auth: true, roles: appOnly },

    // ---- tabs -------------------------------------------------------------
    { method: 'GET', pattern: '/api/tabs', handler: getTabs, auth: true, roles: appOnly },
    { method: 'POST', pattern: '/api/tabs', handler: createTab, auth: true, roles: appOnly },
    { method: 'PATCH', pattern: '/api/tabs/:tabId', handler: patchTab, auth: true, roles: appOnly },
    { method: 'POST', pattern: '/api/tabs/:tabId/activate', handler: activateTabRoute, auth: true, roles: appOnly },
    { method: 'DELETE', pattern: '/api/tabs/:tabId', handler: removeTab, auth: true, roles: appOnly },

    // ---- bookmarks --------------------------------------------------------
    { method: 'GET', pattern: '/api/bookmarks', handler: getBookmarks, auth: true, roles: appOnly },
    { method: 'POST', pattern: '/api/bookmarks', handler: createBookmark, auth: true, roles: appOnly },
    { method: 'DELETE', pattern: '/api/bookmarks/:bookmarkId', handler: removeBookmark, auth: true, roles: appOnly },

    // ---- history ----------------------------------------------------------
    { method: 'GET', pattern: '/api/history', handler: getHistory, auth: true, roles: appOnly },
    { method: 'POST', pattern: '/api/history', handler: createHistoryEntry, auth: true, roles: appOnly },
    { method: 'DELETE', pattern: '/api/history', handler: clearHistoryRoute, auth: true, roles: appOnly },

    // ---- vault (client-sealed ciphertext only) ----------------------------
    { method: 'GET', pattern: '/api/vault', handler: getVault, auth: true, roles: appOnly },
    { method: 'POST', pattern: '/api/vault', handler: putVaultItem, auth: true, roles: appOnly },
    { method: 'DELETE', pattern: '/api/vault/:itemId', handler: removeVaultItem, auth: true, roles: appOnly },

    // ---- cookies (Virtual Cookie Jar via the session) ----------------------
    { method: 'GET', pattern: '/api/cookies', handler: getCookies, auth: true, roles: appOnly },
    { method: 'POST', pattern: '/api/cookies', handler: upsertCookie, auth: true, roles: appOnly },
    { method: 'POST', pattern: '/api/cookies/import', handler: importCookies, auth: true, roles: appOnly },
    { method: 'DELETE', pattern: '/api/cookies', handler: deleteCookie, auth: true, roles: appOnly },

    // ---- plugin storage (page-runtime persistence over the bridge) ---------
    { method: 'GET', pattern: '/api/plugin-storage', handler: getPluginStorage, auth: true, roles: appOnly },
    { method: 'POST', pattern: '/api/plugin-storage', handler: setPluginStorage, auth: true, roles: appOnly },

    // ---- proxy token (app mints; sandbox verifies) -------------------------
    { method: 'POST', pattern: '/api/proxy-token', handler: createProxyToken, auth: true, roles: appOnly },

    // ---- proxy ------------------------------------------------------------
    // `auth: false` on purpose: the handler authorises itself, accepting either a
    // session cookie (single-origin) or a scoped proxy token (split). Requiring a
    // session here would 401 every request in a split deployment, where the
    // sandbox origin never receives the app's SameSite=Lax cookie.
    { method: 'GET', pattern: '/proxy', handler: proxy, auth: false, roles: sandboxOnly },
    { method: 'POST', pattern: '/proxy', handler: proxy, auth: false, roles: sandboxOnly },
  ];
}
