/**
 * User-Agent presets for the per-profile / per-tab spoofer.
 *
 * Kept as data plus pure helpers so the mapping is testable and the UI stays
 * dumb. Values are current as of the Phase 2 work; a stale UA is not a security
 * problem, only a compatibility one, so they live here rather than in config.
 */

export interface UserAgentPreset {
  readonly id: 'mobile-android' | 'iphone-safari' | 'desktop-chrome';
  readonly label: string;
  readonly hint: string;
  readonly value: string;
}

export const USER_AGENT_PRESETS: readonly UserAgentPreset[] = [
  {
    id: 'mobile-android',
    label: 'Mobile Android',
    hint: 'Chrome on a Pixel — the default for mobile-first sites.',
    value:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  },
  {
    id: 'iphone-safari',
    label: 'iPhone Safari',
    hint: 'Safari on iOS — sites that gate features on iOS.',
    value:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  },
  {
    id: 'desktop-chrome',
    label: 'Desktop Chrome',
    hint: 'Desktop layout — for sites that hide features on mobile.',
    value:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
];

/** The sentinel the UI stores for "no override; use the proxy default". */
export const DEFAULT_USER_AGENT = 'default';
/** The sentinel for a user-typed custom value. */
export const CUSTOM_USER_AGENT = 'custom';

const MAX_USER_AGENT_LENGTH = 512;

/** Does this string look like a plausible User-Agent rather than junk? */
export function isValidUserAgent(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_USER_AGENT_LENGTH) return false;
  // A UA is a sequence of `product/version` tokens with comments. Requiring a
  // leading `Mozilla/`-style token and no control characters rejects pasted
  // text and header-injection attempts (`\r`, `\n`).
  if (/[\r\n\u0000-\u001f]/.test(trimmed)) return false;
  return /^[A-Za-z][A-Za-z0-9._-]*\/[^\s]/.test(trimmed);
}

/**
 * Resolve what the proxy should send.
 *
 * Precedence is tab override → profile default → `null` (the worker leaves the
 * header alone). An invalid stored value is ignored rather than forwarded.
 */
export function resolveUserAgent(input: {
  tabOverride?: string | null;
  profileUserAgent?: string | null;
}): string | null {
  const candidates = [input.tabOverride, input.profileUserAgent];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed === '' || trimmed === DEFAULT_USER_AGENT) continue;
    if (!isValidUserAgent(trimmed)) continue;
    return trimmed;
  }
  return null;
}

/** The preset matching a stored value, if it is one. */
export function matchPreset(value: string | null | undefined): UserAgentPreset | null {
  if (typeof value !== 'string') return null;
  return USER_AGENT_PRESETS.find((preset) => preset.value === value) ?? null;
}

/** Which chip should be highlighted for a stored value. */
export function selectedPresetId(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_USER_AGENT;
  return matchPreset(value)?.id ?? CUSTOM_USER_AGENT;
}
