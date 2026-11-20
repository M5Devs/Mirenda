import { describe, expect, it } from 'vitest';
import type { MirendaCookie } from '@mirenda/sdk';
import {
  buildExport,
  describeExpiry,
  maskValue,
  parseExport,
  sortForDisplay,
  validateCookieInput,
} from '../src/logic.js';

function cookie(overrides: Partial<MirendaCookie> = {}): MirendaCookie {
  return {
    name: 'sid',
    value: 'abc123',
    domain: 'example.com',
    path: '/',
    httpOnly: false,
    secure: true,
    ...overrides,
  };
}

describe('validateCookieInput', () => {
  it('accepts a normal cookie', () => {
    expect(validateCookieInput({ name: 'sid', value: 'abc', path: '/' })).toEqual([]);
  });

  it('requires a name', () => {
    expect(validateCookieInput({ name: '', value: 'v' })).toContain('Name is required.');
    expect(validateCookieInput({ name: '   ', value: 'v' })).toContain('Name is required.');
  });

  it('rejects separators and control characters in the name', () => {
    for (const name of ['a b', 'a;b', 'a=b', 'a,b', 'a\nb', 'a\u0000b']) {
      expect(validateCookieInput({ name, value: 'v' }).length).toBeGreaterThan(0);
    }
  });

  it('rejects an over-long name or value', () => {
    expect(validateCookieInput({ name: 'a'.repeat(300), value: 'v' }).length).toBeGreaterThan(0);
    expect(validateCookieInput({ name: 'ok', value: 'a'.repeat(5000) }).length).toBeGreaterThan(0);
  });

  it('requires a path to start with a slash', () => {
    expect(validateCookieInput({ name: 'ok', value: 'v', path: 'foo' }).length).toBeGreaterThan(0);
    expect(validateCookieInput({ name: 'ok', value: 'v', path: '/foo' })).toEqual([]);
    expect(validateCookieInput({ name: 'ok', value: 'v', path: '' })).toEqual([]);
  });
});

describe('buildExport', () => {
  it('wraps cookies in a versioned envelope', () => {
    const result = buildExport('example.com', [cookie()], new Date('2024-01-01T00:00:00Z'));
    expect(result.format).toBe('mirenda-cookies');
    expect(result.version).toBe(1);
    expect(result.domain).toBe('example.com');
    expect(result.exportedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(result.cookies).toHaveLength(1);
  });

  it('never exports HttpOnly cookies', () => {
    const result = buildExport('example.com', [
      cookie({ name: 'visible' }),
      cookie({ name: 'secret', httpOnly: true }),
    ]);
    expect(result.cookies.map((c) => c.name)).toEqual(['visible']);
  });

  it('drops undefined optional fields instead of writing null', () => {
    const result = buildExport('example.com', [cookie({ expires: undefined, sameSite: undefined })]);
    const exported = result.cookies[0]!;
    expect('expires' in exported).toBe(false);
    expect('sameSite' in exported).toBe(false);
  });
});

describe('parseExport', () => {
  it('parses a full envelope', () => {
    const payload = JSON.stringify(buildExport('example.com', [cookie()]));
    const result = parseExport(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.export.cookies[0]!.name).toBe('sid');
  });

  it('accepts a bare array of cookies', () => {
    const result = parseExport(JSON.stringify([{ name: 'a', value: '1' }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.export.cookies).toHaveLength(1);
  });

  it('rejects invalid JSON', () => {
    const result = parseExport('{not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/valid JSON/);
  });

  it('rejects a foreign format', () => {
    const result = parseExport(JSON.stringify({ format: 'someone-else', cookies: [] }));
    expect(result.ok).toBe(false);
  });

  it('rejects a payload with no cookies array or an empty one', () => {
    expect(parseExport(JSON.stringify({ format: 'mirenda-cookies' })).ok).toBe(false);
    expect(parseExport(JSON.stringify({ cookies: [] })).ok).toBe(false);
  });

  it('caps the number of imported cookies', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ name: `c${i}`, value: 'v' }));
    const result = parseExport(JSON.stringify({ cookies: many }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Too many/);
  });

  it('skips invalid entries but keeps the valid ones', () => {
    const result = parseExport(
      JSON.stringify([{ name: 'good', value: 'v' }, { name: 'bad name', value: 'v' }, { nope: true }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.export.cookies.map((c) => c.name)).toEqual(['good']);
  });

  it('defaults the path and secure flag conservatively', () => {
    const result = parseExport(JSON.stringify([{ name: 'a', value: '1', path: 'bad' }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.export.cookies[0]!.path).toBe('/');
    expect(result.export.cookies[0]!.secure).toBe(true);
  });

  it('rejects when every entry is invalid', () => {
    const result = parseExport(JSON.stringify([{ name: '', value: 'v' }]));
    expect(result.ok).toBe(false);
  });
});

describe('describeExpiry', () => {
  const now = 1_700_000_000_000;

  it('labels a cookie with no expiry as Session', () => {
    expect(describeExpiry({ expires: undefined }, now)).toBe('Session');
  });

  it('labels a past expiry as Expired', () => {
    expect(describeExpiry({ expires: now - 1000 }, now)).toBe('Expired');
  });

  it('counts days and hours with correct pluralisation', () => {
    expect(describeExpiry({ expires: now + 86_400_000 }, now)).toBe('1 day');
    expect(describeExpiry({ expires: now + 3 * 86_400_000 }, now)).toBe('3 days');
    expect(describeExpiry({ expires: now + 3_600_000 }, now)).toBe('1 hour');
    expect(describeExpiry({ expires: now + 5_400_000 }, now)).toBe('1 hour');
  });

  it('reports sub-hour as under an hour', () => {
    expect(describeExpiry({ expires: now + 60_000 }, now)).toBe('under an hour');
  });
});

describe('sortForDisplay', () => {
  it('puts unexpired cookies first, then sorts by name', () => {
    const now = 1_700_000_000_000;
    const sorted = sortForDisplay(
      [
        cookie({ name: 'zebra', expires: now + 1000 }),
        cookie({ name: 'old', expires: now - 1000 }),
        cookie({ name: 'alpha', expires: now + 2000 }),
      ],
      now,
    );
    expect(sorted.map((c) => c.name)).toEqual(['alpha', 'zebra', 'old']);
  });

  it('does not mutate the input', () => {
    const input = [cookie({ name: 'b' }), cookie({ name: 'a' })];
    const copy = [...input];
    sortForDisplay(input);
    expect(input).toEqual(copy);
  });
});

describe('maskValue', () => {
  it('masks values without revealing length for short secrets', () => {
    expect(maskValue('')).toBe('(empty)');
    expect(maskValue('ab')).toBe('••');
    expect(maskValue('abcdefgh')).toBe('••••••••');
  });

  it('reports length for longer values', () => {
    expect(maskValue('a'.repeat(40))).toBe('•••••••• (40 chars)');
  });
});
