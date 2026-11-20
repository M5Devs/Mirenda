/**
 * Origin policy and RPC surface for the app ⇄ sandbox trust boundary.
 *
 * Lives in the SDK because both sides of the boundary need the same rules and
 * must never drift: the web shell enforces them, and extensions read the method
 * allowlist. It is pure, dependency-free and side-effect-free, which keeps the
 * SDK's "no runtime deps" rule intact.
 *
 * The sandbox viewport runs proxied pages and extension scripts. Its origin is
 * **opaque** (the iframe is sandboxed without `allow-same-origin`), so anything
 * it sends arrives with `event.origin === 'null'` and is, by definition,
 * untrusted. Two rules follow and are enforced here rather than at call sites:
 *
 *   1. The shell only answers `postMessage` traffic whose `event.source` is the
 *      viewport iframe it created. Origin alone is not enough: `null` is shared
 *      by every opaque context on the page, including any other sandboxed frame
 *      a hostile page might create.
 *   2. The shell never answers with credentials. The RPC surface exposed to the
 *      sandbox is an allowlist of methods that touch only tabs/cookies/storage
 *      for the active profile — never auth, vault, or profile mutation.
 *
 * `parseOrigins` and `isAllowedOrigin` handle the *non-opaque* direction: the
 * app talking to a separately deployed sandbox worker over CORS/fetch, and
 * validating a `MessageEvent` that claims a real origin.
 */

/** Split a comma-separated origin allowlist, dropping blanks and trailing slashes. */
export function parseOrigins(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter((value) => value !== '')
    .map((value) => value.toLowerCase());
}

/**
 * Is `origin` in the allowlist? `null`/`'null'` never match: an opaque origin
 * cannot be allowlisted, and treating it as allowed would defeat the split.
 */
export function isAllowedOrigin(origin: string | null | undefined, allowed: readonly string[]): boolean {
  if (!origin || origin === 'null') return false;
  const normalized = origin.trim().replace(/\/+$/, '').toLowerCase();
  return allowed.some((entry) => entry === normalized);
}

/**
 * Is this message event coming from the exact frame the shell created?
 *
 * Both checks are required. `event.source` identifies *which* window sent it —
 * an unrelated sandboxed iframe on the same page cannot spoof it, whereas
 * `event.origin` is `'null'` for all of them and carries no information.
 *
 * `expectedSource` may be `null` while the iframe is still loading; in that
 * case nothing is trusted yet and the answer is `false`.
 */
export function isTrustedViewportMessage(
  event: { source: unknown; origin: string },
  expectedSource: unknown | null,
): boolean {
  if (expectedSource === null || expectedSource === undefined) return false;
  if (event.source !== expectedSource) return false;
  // The viewport is sandboxed without `allow-same-origin`, so its origin must be
  // opaque. A real origin here means the frame escaped the sandbox contract.
  return event.origin === 'null' || event.origin === '';
}

/**
 * Should the shell accept a *real-origin* message, e.g. from a separately
 * deployed sandbox worker's own frame? Requires an explicit allowlist match.
 */
export function isTrustedCrossOriginMessage(
  event: { source: unknown; origin: string },
  expectedSource: unknown | null,
  allowedOrigins: readonly string[],
): boolean {
  if (expectedSource === null || expectedSource === undefined) return false;
  if (event.source !== expectedSource) return false;
  return isAllowedOrigin(event.origin, allowedOrigins);
}

/**
 * The RPC methods the shell will answer for the sandbox. Anything not listed is
 * refused, so a compromised page cannot reach auth, vault, or profile mutation
 * even if it guesses a method name.
 *
 * Note what is absent: no `auth.*`, no `vault.*`, no `profiles.*`. The master
 * key and session live only in the app origin's memory and cookies.
 */
export const SANDBOX_RPC_METHODS = [
  'tabs.list',
  'tabs.get',
  'tabs.create',
  'tabs.update',
  'tabs.activate',
  'tabs.close',
  // `network.fetch` is intentionally absent: the sandbox does not get a
  // shell-brokered fetch. A page already fetches through `/proxy`, which keeps
  // cookie injection and rate limiting in one place. Adding it here would hand
  // hostile page scripts a credentialed fetch that bypasses both.
  'cookies.list',
  'cookies.get',
  'cookies.set',
  'cookies.remove',
  'cookies.clear',
  'storage.get',
  'storage.set',
  'storage.remove',
  'storage.keys',
  'storage.clear',
] as const;

export type SandboxRpcMethod = (typeof SANDBOX_RPC_METHODS)[number];

const SANDBOX_RPC_SET: ReadonlySet<string> = new Set(SANDBOX_RPC_METHODS);

/** Is `method` one the shell is willing to answer? */
export function isSandboxRpcMethod(method: unknown): method is SandboxRpcMethod {
  return typeof method === 'string' && SANDBOX_RPC_SET.has(method);
}
