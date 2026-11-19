/**
 * Profile / tab / bookmark / history / vault sync endpoints.
 *
 * Every handler resolves the profile through `findOwnedProfile`, so the only
 * way to touch profile-scoped rows is to own the profile. Handlers assume the
 * router already authenticated the request (`auth: true`).
 */
import {
  activateTab,
  clearHistory,
  deleteBookmark,
  deleteProfile,
  deleteTab,
  deleteVaultItem,
  findOwnedProfile,
  findTab,
  insertHistory,
  insertProfile,
  insertTab,
  listBookmarks,
  listHistory,
  listProfiles,
  listTabs,
  listVault,
  updateProfile,
  updateTab,
  upsertBookmark,
  upsertVaultItem,
  type BookmarkRow,
  type HistoryRow,
  type ProfileRow,
  type TabRow,
  type VaultRow,
} from '../db/repo.js';
import { fail, isBase64, json, optionalString, readJsonObject, requireString } from '../lib/http.js';
import type { RouteContext, SessionUser } from '../types.js';

const DEFAULT_PROFILE_COLOR = '#4f8cff';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function profileDto(row: ProfileRow) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    color: row.color,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  };
}

function tabDto(row: TabRow) {
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

function bookmarkDto(row: BookmarkRow) {
  return { id: row.id, profileId: row.profile_id, url: row.url, title: row.title, createdAt: row.created_at };
}

function historyDto(row: HistoryRow) {
  return { id: row.id, profileId: row.profile_id, url: row.url, title: row.title, visitedAt: row.visited_at };
}

function vaultDto(row: VaultRow) {
  return {
    id: row.id,
    profileId: row.profile_id,
    domain: row.domain,
    itemType: row.item_type,
    encryptedBlob: row.encrypted_blob,
    iv: row.iv,
    updatedAt: row.updated_at,
  };
}

function requireUser(ctx: RouteContext): SessionUser | Response {
  return ctx.user ?? fail(401, 'not authenticated');
}

/** Resolve a profile the caller owns, or a 404 response. */
async function ownedProfile(ctx: RouteContext, profileId: string): Promise<ProfileRow | Response> {
  const user = requireUser(ctx);
  if (user instanceof Response) return user;
  const profile = await findOwnedProfile(ctx.env.DB, user.id, profileId);
  return profile ?? fail(404, 'profile not found');
}

/* --------------------------------------------------------------- profiles */

export async function getProfiles(ctx: RouteContext): Promise<Response> {
  const user = requireUser(ctx);
  if (user instanceof Response) return user;
  const rows = await listProfiles(ctx.env.DB, user.id);
  return json({ profiles: rows.map(profileDto) });
}

export async function createProfile(ctx: RouteContext): Promise<Response> {
  const user = requireUser(ctx);
  if (user instanceof Response) return user;
  const body = await readJsonObject(ctx.request);
  if (!body) return fail(400, 'expected a JSON object body');

  const name = requireString(body, 'name', 64);
  if (!name) return fail(400, 'profile name is required');
  const color = optionalString(body, 'color', 7);
  if (color !== undefined && !HEX_COLOR.test(color)) return fail(400, 'color must be a #rrggbb hex value');
  const userAgent = optionalString(body, 'userAgent', 512) ?? null;

  const row = await insertProfile(ctx.env.DB, { userId: user.id, name, color: color ?? DEFAULT_PROFILE_COLOR, userAgent });
  return json({ profile: profileDto(row) }, { status: 201 });
}

export async function patchProfile(ctx: RouteContext): Promise<Response> {
  const profileId = ctx.params.profileId ?? '';
  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;

  const body = await readJsonObject(ctx.request);
  if (!body) return fail(400, 'expected a JSON object body');

  const name = optionalString(body, 'name', 64);
  const color = optionalString(body, 'color', 7);
  if (color !== undefined && !HEX_COLOR.test(color)) return fail(400, 'color must be a #rrggbb hex value');
  const userAgent = body.userAgent === null ? null : optionalString(body, 'userAgent', 512);

  await updateProfile(ctx.env.DB, profileId, { name, color, userAgent });
  const refreshed = await findOwnedProfile(ctx.env.DB, profile.user_id, profileId);
  return json({ profile: refreshed ? profileDto(refreshed) : profileDto(profile) });
}

export async function removeProfile(ctx: RouteContext): Promise<Response> {
  const profileId = ctx.params.profileId ?? '';
  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;
  await deleteProfile(ctx.env.DB, profileId);
  return json({ ok: true });
}

/* ------------------------------------------------------------------- tabs */

export async function getTabs(ctx: RouteContext): Promise<Response> {
  const profileId = ctx.url.searchParams.get('profileId') ?? '';
  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;
  const rows = await listTabs(ctx.env.DB, profileId);
  return json({ tabs: rows.map(tabDto) });
}

export async function createTab(ctx: RouteContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (!body) return fail(400, 'expected a JSON object body');

  const profileId = requireString(body, 'profileId', 64);
  const url = requireString(body, 'url', 8192);
  if (!profileId || !url) return fail(400, 'profileId and url are required');
  if (!isHttpUrl(url)) return fail(400, 'url must be an absolute http(s) URL');

  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;

  const row = await insertTab(ctx.env.DB, { profileId, url, title: optionalString(body, 'title', 512) ?? '' });
  return json({ tab: tabDto(row) }, { status: 201 });
}

export async function patchTab(ctx: RouteContext): Promise<Response> {
  const profileId = ctx.url.searchParams.get('profileId') ?? '';
  const tabId = ctx.params.tabId ?? '';
  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;

  const existing = await findTab(ctx.env.DB, profileId, tabId);
  if (!existing) return fail(404, 'tab not found');

  const body = await readJsonObject(ctx.request);
  if (!body) return fail(400, 'expected a JSON object body');

  const url = optionalString(body, 'url', 8192);
  if (url !== undefined && !isHttpUrl(url)) return fail(400, 'url must be an absolute http(s) URL');
  const title = optionalString(body, 'title', 512);
  const isActive = typeof body.isActive === 'boolean' ? body.isActive : undefined;
  const position = typeof body.position === 'number' && Number.isInteger(body.position) ? body.position : undefined;

  await updateTab(ctx.env.DB, profileId, tabId, { url, title, isActive, position });
  const refreshed = await findTab(ctx.env.DB, profileId, tabId);
  return json({ tab: refreshed ? tabDto(refreshed) : tabDto(existing) });
}

export async function activateTabRoute(ctx: RouteContext): Promise<Response> {
  const profileId = ctx.url.searchParams.get('profileId') ?? '';
  const tabId = ctx.params.tabId ?? '';
  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;
  if (!(await findTab(ctx.env.DB, profileId, tabId))) return fail(404, 'tab not found');
  await activateTab(ctx.env.DB, profileId, tabId);
  const rows = await listTabs(ctx.env.DB, profileId);
  return json({ tabs: rows.map(tabDto) });
}

export async function removeTab(ctx: RouteContext): Promise<Response> {
  const profileId = ctx.url.searchParams.get('profileId') ?? '';
  const tabId = ctx.params.tabId ?? '';
  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;
  await deleteTab(ctx.env.DB, profileId, tabId);
  return json({ ok: true });
}

/* -------------------------------------------------------------- bookmarks */

export async function getBookmarks(ctx: RouteContext): Promise<Response> {
  const user = requireUser(ctx);
  if (user instanceof Response) return user;
  const profileId = ctx.url.searchParams.get('profileId') ?? '';
  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;
  const rows = await listBookmarks(ctx.env.DB, user.id, profileId);
  return json({ bookmarks: rows.map(bookmarkDto) });
}

export async function createBookmark(ctx: RouteContext): Promise<Response> {
  const user = requireUser(ctx);
  if (user instanceof Response) return user;
  const body = await readJsonObject(ctx.request);
  if (!body) return fail(400, 'expected a JSON object body');

  const profileId = requireString(body, 'profileId', 64);
  const url = requireString(body, 'url', 8192);
  if (!profileId || !url) return fail(400, 'profileId and url are required');
  if (!isHttpUrl(url)) return fail(400, 'url must be an absolute http(s) URL');

  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;

  const row = await upsertBookmark(ctx.env.DB, {
    userId: user.id,
    profileId,
    url,
    title: optionalString(body, 'title', 512) ?? '',
  });
  return json({ bookmark: bookmarkDto(row) }, { status: 201 });
}

export async function removeBookmark(ctx: RouteContext): Promise<Response> {
  const user = requireUser(ctx);
  if (user instanceof Response) return user;
  await deleteBookmark(ctx.env.DB, user.id, ctx.params.bookmarkId ?? '');
  return json({ ok: true });
}

/* ---------------------------------------------------------------- history */

export async function getHistory(ctx: RouteContext): Promise<Response> {
  const user = requireUser(ctx);
  if (user instanceof Response) return user;
  const profileId = ctx.url.searchParams.get('profileId') ?? '';
  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;
  const limitParam = Number.parseInt(ctx.url.searchParams.get('limit') ?? '200', 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 200;
  const rows = await listHistory(ctx.env.DB, user.id, profileId, limit);
  return json({ history: rows.map(historyDto) });
}

export async function createHistoryEntry(ctx: RouteContext): Promise<Response> {
  const user = requireUser(ctx);
  if (user instanceof Response) return user;
  const body = await readJsonObject(ctx.request);
  if (!body) return fail(400, 'expected a JSON object body');

  const profileId = requireString(body, 'profileId', 64);
  const url = requireString(body, 'url', 8192);
  if (!profileId || !url) return fail(400, 'profileId and url are required');
  if (!isHttpUrl(url)) return fail(400, 'url must be an absolute http(s) URL');

  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;

  const row = await insertHistory(ctx.env.DB, {
    userId: user.id,
    profileId,
    url,
    title: optionalString(body, 'title', 512) ?? '',
  });
  return json({ entry: historyDto(row) }, { status: 201 });
}

export async function clearHistoryRoute(ctx: RouteContext): Promise<Response> {
  const user = requireUser(ctx);
  if (user instanceof Response) return user;
  const profileId = ctx.url.searchParams.get('profileId') ?? '';
  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;
  await clearHistory(ctx.env.DB, user.id, profileId);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ vault */

export async function getVault(ctx: RouteContext): Promise<Response> {
  const profileId = ctx.url.searchParams.get('profileId') ?? '';
  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;
  const domain = ctx.url.searchParams.get('domain') ?? undefined;
  const rows = await listVault(ctx.env.DB, profileId, domain);
  return json({ items: rows.map(vaultDto) });
}

export async function putVaultItem(ctx: RouteContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (!body) return fail(400, 'expected a JSON object body');

  const profileId = requireString(body, 'profileId', 64);
  const domain = requireString(body, 'domain', 253);
  const itemType = requireString(body, 'itemType', 16);
  const encryptedBlob = body.encryptedBlob;
  const iv = body.iv;

  if (!profileId || !domain) return fail(400, 'profileId and domain are required');
  if (itemType !== 'cookie' && itemType !== 'credential') {
    return fail(400, 'itemType must be "cookie" or "credential"');
  }
  // Only client-sealed payloads are accepted. A plaintext body fails here.
  if (!isBase64(encryptedBlob)) return fail(400, 'encryptedBlob must be base64 ciphertext');
  if (!isBase64(iv) || atob(iv).length !== 12) return fail(400, 'iv must be base64 encoding of 12 bytes');

  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;

  const id = optionalString(body, 'id', 64);
  const row = await upsertVaultItem(ctx.env.DB, {
    profileId,
    domain: domain.toLowerCase(),
    itemType,
    encryptedBlob,
    iv,
    ...(id ? { id } : {}),
  });
  return json({ item: vaultDto(row) }, { status: 201 });
}

export async function removeVaultItem(ctx: RouteContext): Promise<Response> {
  const profileId = ctx.url.searchParams.get('profileId') ?? '';
  const profile = await ownedProfile(ctx, profileId);
  if (profile instanceof Response) return profile;
  await deleteVaultItem(ctx.env.DB, profileId, ctx.params.itemId ?? '');
  return json({ ok: true });
}

/** The blank-tab sentinel. It is not a navigable URL, only a placeholder. */
export const NEW_TAB_URL = 'about:newtab';

/** A tab URL must be a real http(s) URL or the blank-tab sentinel. */
function isHttpUrl(value: string): boolean {
  if (value === NEW_TAB_URL) return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}
