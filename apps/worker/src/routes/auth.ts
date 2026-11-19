import {
  createSessionToken,
  hashPassword,
  isValidEmail,
  PASSWORD_MIN_LENGTH,
  randomBase64,
  SESSION_TTL_MS,
  sha256Base64,
  verifyPassword,
} from '../auth/crypto.js';
import {
  deleteSession,
  findUserByEmail,
  getVaultSalt,
  insertSession,
  insertUser,
} from '../db/repo.js';
import {
  clearSessionCookie,
  fail,
  isBase64,
  isSecureRequest,
  json,
  optionalString,
  readCookie,
  readJsonObject,
  requireString,
  SESSION_COOKIE,
  sessionCookie,
} from '../lib/http.js';
import type { RouteContext } from '../types.js';

const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

/** `POST /api/auth/register` */
export async function register({ request, env }: RouteContext): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return fail(400, 'expected a JSON object body');

  const email = requireString(body, 'email', 254);
  const password = requireString(body, 'password', 512);
  if (!email || !isValidEmail(email)) return fail(400, 'a valid email is required');
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return fail(400, `password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }

  // The client derives the vault key from this salt. It is generated here so a
  // second device can fetch it; it is not secret and never derived from the
  // password hash.
  const generatedVaultSalt = randomBase64(16);
  const providedVaultSalt = optionalString(body, 'vaultSalt', 128);
  if (providedVaultSalt !== undefined && !isBase64(providedVaultSalt)) {
    return fail(400, 'vaultSalt must be base64');
  }

  if (await findUserByEmail(env.DB, email)) return fail(409, 'an account with that email already exists');

  const { hash, salt } = await hashPassword(password);
  const user = await insertUser(env.DB, {
    email,
    passwordHash: hash,
    authSalt: salt,
    vaultSalt: providedVaultSalt ?? generatedVaultSalt,
  });

  const { token, tokenHash } = await createSessionToken();
  await insertSession(env.DB, {
    tokenHash,
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });

  return json(
    { user: { id: user.id, email: user.email }, vaultSalt: user.vault_salt },
    {
      status: 201,
      headers: { 'set-cookie': sessionCookie(token, SESSION_TTL_SECONDS, isSecureRequest(request)) },
    },
  );
}

/** `POST /api/auth/login` */
export async function login({ request, env }: RouteContext): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return fail(400, 'expected a JSON object body');

  const email = requireString(body, 'email', 254);
  const password = requireString(body, 'password', 512);
  if (!email || !password) return fail(400, 'email and password are required');

  const user = await findUserByEmail(env.DB, email);
  // One message for both unknown-email and wrong-password: no account enumeration.
  if (!user || !(await verifyPassword(password, user.password_hash, user.auth_salt))) {
    return fail(401, 'invalid email or password');
  }

  const { token, tokenHash } = await createSessionToken();
  await insertSession(env.DB, {
    tokenHash,
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });

  return json(
    { user: { id: user.id, email: user.email }, vaultSalt: user.vault_salt },
    { headers: { 'set-cookie': sessionCookie(token, SESSION_TTL_SECONDS, isSecureRequest(request)) } },
  );
}

/** `POST /api/auth/logout` */
export async function logout({ request, env }: RouteContext): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    await deleteSession(env.DB, await sha256Base64(token));
  }
  return json(
    { ok: true },
    { headers: { 'set-cookie': clearSessionCookie(isSecureRequest(request)) } },
  );
}

/** `GET /api/auth/me` */
export function me({ user }: RouteContext): Response {
  if (!user) return fail(401, 'not authenticated');
  return json({ user });
}

/**
 * `GET /api/vault/salt` — the caller's own vault salt, so a new device can
 * derive the same AES key. The salt is not secret; the password never leaves
 * the client.
 */
export async function vaultSalt({ user, env }: RouteContext): Promise<Response> {
  if (!user) return fail(401, 'not authenticated');
  const salt = await getVaultSalt(env.DB, user.id);
  if (!salt) return fail(404, 'no vault salt for this account');
  return json({ vaultSalt: salt });
}
