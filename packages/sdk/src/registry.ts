import {
  hasPermission,
  manifestMatchesUrl,
  validateManifest,
  type MirendaApi,
  type MirendaManifest,
  type MirendaPermission,
  type MirendaPlugin,
  type PageInjection,
  type ProxiedRequest,
  type ProxiedResponse,
} from './types.js';

/** A hook that failed. Errors are isolated so one bad plugin cannot break a page. */
export interface PluginError {
  pluginId: string;
  hook: 'onLoad' | 'onRequest' | 'onResponse' | 'onPageInject' | 'onUnload';
  error: unknown;
}

export interface PluginRegistryOptions {
  /** Called for every hook failure. Defaults to a no-op. */
  onError?: (failure: PluginError) => void;
  /** Builds the API object for a plugin; the registry never invents one. */
  createApi: (plugin: MirendaPlugin) => MirendaApi;
}

/**
 * Holds the registered plugins and dispatches hooks in registration order.
 *
 * The registry is deliberately transport-agnostic: the worker uses it for
 * `onRequest`/`onResponse`, the page runtime for `onPageInject`. It never
 * mutates a request or response itself — hooks return replacements, which the
 * registry forwards, so the caller stays in control of the pipeline.
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, MirendaPlugin>();
  private readonly options: PluginRegistryOptions;

  constructor(options: PluginRegistryOptions) {
    this.options = options;
  }

  /** Validate and add a plugin. Throws when the manifest is invalid or the id is taken. */
  register(plugin: MirendaPlugin): void {
    const problems = validateManifest(plugin.manifest);
    if (problems.length > 0) {
      throw new Error(`invalid manifest for plugin: ${problems.join('; ')}`);
    }
    const id = plugin.manifest.id;
    if (this.plugins.has(id)) {
      throw new Error(`plugin already registered: ${id}`);
    }
    this.plugins.set(id, plugin);
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  get(id: string): MirendaPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): MirendaPlugin[] {
    return [...this.plugins.values()];
  }

  manifests(): MirendaManifest[] {
    return this.list().map((plugin) => plugin.manifest);
  }

  /** Plugins whose `matches` globs cover `url`, in registration order. */
  forUrl(url: string): MirendaPlugin[] {
    return this.list().filter((plugin) => manifestMatchesUrl(plugin.manifest, url));
  }

  /** Run `onLoad` for every registered plugin. */
  async loadAll(): Promise<PluginError[]> {
    const failures: PluginError[] = [];
    for (const plugin of this.plugins.values()) {
      await this.guard(plugin, 'onLoad', async () => plugin.onLoad?.(this.options.createApi(plugin)), failures);
    }
    return failures;
  }

  /** Run `onUnload` for every registered plugin. */
  async unloadAll(): Promise<PluginError[]> {
    const failures: PluginError[] = [];
    for (const plugin of this.plugins.values()) {
      await this.guard(plugin, 'onUnload', async () => plugin.onUnload?.(), failures);
    }
    return failures;
  }

  /**
   * Fold every matching plugin's `onRequest` over `request`. Each hook receives
   * the current request and may return a replacement.
   */
  async runRequestHooks(request: ProxiedRequest): Promise<ProxiedRequest> {
    let current = request;
    for (const plugin of this.forUrl(current.url)) {
      if (!plugin.onRequest) continue;
      await this.guard(plugin, 'onRequest', async () => {
        const next = await plugin.onRequest?.(current, this.options.createApi(plugin));
        if (next) current = next;
      }, []);
    }
    return current;
  }

  /** Fold every matching plugin's `onResponse` over `response`. */
  async runResponseHooks(response: ProxiedResponse): Promise<ProxiedResponse> {
    let current = response;
    for (const plugin of this.forUrl(current.url)) {
      if (!plugin.onResponse) continue;
      await this.guard(plugin, 'onResponse', async () => {
        const next = await plugin.onResponse?.(current, this.options.createApi(plugin));
        if (next) current = next;
      }, []);
    }
    return current;
  }

  /**
   * Collect `script` injections from page-runtime plugins that declared the
   * `page` permission and whose `matches` cover `url`.
   *
   * `profileId` is written onto the tag so the injected script can scope its
   * bridge calls to the profile that requested the page.
   */
  collectInjections(url: string, profileId = ''): PageInjection[] {
    const injections: PageInjection[] = [];
    for (const plugin of this.forUrl(url)) {
      const manifest = plugin.manifest;
      if (manifest.runtime === 'worker') continue;
      if (!manifest.entry) continue;
      if (!hasPermission(manifest, 'page')) continue;
      const profileAttr = profileId === '' ? '' : ` data-profile-id="${escapeAttribute(profileId)}"`;
      injections.push({
        kind: 'script',
        content: `<script src="${escapeAttribute(manifest.entry)}" data-mirenda-plugin="${escapeAttribute(manifest.id)}"${profileAttr} defer></script>`,
        source: `${manifest.name} ${manifest.version}`,
      });
    }
    return injections;
  }

  /** Does any registered plugin request this permission? */
  usesPermission(permission: MirendaPermission): boolean {
    return this.list().some((plugin) => hasPermission(plugin.manifest, permission));
  }

  private async guard(
    plugin: MirendaPlugin,
    hook: PluginError['hook'],
    run: () => Promise<void>,
    failures: PluginError[],
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      const failure: PluginError = { pluginId: plugin.manifest.id, hook, error };
      failures.push(failure);
      this.options.onError?.(failure);
    }
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
