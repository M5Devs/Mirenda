import { describe, expect, it } from 'vitest';
import { BUILTIN_EXTENSIONS, enabledPagePlugins, extensionCatalog, isBuiltinExtension } from '../src/extensions/host.js';

describe('extensionCatalog', () => {
  it('lists the built-in extensions', () => {
    const catalog = extensionCatalog();
    expect(catalog.map((extension) => extension.id)).toContain('eruda-devtools');
  });

  it('returns a copy, so a caller cannot mutate the catalog', () => {
    extensionCatalog().push({
      id: 'injected',
      name: 'Injected',
      version: '1.0.0',
      description: '',
      entry: '/x.js',
      matches: ['*'],
    });
    expect(extensionCatalog().some((extension) => extension.id === 'injected')).toBe(false);
  });

  it('every entry has an absolute entry path', () => {
    for (const extension of BUILTIN_EXTENSIONS) {
      expect(extension.entry.startsWith('/')).toBe(true);
    }
  });
});

describe('isBuiltinExtension', () => {
  it('accepts a known id and rejects anything else', () => {
    expect(isBuiltinExtension('eruda-devtools')).toBe(true);
    expect(isBuiltinExtension('not-a-plugin')).toBe(false);
    expect(isBuiltinExtension('')).toBe(false);
  });
});

describe('enabledPagePlugins', () => {
  it('returns nothing when nothing is enabled', () => {
    expect(enabledPagePlugins([])).toEqual([]);
  });

  it('builds a page-runtime manifest for an enabled extension', () => {
    const plugins = enabledPagePlugins(['eruda-devtools']);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.manifest).toMatchObject({
      id: 'eruda-devtools',
      runtime: 'page',
      entry: '/extensions/eruda-devtools.js',
      permissions: ['page'],
    });
  });

  it('ignores an unknown id, so tampered storage cannot load a foreign script', () => {
    expect(enabledPagePlugins(['eruda-devtools', '../../etc/passwd'])).toHaveLength(1);
    expect(enabledPagePlugins(['evil-plugin'])).toEqual([]);
  });

  it('does not duplicate a plugin listed twice', () => {
    expect(enabledPagePlugins(['eruda-devtools', 'eruda-devtools'])).toHaveLength(1);
  });
});
