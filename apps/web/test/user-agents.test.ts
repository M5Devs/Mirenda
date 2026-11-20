import { describe, expect, it } from 'vitest';
import {
  CUSTOM_USER_AGENT,
  DEFAULT_USER_AGENT,
  USER_AGENT_PRESETS,
  isValidUserAgent,
  matchPreset,
  resolveUserAgent,
  selectedPresetId,
} from '../src/lib/user-agents.js';

describe('isValidUserAgent', () => {
  it('accepts every bundled preset', () => {
    for (const preset of USER_AGENT_PRESETS) {
      expect(isValidUserAgent(preset.value)).toBe(true);
    }
  });

  it('accepts a plausible custom string', () => {
    expect(isValidUserAgent('Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0')).toBe(true);
  });

  it('rejects blanks, junk and header injection', () => {
    expect(isValidUserAgent('')).toBe(false);
    expect(isValidUserAgent('   ')).toBe(false);
    expect(isValidUserAgent('hello world')).toBe(false);
    expect(isValidUserAgent('Mozilla/5.0\r\nX-Injected: 1')).toBe(false);
    expect(isValidUserAgent('Mozilla/5.0\nX-Injected: 1')).toBe(false);
    expect(isValidUserAgent('Mozilla/5.0\u0000')).toBe(false);
  });

  it('rejects an over-long value', () => {
    expect(isValidUserAgent(`Mozilla/5.0 ${'a'.repeat(600)}`)).toBe(false);
  });
});

describe('resolveUserAgent', () => {
  const preset = USER_AGENT_PRESETS[0]!.value;

  it('prefers the tab override', () => {
    expect(resolveUserAgent({ tabOverride: preset, profileUserAgent: USER_AGENT_PRESETS[1]!.value })).toBe(preset);
  });

  it('falls back to the profile default', () => {
    expect(resolveUserAgent({ tabOverride: null, profileUserAgent: preset })).toBe(preset);
  });

  it('returns null when neither is set, leaving the header alone', () => {
    expect(resolveUserAgent({})).toBeNull();
    expect(resolveUserAgent({ tabOverride: null, profileUserAgent: null })).toBeNull();
  });

  it('skips the "default" sentinel rather than sending it upstream', () => {
    expect(resolveUserAgent({ tabOverride: DEFAULT_USER_AGENT, profileUserAgent: preset })).toBe(preset);
    expect(resolveUserAgent({ tabOverride: DEFAULT_USER_AGENT })).toBeNull();
  });

  it('ignores an invalid stored value instead of forwarding it', () => {
    expect(resolveUserAgent({ tabOverride: 'not a ua', profileUserAgent: preset })).toBe(preset);
    expect(resolveUserAgent({ tabOverride: 'not a ua' })).toBeNull();
  });

  it('treats whitespace as unset', () => {
    expect(resolveUserAgent({ tabOverride: '   ', profileUserAgent: preset })).toBe(preset);
  });

  it('trims a valid value', () => {
    expect(resolveUserAgent({ tabOverride: `  ${preset}  ` })).toBe(preset);
  });
});

describe('matchPreset and selectedPresetId', () => {
  it('identifies a known preset', () => {
    const preset = USER_AGENT_PRESETS[1]!;
    expect(matchPreset(preset.value)?.id).toBe(preset.id);
    expect(selectedPresetId(preset.value)).toBe(preset.id);
  });

  it('reports custom for an unrecognised value', () => {
    expect(matchPreset('Mozilla/5.0 (custom) X/1')).toBeNull();
    expect(selectedPresetId('Mozilla/5.0 (custom) X/1')).toBe(CUSTOM_USER_AGENT);
  });

  it('reports default for an empty value', () => {
    expect(selectedPresetId(null)).toBe(DEFAULT_USER_AGENT);
    expect(selectedPresetId(undefined)).toBe(DEFAULT_USER_AGENT);
    expect(selectedPresetId('')).toBe(DEFAULT_USER_AGENT);
    expect(selectedPresetId('   ')).toBe(DEFAULT_USER_AGENT);
  });
});
