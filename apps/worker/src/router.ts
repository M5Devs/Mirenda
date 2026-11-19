/**
 * A tiny pattern router. Routes are declared once, matched in order, and
 * `:name` segments become `ctx.params`. Authentication is a per-route flag so
 * the public auth endpoints and the authenticated API share one table.
 */
import type { Route, RouteContext, RouteHandler } from './types.js';

interface CompiledRoute extends Route {
  regex: RegExp;
  keys: string[];
}

function compile(route: Route): CompiledRoute {
  const keys: string[] = [];
  const pattern = route.pattern
    .split('/')
    .map((segment: string) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { ...route, regex: new RegExp(`^${pattern}$`), keys };
}

export interface MatchResult {
  route: CompiledRoute;
  params: Record<string, string>;
}

export class Router {
  private readonly routes: CompiledRoute[];

  constructor(routes: readonly Route[]) {
    this.routes = routes.map(compile);
  }

  /** Match method + pathname. Returns `null` when nothing matches. */
  match(method: string, pathname: string): MatchResult | null {
    const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(normalized);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => {
        const value = match[index + 1];
        if (value !== undefined) params[key] = decodeURIComponent(value);
      });
      return { route, params };
    }
    return null;
  }

  /** Does any route exist at this path for a different method? Drives 405 vs 404. */
  hasPath(pathname: string): boolean {
    const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    return this.routes.some((route) => route.regex.test(normalized));
  }

  /** The handler for a match, for convenience at the call site. */
  static handler(match: MatchResult): RouteHandler {
    return match.route.handler;
  }

  static requiresAuth(match: MatchResult): boolean {
    return match.route.auth;
  }

  static context(
    match: MatchResult,
    base: Omit<RouteContext, 'params'>,
  ): RouteContext {
    return { ...base, params: match.params };
  }
}
