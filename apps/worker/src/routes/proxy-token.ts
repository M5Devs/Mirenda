/**
 * `POST /api/proxy-token` — mint a scoped proxy token for the sandbox origin.
 *
 * The app origin calls this with its session cookie; the returned token is then
 * embedded in the iframe `src` so the separately deployed sandbox can authorise
 * `/proxy` without ever seeing the session cookie. In a single-origin
 * deployment the shell calls the same endpoint, so dev and production share one
 * code path.
 */
import { mintProxyToken, PROXY_TOKEN_TTL_SECONDS } from '../auth/proxy-token.js';
import { findOwnedProfile } from '../db/repo.js';
import { fail, json, readJsonObject } from '../lib/http.js';
import { decideRateLimit, rateLimitedResponse, rateLimitHeaders } from '../lib/rate-limit.js';
import { incrementRateLimit } from '../db/repo.js';
import type { RouteContext } from '../types.js';

export async function createProxyToken({ request, user, env }: RouteContext): Promise<Response> {
  if (!user) return fail(401, 'not authenticated');

  const secret = env.PROXY_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    // Misconfiguration, not a client error: never mint with a weak/absent key.
    console.error('proxy token secret is missing or too short');
    return fail(503, 'proxy tokens are not configured');
  }

  // Minting is cheap but still per-account limited so a token cannot be farmed.
  const now = Date.now();
  const decision = decideRateLimit('proxyToken', user.id, 0, now);
  const used = await incrementRateLimit(env.DB, decision.bucketKey, decision.windowStart);
  const effective = decideRateLimit('proxyToken', user.id, used, now);
  if (!effective.allowed) return rateLimitedResponse(effective);

  const body = await readJsonObject(request);
  if (!body) return fail(400, 'expected a JSON object');
  const profileId = typeof body.profileId === 'string' ? body.profileId : '';
  if (!profileId) return fail(400, 'profileId is required');

  const profile = await findOwnedProfile(env.DB, user.id, profileId);
  if (!profile) return fail(404, 'profile not found');

  const token = await mintProxyToken(secret, user.id, profile.id);
  const headers = new Headers(rateLimitHeaders(effective));
  return json(
    {
      token,
      expiresIn: PROXY_TOKEN_TTL_SECONDS,
      /** Where the shell should send proxied requests, so it never guesses. */
      sandboxOrigin: env.SANDBOX_ORIGIN ?? null,
    },
    { headers },
  );
}
