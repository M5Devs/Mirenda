/**
 * Cookie-manager logic that does not touch the DOM.
 *
 * Split out so the validation, merge and export/import rules can be unit-tested
 * in Node without a browser. The panel itself lives in `panel.ts`.
 */
import type { MirendaCookie } from '@mirenda/sdk';

/** The JSON envelope used by Export / Import. Versioned so it can evolve. */
export interface CookieExport {
  format: 'mirenda-cookies';
  version: 1;
  domain: string;
  exportedAt: string;
  cookies: Array<{
    name: string;
    value: string;
    path: string;
    expires?: number;
    secure: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
}

const MAX_NAME = 256;
const MAX_VALUE = 4096;

/** Why an edited cookie was rejected. Empty array means valid. */
export function validateCookieInput(input: {
  name: string;
  value: string;
  path?: string;
}): string[] {
  const problems: string[] = [];
  const name = input.name.trim();
  if (name === '') problems.push('Name is required.');
  else if (name.length > MAX_NAME) problems.push(`Name must be at most ${MAX_NAME} characters.`);
  // A cookie name is a token: no separators, spaces, or control characters.
  else if (/[\s;=,\u0000-\u001f\u007f]/.test(name)) {
    problems.push('Name cannot contain spaces, semicolons, commas or control characters.');
  }
  if (input.value.length > MAX_VALUE) problems.push(`Value must be at most ${MAX_VALUE} characters.`);
  if (input.path !== undefined && input.path !== '' && !input.path.startsWith('/')) {
    problems.push('Path must start with "/".');
  }
  return problems;
}

/**
 * Build the export envelope.
 *
 * HttpOnly cookies are excluded: the worker never sends them to client code, so
 * they cannot appear here in the first place. Filtering again is belt-and-braces
 * against a caller passing a hand-built list.
 */
export function buildExport(domain: string, cookies: readonly MirendaCookie[], now = new Date()): CookieExport {
  return {
    format: 'mirenda-cookies',
    version: 1,
    domain,
    exportedAt: now.toISOString(),
    cookies: cookies
      .filter((cookie) => !cookie.httpOnly)
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
        secure: cookie.secure,
        ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      })),
  };
}

export type ParseExportResult =
  | { ok: true; export: CookieExport }
  | { ok: false; error: string };

/**
 * Parse a pasted export. Accepts either the full envelope or a bare array of
 * cookies, because people paste the `cookies` array by hand often enough that
 * rejecting it would be hostile.
 */
export function parseExport(raw: string): ParseExportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'That is not valid JSON.' };
  }

  const candidate = Array.isArray(parsed)
    ? { format: 'mirenda-cookies', version: 1, domain: '', exportedAt: '', cookies: parsed }
    : parsed;

  if (typeof candidate !== 'object' || candidate === null) {
    return { ok: false, error: 'Expected a cookie export object or an array of cookies.' };
  }
  const obj = candidate as Record<string, unknown>;
  if (obj.format !== undefined && obj.format !== 'mirenda-cookies') {
    return { ok: false, error: 'This does not look like a Mirenda cookie export.' };
  }
  if (!Array.isArray(obj.cookies)) {
    return { ok: false, error: 'The export has no "cookies" array.' };
  }
  if (obj.cookies.length === 0) {
    return { ok: false, error: 'The export contains no cookies.' };
  }
  if (obj.cookies.length > 200) {
    return { ok: false, error: 'Too many cookies in one import (max 200).' };
  }

  const cookies: CookieExport['cookies'] = [];
  for (const entry of obj.cookies) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const value = typeof e.value === 'string' ? e.value : '';
    if (validateCookieInput({ name, value }).length > 0) continue;
    cookies.push({
      name,
      value,
      path: typeof e.path === 'string' && e.path.startsWith('/') ? e.path : '/',
      ...(typeof e.expires === 'number' && Number.isFinite(e.expires) ? { expires: e.expires } : {}),
      secure: typeof e.secure === 'boolean' ? e.secure : true,
      ...(e.sameSite === 'Strict' || e.sameSite === 'Lax' || e.sameSite === 'None'
        ? { sameSite: e.sameSite }
        : {}),
    });
  }

  if (cookies.length === 0) {
    return { ok: false, error: 'No valid cookies found in that payload.' };
  }

  return {
    ok: true,
    export: {
      format: 'mirenda-cookies',
      version: 1,
      domain: typeof obj.domain === 'string' ? obj.domain : '',
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
      cookies,
    },
  };
}

/** Human-readable expiry, or `Session` for a cookie with no expiry. */
export function describeExpiry(cookie: Pick<MirendaCookie, 'expires'>, now = Date.now()): string {
  if (cookie.expires === undefined) return 'Session';
  const delta = cookie.expires - now;
  if (delta <= 0) return 'Expired';
  const days = Math.floor(delta / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(delta / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return 'under an hour';
}

/** Sort for display: unexpired first, then by name. */
export function sortForDisplay(cookies: readonly MirendaCookie[], now = Date.now()): MirendaCookie[] {
  return [...cookies].sort((a, b) => {
    const aExpired = a.expires !== undefined && a.expires <= now;
    const bExpired = b.expires !== undefined && b.expires <= now;
    if (aExpired !== bExpired) return aExpired ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/** Mask a value for the list; the editor shows the real one. */
export function maskValue(value: string): string {
  if (value === '') return '(empty)';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${'•'.repeat(8)} (${value.length} chars)`;
}
