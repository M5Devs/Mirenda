import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Builds a single self-contained IIFE into the web app's `dist/extensions`.
 *
 * That directory is the Worker's one assets binding, so the same Worker that
 * injects the script also serves it — and `emptyOutDir: false` keeps the web
 * build's output intact. Build the web app first: `npm run build` does.
 *
 * The bundle is IIFE because the sandboxed page has no module loader. The panel
 * is plain DOM and runs entirely inside the proxied page's sandbox, never in
 * Mirenda's shell.
 */
export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, '../../apps/web/dist/extensions'),
    emptyOutDir: false,
    target: 'es2020',
    minify: 'esbuild',
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['iife'],
      name: 'MirendaCookieManager',
      fileName: () => 'cookie-manager.js',
    },
    rollupOptions: {
      // One side-effectful entry with no consumer: no export plumbing needed.
      output: { exports: 'none' },
    },
  },
});
