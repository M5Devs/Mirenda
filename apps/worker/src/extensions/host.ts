/**
 * Worker-side plugin host.
 *
 * Phase 1 ships one built-in page-runtime extension (Eruda). Page extensions are
 * declared here as manifests; their scripts are served statically and injected
 * into the proxied document by `PluginRegistry.collectInjections`. The registry
 * is wired end to end so a future worker plugin can hook `onRequest` /
 * `onResponse` without touching the proxy.
 */
import { PluginRegistry, type MirendaApi, type MirendaManifest, type MirendaPlugin } from '@mirenda/sdk';

/** The built-in extension catalog shown in the UI's extension drawer. */
export interface ExtensionRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
  matches: string[];
}

/**
 * Built-in extensions. `entry` matches the bundle emitted by
 * `extensions/<id>/vite.config.ts` into `apps/web/dist/extensions/`.
 */
export const BUILTIN_EXTENSIONS: readonly ExtensionRecord[] = [
  {
    id: 'eruda-devtools',
    name: 'Eruda DevTools',
    version: '1.0.0',
    description: 'Mobile console, elements, network and cookie inspection inside the proxied page.',
    entry: '/extensions/eruda-devtools.js',
    matches: ['*'],
  },
];

/**
 * Build the registry for one request. The API factory closes over the caller's
 * `(userId, profileId)`, so every plugin API call is scoped to that session and
 * no plugin can reach another profile.
 */
export function createPluginRegistry(
  createApi: (plugin: MirendaPlugin) => MirendaApi,
  workerPlugins: readonly MirendaPlugin[] = [],
  onError?: (failure: { pluginId: string; hook: string; error: unknown }) => void,
): PluginRegistry {
  const registry = new PluginRegistry({
    createApi,
    onError: onError
      ? (failure) => onError({ pluginId: failure.pluginId, hook: failure.hook, error: failure.error })
      : undefined,
  });
  for (const plugin of workerPlugins) registry.register(plugin);
  return registry;
}

/** Manifest payload the UI uses to render the extension drawer. */
export function extensionCatalog(): ExtensionRecord[] {
  return [...BUILTIN_EXTENSIONS];
}

/** `true` when `id` names a built-in extension. */
export function isBuiltinExtension(id: string): boolean {
  return BUILTIN_EXTENSIONS.some((extension) => extension.id === id);
}

/**
 * Page-runtime plugins for the extensions the caller has enabled.
 *
 * Only built-in ids are honoured: an unknown id from storage is ignored rather
 * than injected, so a corrupted or tampered value cannot load a foreign script.
 */
export function enabledPagePlugins(enabledIds: readonly string[]): MirendaPlugin[] {
  const enabled = new Set(enabledIds);
  return BUILTIN_EXTENSIONS.filter((extension) => enabled.has(extension.id)).map((extension) => ({
    manifest: toManifest(extension),
  }));
}

function toManifest(extension: ExtensionRecord): MirendaManifest {
  return {
    id: extension.id,
    name: extension.name,
    version: extension.version,
    description: extension.description,
    runtime: 'page',
    entry: extension.entry,
    matches: extension.matches,
    permissions: ['page'],
  };
}
