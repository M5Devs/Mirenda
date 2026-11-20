/**
 * Injected entrypoint. The worker appends this bundle before `</body>`, so it
 * boots immediately and exports nothing.
 */
import { activate } from './plugin.js';

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  activate();
}
