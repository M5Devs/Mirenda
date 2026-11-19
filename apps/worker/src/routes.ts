/** The full route table. Order matters only within the same method + shape. */
import { login, logout, me, register, vaultSalt } from './routes/auth.js';
import { createProxyHandler, type ProxyDeps } from './routes/proxy.js';
import { getExtensions, toggleExtension } from './routes/extensions.js';
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
  return [
    // ---- auth (public) ----------------------------------------------------
    { method: 'POST', pattern: '/api/auth/register', handler: register, auth: false },
    { method: 'POST', pattern: '/api/auth/login', handler: login, auth: false },
    { method: 'POST', pattern: '/api/auth/logout', handler: logout, auth: false },
    { method: 'GET', pattern: '/api/auth/me', handler: me, auth: false },
    { method: 'GET', pattern: '/api/vault/salt', handler: vaultSalt, auth: true },

    // ---- extensions -------------------------------------------------------
    { method: 'GET', pattern: '/api/extensions', handler: getExtensions, auth: true },
    { method: 'POST', pattern: '/api/extensions/:extensionId', handler: toggleExtension, auth: true },

    // ---- profiles ---------------------------------------------------------
    { method: 'GET', pattern: '/api/profiles', handler: getProfiles, auth: true },
    { method: 'POST', pattern: '/api/profiles', handler: createProfile, auth: true },
    { method: 'PATCH', pattern: '/api/profiles/:profileId', handler: patchProfile, auth: true },
    { method: 'DELETE', pattern: '/api/profiles/:profileId', handler: removeProfile, auth: true },

    // ---- tabs -------------------------------------------------------------
    { method: 'GET', pattern: '/api/tabs', handler: getTabs, auth: true },
    { method: 'POST', pattern: '/api/tabs', handler: createTab, auth: true },
    { method: 'PATCH', pattern: '/api/tabs/:tabId', handler: patchTab, auth: true },
    { method: 'POST', pattern: '/api/tabs/:tabId/activate', handler: activateTabRoute, auth: true },
    { method: 'DELETE', pattern: '/api/tabs/:tabId', handler: removeTab, auth: true },

    // ---- bookmarks --------------------------------------------------------
    { method: 'GET', pattern: '/api/bookmarks', handler: getBookmarks, auth: true },
    { method: 'POST', pattern: '/api/bookmarks', handler: createBookmark, auth: true },
    { method: 'DELETE', pattern: '/api/bookmarks/:bookmarkId', handler: removeBookmark, auth: true },

    // ---- history ----------------------------------------------------------
    { method: 'GET', pattern: '/api/history', handler: getHistory, auth: true },
    { method: 'POST', pattern: '/api/history', handler: createHistoryEntry, auth: true },
    { method: 'DELETE', pattern: '/api/history', handler: clearHistoryRoute, auth: true },

    // ---- vault (client-sealed ciphertext only) ----------------------------
    { method: 'GET', pattern: '/api/vault', handler: getVault, auth: true },
    { method: 'POST', pattern: '/api/vault', handler: putVaultItem, auth: true },
    { method: 'DELETE', pattern: '/api/vault/:itemId', handler: removeVaultItem, auth: true },

    // ---- proxy ------------------------------------------------------------
    // One handler instance so the registry and API factory are built once.
    { method: 'GET', pattern: '/proxy', handler: proxy, auth: true },
    { method: 'POST', pattern: '/proxy', handler: proxy, auth: true },
  ];
}
