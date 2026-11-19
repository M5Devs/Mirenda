import { defineConfig } from 'vite';

/**
 * The dev server proxies API and proxy traffic to `wrangler dev` on :8787, so
 * the UI and worker share one origin in development exactly as in production.
 */
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/proxy': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/extensions': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
