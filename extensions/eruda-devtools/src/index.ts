/**
 * Injected entrypoint. The worker appends this bundle before `</body>` of every
 * proxied page, so it boots immediately and exports nothing.
 *
 * Eruda is MIT licensed (https://github.com/liriliri/eruda); this wrapper is
 * AGPL-3.0 like the rest of the built-in extensions. Eruda inspects the proxied
 * document only — it runs inside the sandboxed viewport iframe, which has no
 * access to Mirenda's session.
 */
import { activate } from './plugin.js';

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  activate();
}
