/** Small HTTP helpers shared by every route handler. */

export const SESSION_COOKIE = 'mirenda_session';

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function fail(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, { status });
}

/** Read a JSON body, returning `null` for anything that is not a JSON object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A required non-empty string field, trimmed and length-bounded. */
export function requireString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 2048,
): string | null {
  const value = body[field];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > maxLength) return null;
  return trimmed;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 2048,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, maxLength);
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Serialize the session cookie. Always HttpOnly + SameSite=Lax. */
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie('', 0, secure);
}

/** True when the request arrived over https (Workers always do in production). */
export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

/**
 * Base64 validation used for client-sealed vault payloads. Rejects anything
 * that is not standard base64 so a plaintext payload cannot masquerade as one.
 */
export function isBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}
