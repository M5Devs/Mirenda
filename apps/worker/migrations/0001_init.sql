-- Mirenda initial schema.
-- All timestamps are ISO-8601 UTC strings; ids are UUIDv4 text.

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  -- Salt for the server-side password hash (auth).
  auth_salt     TEXT NOT NULL,
  -- Salt for the client-side vault key (PBKDF2). Not secret, but per-user so
  -- two accounts with the same password derive different keys.
  vault_salt    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_users_email ON users (email);

CREATE TABLE profiles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#4f8cff',
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_profiles_user ON profiles (user_id);

CREATE TABLE tabs (
  id         TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  is_active  INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_tabs_profile ON tabs (profile_id, position);

CREATE TABLE bookmarks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_bookmarks_scope ON bookmarks (user_id, profile_id, created_at DESC);
CREATE UNIQUE INDEX idx_bookmarks_unique ON bookmarks (profile_id, url);

CREATE TABLE history (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  visited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_history_scope ON history (user_id, profile_id, visited_at DESC);

-- Encrypted at rest on the client. The worker only ever stores opaque base64.
-- item_type 'credential' payloads are AES-GCM sealed with a PBKDF2-derived key
-- that never leaves the device; item_type 'cookie' rows hold jar snapshots.
CREATE TABLE vault_items (
  id             TEXT PRIMARY KEY,
  profile_id     TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  domain         TEXT NOT NULL,
  item_type      TEXT NOT NULL CHECK (item_type IN ('cookie', 'credential')),
  encrypted_blob TEXT NOT NULL,
  iv             TEXT NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_vault_scope ON vault_items (profile_id, domain, item_type);

-- Virtual Cookie Jar: server-side only, keyed by (user, profile, domain).
-- http_only cookies live here and are never exposed to client JS or plugins.
CREATE TABLE cookie_jar (
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  domain     TEXT NOT NULL,
  name       TEXT NOT NULL,
  value      TEXT NOT NULL,
  path       TEXT NOT NULL DEFAULT '/',
  expires_at INTEGER,
  http_only  INTEGER NOT NULL DEFAULT 0,
  secure     INTEGER NOT NULL DEFAULT 0,
  same_site  TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, profile_id, domain, name, path)
);

CREATE INDEX idx_cookie_jar_lookup ON cookie_jar (user_id, profile_id, domain);

-- Per-plugin, per-profile key/value storage for worker-runtime plugins.
CREATE TABLE plugin_storage (
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  plugin_id  TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (profile_id, plugin_id)
);

-- Server-side sessions. The client holds only an opaque token; the row stores
-- its SHA-256 so a database leak cannot be replayed as a session.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);
