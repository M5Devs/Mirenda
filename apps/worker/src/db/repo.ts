/**
 * D1 access layer. Every statement is parameterized; every read of a
 * profile-scoped resource joins back to `profiles` so a caller can never reach
 * another user's data by guessing an id.
 */
import type { SessionUser } from '../types.js';
import type { JarCookie } from '../proxy/cookie-jar.js';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  auth_salt: string;
  vault_salt: string;
  created_at: string;
}

export interface ProfileRow {
  id: string;
  user_id: string;
  name: string;
  color: string;
  user_agent: string | null;
  created_at: string;
}

export interface TabRow {
  user_agent?: string | null;
  id: string;
  profile_id: string;
  url: string;
  title: string;
  is_active: number;
  position: number;
  updated_at: string;
}

export interface BookmarkRow {
  id: string;
  user_id: string;
  profile_id: string;
  url: string;
  title: string;
  created_at: string;
}

export interface HistoryRow {
  id: string;
  user_id: string;
  profile_id: string;
  url: string;
  title: string;
  visited_at: string;
}

export interface VaultRow {
  id: string;
  profile_id: string;
  domain: string;
  item_type: 'cookie' | 'credential';
  encrypted_blob: string;
  iv: string;
  updated_at: string;
}

export interface CookieJarRow {
  user_id: string;
  profile_id: string;
  domain: string;
  name: string;
  value: string;
  path: string;
  expires_at: number | null;
  http_only: number;
  secure: number;
  same_site: string | null;
  updated_at: string;
}

const now = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();

/* ------------------------------------------------------------------ users */

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email.toLowerCase()).first<UserRow>();
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function insertUser(
  db: D1Database,
  input: { email: string; passwordHash: string; authSalt: string; vaultSalt: string },
): Promise<UserRow> {
  const row: UserRow = {
    id: newId(),
    email: input.email.toLowerCase(),
    password_hash: input.passwordHash,
    auth_salt: input.authSalt,
    vault_salt: input.vaultSalt,
    created_at: now(),
  };
  await db
    .prepare(
      'INSERT INTO users (id, email, password_hash, auth_salt, vault_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(row.id, row.email, row.password_hash, row.auth_salt, row.vault_salt, row.created_at)
    .run();
  return row;
}

/** The public vault salt for an authenticated user. Never the password hash. */
export async function getVaultSalt(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare('SELECT vault_salt FROM users WHERE id = ?').bind(userId).first<{ vault_salt: string }>();
  return row?.vault_salt ?? null;
}

/* --------------------------------------------------------------- sessions */

export async function insertSession(
  db: D1Database,
  input: { tokenHash: string; userId: string; expiresAt: string },
): Promise<void> {
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(input.tokenHash, input.userId, now(), input.expiresAt)
    .run();
}

export async function findSessionUser(db: D1Database, tokenHash: string): Promise<SessionUser | null> {
  const row = await db
    .prepare(
      `SELECT u.id AS id, u.email AS email
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(tokenHash, now())
    .first<{ id: string; email: string }>();
  return row ?? null;
}

export async function deleteSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export async function purgeExpiredSessions(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()).run();
}

/* --------------------------------------------------------------- profiles */

export async function listProfiles(db: D1Database, userId: string): Promise<ProfileRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at ASC')
    .bind(userId)
    .all<ProfileRow>();
  return results ?? [];
}

/** Load a profile only if `userId` owns it. The single authorization gate. */
export async function findOwnedProfile(db: D1Database, userId: string, profileId: string): Promise<ProfileRow | null> {
  return db
    .prepare('SELECT * FROM profiles WHERE id = ? AND user_id = ?')
    .bind(profileId, userId)
    .first<ProfileRow>();
}

export async function insertProfile(
  db: D1Database,
  input: { userId: string; name: string; color: string; userAgent: string | null },
): Promise<ProfileRow> {
  const row: ProfileRow = {
    id: newId(),
    user_id: input.userId,
    name: input.name,
    color: input.color,
    user_agent: input.userAgent,
    created_at: now(),
  };
  await db
    .prepare('INSERT INTO profiles (id, user_id, name, color, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.user_id, row.name, row.color, row.user_agent, row.created_at)
    .run();
  return row;
}

export async function updateProfile(
  db: D1Database,
  profileId: string,
  patch: { name?: string; color?: string; userAgent?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.color !== undefined) {
    sets.push('color = ?');
    values.push(patch.color);
  }
  if (patch.userAgent !== undefined) {
    sets.push('user_agent = ?');
    values.push(patch.userAgent);
  }
  if (sets.length === 0) return;
  values.push(profileId);
  await db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function deleteProfile(db: D1Database, profileId: string): Promise<void> {
  await db.prepare('DELETE FROM profiles WHERE id = ?').bind(profileId).run();
}

/* ------------------------------------------------------------------- tabs */

export async function listTabs(db: D1Database, profileId: string): Promise<TabRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM tabs WHERE profile_id = ? ORDER BY position ASC, updated_at ASC')
    .bind(profileId)
    .all<TabRow>();
  return results ?? [];
}

export async function findTab(db: D1Database, profileId: string, tabId: string): Promise<TabRow | null> {
  return db
    .prepare('SELECT * FROM tabs WHERE id = ? AND profile_id = ?')
    .bind(tabId, profileId)
    .first<TabRow>();
}

export async function insertTab(
  db: D1Database,
  input: { profileId: string; url: string; title: string; userAgent?: string | null },
): Promise<TabRow> {
  const existing = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tabs WHERE profile_id = ?')
    .bind(input.profileId)
    .first<{ next: number }>();
  const row: TabRow = {
    id: newId(),
    profile_id: input.profileId,
    url: input.url,
    title: input.title,
    is_active: 0,
    position: existing?.next ?? 0,
    updated_at: now(),
    user_agent: input.userAgent ?? null,
  };
  await db
    .prepare(
      'INSERT INTO tabs (id, profile_id, url, title, is_active, position, updated_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      row.id,
      row.profile_id,
      row.url,
      row.title,
      row.is_active,
      row.position,
      row.updated_at,
      row.user_agent ?? null,
    )
    .run();
  return row;
}

export async function updateTab(
  db: D1Database,
  profileId: string,
  tabId: string,
  patch: { url?: string; title?: string; isActive?: boolean; position?: number; userAgent?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.url !== undefined) {
    sets.push('url = ?');
    values.push(patch.url);
  }
  if (patch.title !== undefined) {
    sets.push('title = ?');
    values.push(patch.title);
  }
  if (patch.isActive !== undefined) {
    sets.push('is_active = ?');
    values.push(patch.isActive ? 1 : 0);
  }
  if (patch.position !== undefined) {
    sets.push('position = ?');
    values.push(patch.position);
  }
  if (patch.userAgent !== undefined) {
    sets.push('user_agent = ?');
    values.push(patch.userAgent);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(now(), tabId, profileId);
  await db
    .prepare(`UPDATE tabs SET ${sets.join(', ')} WHERE id = ? AND profile_id = ?`)
    .bind(...values)
    .run();
}

/** Activate one tab and deactivate its siblings in a single transaction. */
export async function activateTab(db: D1Database, profileId: string, tabId: string): Promise<void> {
  const stamp = now();
  await db.batch([
    db.prepare('UPDATE tabs SET is_active = 0, updated_at = ? WHERE profile_id = ?').bind(stamp, profileId),
    db.prepare('UPDATE tabs SET is_active = 1, updated_at = ? WHERE id = ? AND profile_id = ?').bind(stamp, tabId, profileId),
  ]);
}

export async function deleteTab(db: D1Database, profileId: string, tabId: string): Promise<void> {
  await db.prepare('DELETE FROM tabs WHERE id = ? AND profile_id = ?').bind(tabId, profileId).run();
}

/* -------------------------------------------------------------- bookmarks */

export async function listBookmarks(db: D1Database, userId: string, profileId: string): Promise<BookmarkRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM bookmarks WHERE user_id = ? AND profile_id = ? ORDER BY created_at DESC')
    .bind(userId, profileId)
    .all<BookmarkRow>();
  return results ?? [];
}

export async function upsertBookmark(
  db: D1Database,
  input: { userId: string; profileId: string; url: string; title: string },
): Promise<BookmarkRow> {
  const existing = await db
    .prepare('SELECT * FROM bookmarks WHERE profile_id = ? AND url = ?')
    .bind(input.profileId, input.url)
    .first<BookmarkRow>();
  if (existing) {
    if (existing.title !== input.title) {
      await db.prepare('UPDATE bookmarks SET title = ? WHERE id = ?').bind(input.title, existing.id).run();
    }
    return { ...existing, title: input.title };
  }
  const row: BookmarkRow = {
    id: newId(),
    user_id: input.userId,
    profile_id: input.profileId,
    url: input.url,
    title: input.title,
    created_at: now(),
  };
  await db
    .prepare('INSERT INTO bookmarks (id, user_id, profile_id, url, title, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.user_id, row.profile_id, row.url, row.title, row.created_at)
    .run();
  return row;
}

export async function deleteBookmark(db: D1Database, userId: string, bookmarkId: string): Promise<void> {
  await db.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?').bind(bookmarkId, userId).run();
}

/* ---------------------------------------------------------------- history */

export async function listHistory(
  db: D1Database,
  userId: string,
  profileId: string,
  limit = 200,
): Promise<HistoryRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM history WHERE user_id = ? AND profile_id = ? ORDER BY visited_at DESC LIMIT ?')
    .bind(userId, profileId, limit)
    .all<HistoryRow>();
  return results ?? [];
}

export async function insertHistory(
  db: D1Database,
  input: { userId: string; profileId: string; url: string; title: string },
): Promise<HistoryRow> {
  const row: HistoryRow = {
    id: newId(),
    user_id: input.userId,
    profile_id: input.profileId,
    url: input.url,
    title: input.title,
    visited_at: now(),
  };
  await db
    .prepare('INSERT INTO history (id, user_id, profile_id, url, title, visited_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.user_id, row.profile_id, row.url, row.title, row.visited_at)
    .run();
  return row;
}

export async function clearHistory(db: D1Database, userId: string, profileId: string): Promise<void> {
  await db.prepare('DELETE FROM history WHERE user_id = ? AND profile_id = ?').bind(userId, profileId).run();
}

/* ------------------------------------------------------------------ vault */

export async function listVault(db: D1Database, profileId: string, domain?: string): Promise<VaultRow[]> {
  if (domain) {
    const { results } = await db
      .prepare('SELECT * FROM vault_items WHERE profile_id = ? AND domain = ? ORDER BY updated_at DESC')
      .bind(profileId, domain)
      .all<VaultRow>();
    return results ?? [];
  }
  const { results } = await db
    .prepare('SELECT * FROM vault_items WHERE profile_id = ? ORDER BY updated_at DESC')
    .bind(profileId)
    .all<VaultRow>();
  return results ?? [];
}

export async function upsertVaultItem(
  db: D1Database,
  input: {
    profileId: string;
    domain: string;
    itemType: 'cookie' | 'credential';
    encryptedBlob: string;
    iv: string;
    id?: string;
  },
): Promise<VaultRow> {
  const existing = input.id
    ? await db
        .prepare('SELECT * FROM vault_items WHERE id = ? AND profile_id = ?')
        .bind(input.id, input.profileId)
        .first<VaultRow>()
    : null;

  if (existing) {
    await db
      .prepare('UPDATE vault_items SET domain = ?, item_type = ?, encrypted_blob = ?, iv = ?, updated_at = ? WHERE id = ?')
      .bind(input.domain, input.itemType, input.encryptedBlob, input.iv, now(), existing.id)
      .run();
    return {
      ...existing,
      domain: input.domain,
      item_type: input.itemType,
      encrypted_blob: input.encryptedBlob,
      iv: input.iv,
      updated_at: now(),
    };
  }

  const row: VaultRow = {
    id: newId(),
    profile_id: input.profileId,
    domain: input.domain,
    item_type: input.itemType,
    encrypted_blob: input.encryptedBlob,
    iv: input.iv,
    updated_at: now(),
  };
  await db
    .prepare(
      'INSERT INTO vault_items (id, profile_id, domain, item_type, encrypted_blob, iv, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(row.id, row.profile_id, row.domain, row.item_type, row.encrypted_blob, row.iv, row.updated_at)
    .run();
  return row;
}

export async function deleteVaultItem(db: D1Database, profileId: string, itemId: string): Promise<void> {
  await db.prepare('DELETE FROM vault_items WHERE id = ? AND profile_id = ?').bind(itemId, profileId).run();
}

/* ------------------------------------------------------------- cookie jar */

export async function loadJar(
  db: D1Database,
  key: { userId: string; profileId: string; domain: string },
): Promise<JarCookie[]> {
  const { results } = await db
    .prepare('SELECT * FROM cookie_jar WHERE user_id = ? AND profile_id = ? AND domain = ?')
    .bind(key.userId, key.profileId, key.domain)
    .all<CookieJarRow>();
  return (results ?? []).map(rowToJarCookie);
}

export async function saveJar(
  db: D1Database,
  key: { userId: string; profileId: string; domain: string },
  cookies: readonly JarCookie[],
): Promise<void> {
  const stamp = now();
  const statements: D1PreparedStatement[] = [
    db
      .prepare('DELETE FROM cookie_jar WHERE user_id = ? AND profile_id = ? AND domain = ?')
      .bind(key.userId, key.profileId, key.domain),
  ];
  for (const cookie of cookies) {
    statements.push(
      db
        .prepare(
          `INSERT INTO cookie_jar
             (user_id, profile_id, domain, name, value, path, expires_at, http_only, secure, same_site, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          key.userId,
          key.profileId,
          key.domain,
          cookie.name,
          cookie.value,
          cookie.path,
          cookie.expires ?? null,
          cookie.httpOnly ? 1 : 0,
          cookie.secure ? 1 : 0,
          cookie.sameSite ?? null,
          stamp,
        ),
    );
  }
  await db.batch(statements);
}

export async function clearJar(
  db: D1Database,
  key: { userId: string; profileId: string; domain?: string },
): Promise<void> {
  if (key.domain) {
    await db
      .prepare('DELETE FROM cookie_jar WHERE user_id = ? AND profile_id = ? AND domain = ?')
      .bind(key.userId, key.profileId, key.domain)
      .run();
    return;
  }
  await db
    .prepare('DELETE FROM cookie_jar WHERE user_id = ? AND profile_id = ?')
    .bind(key.userId, key.profileId)
    .run();
}

function rowToJarCookie(row: CookieJarRow): JarCookie {
  const cookie: JarCookie = {
    name: row.name,
    value: row.value,
    domain: row.domain,
    path: row.path,
    httpOnly: row.http_only === 1,
    secure: row.secure === 1,
  };
  if (row.expires_at !== null) cookie.expires = row.expires_at;
  if (row.same_site === 'Strict' || row.same_site === 'Lax' || row.same_site === 'None') {
    cookie.sameSite = row.same_site;
  }
  return cookie;
}

// ---- extension enablement -------------------------------------------------
// Stored in `plugin_storage` as a JSON array under one reserved key per profile,
// so no extra table is needed and a profile's choices travel with it.

const ENABLED_EXTENSIONS_PLUGIN_ID = '__mirenda.enabled_extensions';

export async function listEnabledExtensions(db: D1Database, profileId: string): Promise<string[]> {
  const row = await db
    .prepare('SELECT value FROM plugin_storage WHERE profile_id = ? AND plugin_id = ?')
    .bind(profileId, ENABLED_EXTENSIONS_PLUGIN_ID)
    .first<{ value: string }>();
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // A corrupt row must not break proxying: treat it as "nothing enabled".
    return [];
  }
}

export async function setExtensionEnabled(
  db: D1Database,
  profileId: string,
  extensionId: string,
  enabled: boolean,
): Promise<string[]> {
  const current = new Set(await listEnabledExtensions(db, profileId));
  if (enabled) current.add(extensionId);
  else current.delete(extensionId);

  const next = [...current].sort();
  await db
    .prepare(
      `INSERT INTO plugin_storage (profile_id, plugin_id, value, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (profile_id, plugin_id)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(profileId, ENABLED_EXTENSIONS_PLUGIN_ID, JSON.stringify(next))
    .run();
  return next;
}

// ---- rate limiting ---------------------------------------------------------
// One counter row per (scope, subject, window). The atomic UPSERT returns the
// post-increment value, so concurrent requests cannot both observe "0 used" and
// let a burst through. Old windows are pruned opportunistically.

/**
 * Increment the counter for `bucketKey` and return the value *before* this
 * request. Returning the pre-increment count lets the caller decide with the
 * same number it will report, and keeps the decision logic pure.
 */
export async function incrementRateLimit(db: D1Database, bucketKey: string, windowStart: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, counter, window_start, updated_at)
       VALUES (?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (bucket_key)
       DO UPDATE SET counter = counter + 1, updated_at = excluded.updated_at
       RETURNING counter`,
    )
    .bind(bucketKey, windowStart)
    .first<{ counter: number }>();
  // `counter` is post-increment; the caller wants the pre-increment value.
  return Math.max(0, (row?.counter ?? 1) - 1);
}

/** Drop buckets whose window ended before `beforeMs`. Best-effort housekeeping. */
export async function pruneRateLimitBuckets(db: D1Database, beforeMs: number): Promise<void> {
  await db.prepare('DELETE FROM rate_limit_buckets WHERE window_start < ?').bind(beforeMs).run();
}

