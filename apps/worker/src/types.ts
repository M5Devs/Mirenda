/** Worker bindings and shared types. */

export interface Env {
  DB: D1Database;
  /** Base URL of the built web UI, used to forward non-API routes in dev. */
  ASSETS?: Fetcher;
  ENVIRONMENT?: string;
  /** Optional comma-separated allowlist of extra origins for CORS. */
  ALLOWED_ORIGINS?: string;
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
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response> | Response;

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Pattern with `:name` segments, e.g. `/api/tabs/:id`. */
  pattern: string;
  handler: RouteHandler;
  /** Requires a valid session; the router answers 401 otherwise. */
  auth: boolean;
}
