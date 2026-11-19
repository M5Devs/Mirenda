/**
 * The extension catalog endpoint, plus the per-request plugin API the worker
 * hands to hooks. The API is scoped to one (user, profile) pair by construction.
 */
import type { MirendaApi, MirendaCookie, MirendaNetworkResponse, MirendaTab } from '@mirenda/sdk';
import {
  activateTab,
  clearJar,
  deleteTab,
  findOwnedProfile,
  findTab,
  insertTab,
  listEnabledExtensions,
  listTabs,
  loadJar,
  saveJar,
  setExtensionEnabled,
  updateTab,
} from '../db/repo.js';
import { cookiesForRequest, mergeCookies, parseSetCookie, readSetCookies } from '../proxy/cookie-jar.js';
import { fail, json, readJsonObject } from '../lib/http.js';
import { extensionCatalog, isBuiltinExtension } from '../extensions/host.js';
import type { Env, RouteContext } from '../types.js';

/** Jar cookies a plugin may observe: HttpOnly stays server-side. */
async function listVisibleCookies(
  env: Env,
  userId: string,
  profileId: string,
  domain: string,
): Promise<MirendaCookie[]> {
  const jar = await loadJar(env.DB, { userId, profileId, domain: domain.toLowerCase() });
  return jar
    .filter((cookie) => !cookie.httpOnly)
    .map(
      (cookie): MirendaCookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      }),
    );
}

function tabToSdk(row: Awaited<ReturnType<typeof findTab>>): MirendaTab | null {
  if (!row) return null;
  return {
    id: row.id,
    profileId: row.profile_id,
    url: row.url,
    title: row.title,
    isActive: row.is_active === 1,
    position: row.position,
    updatedAt: row.updated_at,
  };
}

/**
 * Build a worker-runtime `mirenda` API for one plugin, bound to one profile.
 * Tabs, cookies and storage all resolve through `(userId, profileId)`, so a
 * plugin cannot reach outside the session's own scope.
 */
export function createWorkerPluginApi(
  env: Env,
  pluginId: string,
  userId: string,
  profileId: string,
): MirendaApi {
  const tabListeners = new Set<(tabs: MirendaTab[]) => void>();
  const requestInterceptors = new Set<unknown>();

  const notifyTabs = async (): Promise<void> => {
    if (tabListeners.size === 0) return;
    const rows = await listTabs(env.DB, profileId);
    const tabs = rows.map((row) => tabToSdk(row)).filter((tab): tab is MirendaTab => tab !== null);
    for (const listener of tabListeners) listener(tabs);
  };

  return {
    plugin: { id: pluginId, profileId },
    tabs: {
      async list() {
        const rows = await listTabs(env.DB, profileId);
        return rows.map((row) => tabToSdk(row)).filter((tab): tab is MirendaTab => tab !== null);
      },
      async get(id) {
        return tabToSdk(await findTab(env.DB, profileId, id)) ?? undefined;
      },
      async create(input) {
        const row = await insertTab(env.DB, { profileId, url: input.url, title: input.title ?? '' });
        const tab = tabToSdk(row);
        await notifyTabs();
        if (!tab) throw new Error('failed to create tab');
        return tab;
      },
      async update(id, patch) {
        await updateTab(env.DB, profileId, id, patch);
        const tab = tabToSdk(await findTab(env.DB, profileId, id));
        await notifyTabs();
        if (!tab) throw new Error(`tab not found: ${id}`);
        return tab;
      },
      async activate(id) {
        await activateTab(env.DB, profileId, id);
        await notifyTabs();
      },
      async close(id) {
        await deleteTab(env.DB, profileId, id);
        await notifyTabs();
      },
      onChanged(listener) {
        tabListeners.add(listener);
        return () => tabListeners.delete(listener);
      },
    },
    network: {
      async fetch(url, init) {
        const target = new URL(url);
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
          throw new Error('network.fetch only supports http(s) URLs');
        }
        const jar = await loadJar(env.DB, { userId, profileId, domain: target.hostname.toLowerCase() });
        const headers = new Headers(init?.headers ?? {});
        const matched = cookiesForRequest(jar, target.toString());
        if (matched.length > 0) {
          headers.set('cookie', matched.map((c) => `${c.name}=${c.value}`).join('; '));
        }
        const upstream = await fetch(target.toString(), {
          method: init?.method ?? 'GET',
          headers,
          ...(init?.body !== undefined ? { body: init.body } : {}),
        });
        // Never hand a plugin's response a raw Set-Cookie: it goes to the jar.
        const setCookies = readSetCookies(upstream.headers);
        if (setCookies.length > 0) {
          const received = setCookies
            .map((header: string) => parseSetCookie(header, target.toString()))
            .filter((cookie): cookie is NonNullable<typeof cookie> => cookie !== null);
          await saveJar(
            env.DB,
            { userId, profileId, domain: target.hostname.toLowerCase() },
            mergeCookies(jar, received),
          );
        }
        const responseHeaders: Record<string, string> = {};
        upstream.headers.forEach((value, name) => {
          responseHeaders[name] = value;
        });
        const response: MirendaNetworkResponse = {
          status: upstream.status,
          ok: upstream.ok,
          headers: responseHeaders,
          text: () => upstream.clone().text(),
          json: async <T>() => (await upstream.clone().json()) as T,
        };
        return response;
      },
      addRequestInterceptor(interceptor) {
        // Interceptors registered inside the worker cannot wrap the outer proxy
        // fetch without re-entrancy, so they are tracked and returned as a
        // no-op unsubscribe. Network hooks belong to onRequest instead.
        requestInterceptors.add(interceptor);
        return () => {
          requestInterceptors.delete(interceptor);
        };
      },
    },
    cookies: {
      async list(domain) {
        return listVisibleCookies(env, userId, profileId, domain);
      },
      async get(domain, name) {
        const all = await listVisibleCookies(env, userId, profileId, domain);
        return all.find((cookie) => cookie.name === name);
      },
      async set(domain, cookie) {
        const key = { userId, profileId, domain: domain.toLowerCase() };
        const jar = await loadJar(env.DB, key);
        const next = mergeCookies(jar, [
          {
            name: cookie.name,
            value: cookie.value,
            domain: key.domain,
            path: cookie.path ?? '/',
            ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
            // A plugin cannot mint an HttpOnly cookie; that flag is server-owned.
            httpOnly: false,
            secure: cookie.secure ?? true,
            ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
          },
        ]);
        await saveJar(env.DB, key, next);
      },
      async remove(domain, name) {
        const key = { userId, profileId, domain: domain.toLowerCase() };
        const jar = await loadJar(env.DB, key);
        await saveJar(env.DB, key, jar.filter((cookie) => cookie.name !== name));
      },
      async clear(domain) {
        await clearJar(env.DB, { userId, profileId, domain: domain.toLowerCase() });
      },
    },
    page: {
      // Worker-runtime plugins have no document; these are the page runtime's job.
      url: () => '',
      title: () => '',
      query: () => null,
      queryAll: () => [],
      injectStyle: () => () => undefined,
      notify: () => undefined,
      onNavigate: () => () => undefined,
    },
    storage: createStorage(env, pluginId, profileId),
  };
}

/**
 * Per-plugin, per-profile key/value storage on D1, namespaced by a hashed key so
 * two plugins can use the same key without colliding.
 */
function createStorage(env: Env, pluginId: string, profileId: string) {
  const read = async (): Promise<Record<string, unknown>> => {
    const row = await env.DB.prepare('SELECT value FROM plugin_storage WHERE profile_id = ? AND plugin_id = ?')
      .bind(profileId, pluginId)
      .first<{ value: string }>();
    if (!row) return {};
    try {
      const parsed: unknown = JSON.parse(row.value);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const write = async (data: Record<string, unknown>): Promise<void> => {
    await env.DB.prepare(
      `INSERT INTO plugin_storage (profile_id, plugin_id, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (profile_id, plugin_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(profileId, pluginId, JSON.stringify(data), new Date().toISOString())
      .run();
  };
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const data = await read();
      return data[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      const data = await read();
      data[key] = value;
      await write(data);
    },
    async remove(key: string): Promise<void> {
      const data = await read();
      delete data[key];
      await write(data);
    },
    async keys(): Promise<string[]> {
      return Object.keys(await read());
    },
    async clear(): Promise<void> {
      await write({});
    },
  };
}

/** `GET /api/extensions` — the catalog the UI renders in the drawer. */
/**
 * The catalog plus the calling profile's enablement state. `profileId` is
 * optional so the drawer can render before a profile is selected.
 */
export async function getExtensions({ user, env, url }: RouteContext): Promise<Response> {
  if (!user) return fail(401, 'not authenticated');
  const catalog = extensionCatalog();
  const profileId = url.searchParams.get('profileId');
  if (!profileId) {
    return json({ extensions: catalog.map((extension) => ({ ...extension, enabled: false })) });
  }
  const profile = await findOwnedProfile(env.DB, user.id, profileId);
  if (!profile) return fail(404, 'profile not found');
  const enabled = new Set(await listEnabledExtensions(env.DB, profile.id));
  return json({
    extensions: catalog.map((extension) => ({ ...extension, enabled: enabled.has(extension.id) })),
  });
}

/**
 * `POST /api/extensions/:extensionId` with `{ profileId, enabled }`.
 *
 * Enablement is per profile: the choice is stored in `plugin_storage` and read
 * by the proxy on every request, so toggling takes effect on the next load.
 */
export async function toggleExtension({ request, user, env, url }: RouteContext): Promise<Response> {
  if (!user) return fail(401, 'not authenticated');

  const extensionId = url.pathname.split('/').pop() ?? '';
  if (!isBuiltinExtension(extensionId)) return fail(404, 'extension not found');

  const body = await readJsonObject(request);
  if (!body) return fail(400, 'expected a JSON object');
  const profileId = typeof body.profileId === 'string' ? body.profileId : '';
  if (!profileId) return fail(400, 'profileId is required');
  if (typeof body.enabled !== 'boolean') return fail(400, 'enabled must be a boolean');

  const profile = await findOwnedProfile(env.DB, user.id, profileId);
  if (!profile) return fail(404, 'profile not found');

  const enabled = await setExtensionEnabled(env.DB, profile.id, extensionId, body.enabled);
  return json({ extensionId, enabled: enabled.includes(extensionId), enabledExtensions: enabled });
}
