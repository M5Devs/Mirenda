import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every class literal the UI builds must have a rule in `app.css`.
 *
 * A class name with no rule is not a type error and not a runtime error: the
 * element simply renders with no positioning. `bootUnauthenticated` shipped a
 * `.chrome` wrapper whose rule was deleted, so the sign-in button landed at
 * (0,0) underneath the opaque empty-state overlay — present in the DOM, visible
 * to `querySelector`, and impossible to tap. Nothing failed; users just had no
 * way to sign in.
 */
const UI_ROOT = join(import.meta.dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function classesDefinedInCss(): Set<string> {
  const css = readFileSync(join(UI_ROOT, 'styles', 'app.css'), 'utf8');
  return new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
}

/** Class tokens from `el('div', { class: 'a b' })` calls, mapped to their file. */
function classesUsedInTs(): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  for (const file of tsFiles(UI_ROOT)) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(/class:\s*'([^']+)'/g)) {
      for (const token of match[1].split(/\s+/).filter(Boolean)) {
        if (!used.has(token)) used.set(token, new Set());
        used.get(token)!.add(basename(file));
      }
    }
  }
  return used;
}

describe('stylesheet coverage', () => {
  it('defines a rule for every class the UI applies', () => {
    const defined = classesDefinedInCss();
    const used = classesUsedInTs();
    expect(used.size).toBeGreaterThan(40);

    const undefinedClasses = [...used.keys()].filter((name) => !defined.has(name)).sort();
    const detail = undefinedClasses.map((name) => `${name} (in ${[...used.get(name)!].join(', ')})`);

    expect(detail).toEqual([]);
  });
});
