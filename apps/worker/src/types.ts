/**
 * Worker bindings and shared types.
 *
 * Mirenda deploys as two roles from one codebase:
 *   - `app`     — UI, auth, profiles, tabs, vault. Holds the session cookie.
 *   - `sandbox` — `/proxy` and the extension sandbox. Holds no session cookie;
 *                 it authenticates `/proxy` with a scoped proxy token.
 *   - `all`     — both in one Worker, which is what `wrangler dev` runs and what
 *                 a single-origin deployment uses.
 *
 * `WORKER_ROLE` selects the role; `src/index.ts` refuses routes that do not
 * belong to it. Sharing D1 across roles is intentional: the sandbox must read
 * the same profiles and cookie jars the app writes.
 */

export type WorkerRole = 'app' | 'sandbox' | 'all';

export interface Env {
  DB: D1Database;
  /** Static asset binding. Present on the `app` and `all` roles only. */
  ASSETS?: Fetcher;
  ENVIRONMENT?: string;
  /** Which surface this deployment serves. Defaults to `all`. */
  WORKER_ROLE?: string;
  /**
   * Origin allowlist for CORS and for the sandbox's postMessage checks.
   * In a split deployment each Worker lists the other's origin here.
   */
  ALLOWED_ORIGINS?: string;
  /**
   * HMAC secret for proxy tokens. Required whenever the role can serve
   * `/proxy` (`sandbox` or `all`). Set with `wrangler secret put`.
   */
  PROXY_TOKEN_SECRET?: string;
  /** Public origin of the sandbox Worker, used to build `/proxy` URLs. */
  SANDBOX_ORIGIN?: string;
  /** Public origin of the app Worker, used by the shell to address the sandbox. */
  APP_ORIGIN?: string;
}

/** The authenticated caller, resolved from the session cookie. */
export interface SessionUser {
  id: string;
  email: string;
}

/** Per-request context handed to route handlers. */
export interface RouteContext {
  request: Request;
  env: Env;
  url: URL;
  user: SessionUser | null;
  params: Record<string, string>;
  /**
   * Set when `/proxy` was authorised by a proxy token rather than a session.
   * The token's claims are authoritative for `(userId, profileId)`.
   */
  proxyAuth?: { userId: string; profileId: string };
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response> | Response;

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Pattern with `:name` segments, e.g. `/api/tabs/:id`. */
  pattern: string;
  handler: RouteHandler;
  /** Requires a valid session; the router answers 401 otherwise. */
  auth: boolean;
  /**
   * Which worker roles serve this route. Omitted means every role.
   * `/proxy` is `['sandbox', 'all']`; `/api/*` is `['app', 'all']`.
   */
  roles?: readonly WorkerRole[];
}
