-- Phase 2: per-account proxy rate limiting and per-tab User-Agent overrides.
--
-- The limiter is a fixed-window counter stored in D1. Durable Objects would be
-- the natural home for this, but a DO namespace cannot be provisioned from a
-- migration and would make local `wrangler dev` require a second service; a D1
-- counter is atomic enough (single UPSERT per request) and needs no extra infra.
-- The pure window math lives in `src/lib/rate-limit.ts`.

CREATE TABLE rate_limit_buckets (
  -- `<scope>:<subject>:<window-start-epoch-ms>`, e.g. `proxy:<userId>:1730000000000`.
  bucket_key   TEXT PRIMARY KEY,
  counter      INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_rate_limit_window ON rate_limit_buckets (window_start);

-- Per-tab User-Agent override. NULL means "inherit the profile's user agent".
-- A tab override lets one profile browse a desktop-only site in a single tab
-- without changing every other tab in that container.
ALTER TABLE tabs ADD COLUMN user_agent TEXT;
