import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SNIPPETS,
  MAX_RULES,
  applicableRules,
  autoRunRules,
  createRule,
  generateRuleId,
  parseRules,
  removeRule,
  ruleAppliesTo,
  upsertRule,
  validateRule,
  type StudioRule,
} from '../src/rules.js';

function rule(overrides: Partial<StudioRule> = {}): StudioRule {
  return {
    id: 'r1',
    name: 'Test',
    kind: 'js',
    code: 'console.log(1)',
    scope: 'domain',
    domain: 'example.com',
    autoRun: false,
    enabled: true,
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('BUILTIN_SNIPPETS', () => {
  it('ships exactly three utilities', () => {
    expect(BUILTIN_SNIPPETS).toHaveLength(3);
  });

  it('covers copy, passwords and overlays', () => {
    const ids = BUILTIN_SNIPPETS.map((s) => s.id);
    expect(ids).toEqual(['restore-copy', 'reveal-passwords', 'remove-overlays']);
  });

  it('has non-empty code and a description for each', () => {
    for (const snippet of BUILTIN_SNIPPETS) {
      expect(snippet.code.trim().length).toBeGreaterThan(0);
      expect(snippet.description.length).toBeGreaterThan(0);
      expect(['js', 'css']).toContain(snippet.kind);
    }
  });

  it('includes one CSS snippet, for the stylesheet path', () => {
    expect(BUILTIN_SNIPPETS.some((s) => s.kind === 'css')).toBe(true);
  });
});

describe('createRule', () => {
  it('normalises a domain rule', () => {
    const created = createRule({
      id: 'x',
      name: '  Spaced  ',
      kind: 'css',
      code: 'body{}',
      scope: 'domain',
      domain: 'Example.COM',
    });
    expect(created.name).toBe('Spaced');
    expect(created.domain).toBe('example.com');
    expect(created.autoRun).toBe(false);
    expect(created.enabled).toBe(true);
  });

  it('clears the domain for a global rule', () => {
    const created = createRule({
      id: 'x',
      name: 'G',
      kind: 'js',
      code: '1',
      scope: 'global',
      domain: 'example.com',
    });
    expect(created.domain).toBe('');
  });
});

describe('validateRule', () => {
  it('accepts a well-formed rule', () => {
    expect(validateRule(rule())).toEqual([]);
  });

  it('requires a name and code', () => {
    expect(validateRule(rule({ name: '  ' }))).toContain('Give the snippet a name.');
    expect(validateRule(rule({ code: '  ' }))).toContain('The snippet is empty.');
  });

  it('requires a domain for a domain-scoped rule', () => {
    expect(validateRule(rule({ scope: 'domain', domain: '' })).length).toBeGreaterThan(0);
    expect(validateRule(rule({ scope: 'global', domain: '' }))).toEqual([]);
  });

  it('rejects an over-long name', () => {
    expect(validateRule(rule({ name: 'a'.repeat(200) })).length).toBeGreaterThan(0);
  });
});

describe('ruleAppliesTo', () => {
  it('matches an exact host and its subdomains', () => {
    expect(ruleAppliesTo(rule({ domain: 'example.com' }), 'https://example.com/a')).toBe(true);
    expect(ruleAppliesTo(rule({ domain: 'example.com' }), 'https://www.example.com/a')).toBe(true);
    expect(ruleAppliesTo(rule({ domain: 'example.com' }), 'https://deep.www.example.com/a')).toBe(true);
  });

  it('does not match a lookalike suffix', () => {
    expect(ruleAppliesTo(rule({ domain: 'example.com' }), 'https://notexample.com/a')).toBe(false);
    expect(ruleAppliesTo(rule({ domain: 'example.com' }), 'https://example.com.evil.net/a')).toBe(false);
  });

  it('matches every URL for a global rule', () => {
    expect(ruleAppliesTo(rule({ scope: 'global', domain: '' }), 'https://anything.test/x')).toBe(true);
  });

  it('ignores a disabled rule', () => {
    expect(ruleAppliesTo(rule({ enabled: false }), 'https://example.com/')).toBe(false);
  });

  it('treats a leading dot as optional', () => {
    expect(ruleAppliesTo(rule({ domain: '.example.com' }), 'https://www.example.com/')).toBe(true);
  });

  it('is false for an unparseable URL or an empty domain', () => {
    expect(ruleAppliesTo(rule(), 'not a url')).toBe(false);
    expect(ruleAppliesTo(rule({ domain: '' }), 'https://example.com/')).toBe(false);
  });
});

describe('autoRunRules and applicableRules', () => {
  const rules = [
    rule({ id: 'a', autoRun: true, domain: 'example.com' }),
    rule({ id: 'b', autoRun: false, domain: 'example.com' }),
    rule({ id: 'c', autoRun: true, scope: 'global', domain: '' }),
    rule({ id: 'd', autoRun: true, domain: 'other.com' }),
    rule({ id: 'e', autoRun: true, enabled: false, domain: 'example.com' }),
  ];

  it('auto-runs only matching, enabled, auto-run rules', () => {
    expect(autoRunRules(rules, 'https://example.com/').map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('lists every applicable rule for a manual run', () => {
    expect(applicableRules(rules, 'https://example.com/').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('parseRules', () => {
  it('returns an empty list for junk', () => {
    expect(parseRules(null)).toEqual([]);
    expect(parseRules('nope')).toEqual([]);
    expect(parseRules({})).toEqual([]);
    expect(parseRules([null, 42, 'x'])).toEqual([]);
  });

  it('skips entries missing required fields', () => {
    const parsed = parseRules([{ id: 'a' }, { id: 'b', name: 'B', code: '1' }]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe('b');
  });

  it('defaults kind, scope and flags conservatively', () => {
    const parsed = parseRules([{ id: 'a', name: 'A', code: '1' }]);
    expect(parsed[0]).toMatchObject({ kind: 'js', scope: 'domain', autoRun: false, enabled: true });
  });

  it('caps the number of rules read', () => {
    const many = Array.from({ length: MAX_RULES + 50 }, (_, i) => ({ id: `r${i}`, name: 'n', code: '1' }));
    expect(parseRules(many)).toHaveLength(MAX_RULES);
  });
});

describe('upsertRule and removeRule', () => {
  it('replaces a rule with the same id', () => {
    const next = upsertRule([rule({ id: 'a', name: 'old' })], rule({ id: 'a', name: 'new' }));
    expect(next).toHaveLength(1);
    expect(next[0]!.name).toBe('new');
  });

  it('appends a new rule', () => {
    const next = upsertRule([rule({ id: 'a' })], rule({ id: 'b' }));
    expect(next.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('keeps the newest MAX_RULES entries', () => {
    let rules: StudioRule[] = [];
    for (let i = 0; i < MAX_RULES + 10; i += 1) rules = upsertRule(rules, rule({ id: `r${i}` }));
    expect(rules).toHaveLength(MAX_RULES);
    expect(rules[rules.length - 1]!.id).toBe(`r${MAX_RULES + 9}`);
  });

  it('removes by id and is a no-op for an unknown id', () => {
    expect(removeRule([rule({ id: 'a' }), rule({ id: 'b' })], 'a').map((r) => r.id)).toEqual(['b']);
    expect(removeRule([rule({ id: 'a' })], 'zzz')).toHaveLength(1);
  });

  it('does not mutate the input array', () => {
    const input = [rule({ id: 'a' })];
    upsertRule(input, rule({ id: 'b' }));
    removeRule(input, 'a');
    expect(input).toHaveLength(1);
  });
});

describe('generateRuleId', () => {
  it('is prefixed and deterministic for fixed inputs', () => {
    expect(generateRuleId(1000, 0.5)).toBe(generateRuleId(1000, 0.5));
    expect(generateRuleId(1000, 0.5).startsWith('r')).toBe(true);
  });

  it('differs as the clock or randomness changes', () => {
    expect(generateRuleId(1000, 0.1)).not.toBe(generateRuleId(2000, 0.1));
    expect(generateRuleId(1000, 0.1)).not.toBe(generateRuleId(1000, 0.9));
  });
});
