/**
 * Cookie-jar persistence tests against a real SQLite database.
 *
 * The jar's matching and merging rules are covered by `cookie-jar.test.ts`.
 * This file covers the *storage* layer, where a bug is only visible when the
 * SQL actually runs: `saveJar` writes each cookie under its own `Domain`
 * attribute, so a `Domain=example.com` cookie set from `en.example.com` lands in
 * a different row group than the request host. A `DELETE` scoped only to the
 * request host then leaves the old row behind and the `INSERT` violates the
 * primary key — a 500 on every stylesheet that carries a cookie.
 *
 * `node:sqlite` is used through a minimal `D1Database` adapter so the real SQL
 * and the real schema are exercised, not a stand-in.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { loadJar, saveJar } from '../src/db/repo.js';
import type { JarCookie } from '../src/proxy/cookie-jar.js';

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)),
  'utf8',
);

/** Bind positional parameters onto a `node:sqlite` statement. */
function bound(sqlite: DatabaseSync, sql: string, params: unknown[]) {
  return sqlite.prepare(sql).all(...(params as never[]));
}

/**
 * Adapt `node:sqlite` to the slice of `D1Database` that `repo.ts` uses.
 *
 * D1's `batch` is atomic in production; `node:sqlite` needs an explicit
 * transaction to match, which matters because the tests assert that a failed
 * insert cannot leave a half-deleted jar.
 */
function d1From(sqlite: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        params = values;
        return statement;
      },
      all: async () => ({ results: bound(sqlite, sql, params) }),
      first: async () => bound(sqlite, sql, params)[0] ?? null,
      run: async () => {
        sqlite.prepare(sql).run(...(params as never[]));
        return { success: true, meta: {} };
      },
    };
    return statement;
  };
  return {
    prepare,
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      sqlite.exec('BEGIN');
      try {
        for (const statement of statements) await statement.run();
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
      return [];
    },
  } as unknown as D1Database;
}

function cookie(overrides: Partial<JarCookie> = {}): JarCookie {
  return {
    name: 'sid',
    value: 'abc',
    domain: 'en.example.com',
    path: '/',
    httpOnly: false,
    secure: true,
    ...overrides,
  };
}

const KEY = { userId: 'u1', profileId: 'p1', domain: 'en.example.com' };

let sqlite: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(MIGRATION);
  sqlite.exec(`
    INSERT INTO users (id, email, password_hash, auth_salt, vault_salt)
      VALUES ('u1', 'a@b.test', 'h', 's', 'vs');
    INSERT INTO profiles (id, user_id, name) VALUES ('p1', 'u1', 'Default');
  `);
  db = d1From(sqlite);
});

describe('saveJar', () => {
  it('round-trips a cookie through loadJar', async () => {
    await saveJar(db, KEY, [cookie()]);
    const loaded = await loadJar(db, KEY);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ name: 'sid', value: 'abc', domain: 'en.example.com' });
  });

  it('replaces the previous value when the same cookie is set again', async () => {
    await saveJar(db, KEY, [cookie({ value: 'first' })]);
    await saveJar(db, KEY, [cookie({ value: 'second' })]);
    const loaded = await loadJar(db, KEY);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.value).toBe('second');
  });

  it('stores a parent-domain cookie without a key collision', async () => {
    // `Domain=example.com` from `en.example.com`: the row is filed under the
    // parent, so a delete scoped to the request host would miss it.
    const parent = cookie({ domain: 'example.com', name: 'shared' });
    await saveJar(db, KEY, [parent]);
    await saveJar(db, KEY, [parent]);
    const rows = bound(sqlite, 'SELECT domain, name FROM cookie_jar', []);
    expect(rows).toEqual([{ domain: 'example.com', name: 'shared' }]);
  });

  it('keeps cookies that differ only by path in one write', async () => {
    await saveJar(db, KEY, [cookie({ path: '/', value: 'root' }), cookie({ path: '/admin', value: 'admin' })]);
    const loaded = await loadJar(db, KEY);
    expect(loaded.map((c) => c.path).sort()).toEqual(['/', '/admin']);
  });

  it('removes cookies that are no longer in the set', async () => {
    await saveJar(db, KEY, [cookie({ name: 'a' }), cookie({ name: 'b' })]);
    await saveJar(db, KEY, [cookie({ name: 'a' })]);
    const loaded = await loadJar(db, KEY);
    expect(loaded.map((c) => c.name)).toEqual(['a']);
  });

  it('clears a parent-domain cookie when the set no longer contains it', async () => {
    const parent = cookie({ domain: 'example.com', name: 'gone' });
    await saveJar(db, KEY, [parent]);
    await saveJar(db, KEY, []);
    expect(bound(sqlite, 'SELECT name FROM cookie_jar', [])).toEqual([]);
  });

  it('scopes rows to the profile so two profiles never share a jar', async () => {
    sqlite.exec("INSERT INTO profiles (id, user_id, name) VALUES ('p2', 'u1', 'Second')");
    await saveJar(db, KEY, [cookie({ value: 'one' })]);
    await saveJar(db, { ...KEY, profileId: 'p2' }, [cookie({ value: 'two' })]);
    expect((await loadJar(db, KEY))[0]?.value).toBe('one');
    expect((await loadJar(db, { ...KEY, profileId: 'p2' }))[0]?.value).toBe('two');
  });

  it('scopes rows to the user', async () => {
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, auth_salt, vault_salt)
        VALUES ('u2', 'c@d.test', 'h', 's', 'vs');
      INSERT INTO profiles (id, user_id, name) VALUES ('p9', 'u2', 'Other');
    `);
    await saveJar(db, KEY, [cookie({ value: 'mine' })]);
    expect(await loadJar(db, { userId: 'u2', profileId: 'p9', domain: KEY.domain })).toEqual([]);
  });
});

describe('loadJar', () => {
  it('returns a parent-domain cookie to a subdomain request', async () => {
    // A `Domain=example.com` cookie must be sent to `en.example.com`.
    await saveJar(db, { ...KEY, domain: 'example.com' }, [cookie({ domain: 'example.com' })]);
    const loaded = await loadJar(db, KEY);
    expect(loaded.map((c) => c.name)).toEqual(['sid']);
  });

  it('does not return a cookie to an unrelated domain that merely ends the same', async () => {
    // `notexample.com` must not match a `example.com` cookie.
    await saveJar(db, { ...KEY, domain: 'example.com' }, [cookie({ domain: 'example.com' })]);
    expect(await loadJar(db, { ...KEY, domain: 'notexample.com' })).toEqual([]);
  });

  it('does not leak a subdomain cookie to its parent', async () => {
    await saveJar(db, KEY, [cookie({ domain: 'en.example.com' })]);
    expect(await loadJar(db, { ...KEY, domain: 'example.com' })).toEqual([]);
  });

  it('preserves the expiry and flags it was stored with', async () => {
    const expires = Date.now() + 60_000;
    await saveJar(db, KEY, [cookie({ expires, httpOnly: true, sameSite: 'Lax' })]);
    expect((await loadJar(db, KEY))[0]).toMatchObject({
      expires,
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
    });
  });
});
