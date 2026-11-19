/**
 * Web entrypoint.
 *
 * A reload keeps the session cookie but not the in-memory vault key, so an
 * authenticated reload boots the shell in a locked state and offers an unlock.
 * The key is never persisted: that is the zero-knowledge trade-off.
 */
import './styles/app.css';
import { api } from './lib/api.js';
import { store } from './lib/store.js';
import { bootAuthenticated, bootUnauthenticated } from './ui/app.js';

const root = document.getElementById('app');
if (!root) throw new Error('#app root element is missing');

void (async () => {
  const user = await api.me().catch(() => null);
  store.set({ user });

  if (!user) {
    bootUnauthenticated(root, store);
    return;
  }

  await bootAuthenticated(root, store, null);
})();
