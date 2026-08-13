import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * The alias points `@catan/core` at the engine's *source* rather than its build output.
 *
 * Without it a change to a rule would only reach the browser after `tsc --build`, and the most
 * common way to work on this client is to change a rule and watch what the board does. Types still
 * come from `dist` via the package's `exports` map, so a stale build shows up as a type error
 * rather than as a silently different runtime.
 */
/** Where `@catan/server` is listening during development. */
const API = process.env.CATAN_SERVER ?? 'http://localhost:3000';

export default defineConfig({
  resolve: {
    alias: {
      '@catan/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  /**
   * In development the client is served from :5173 and the server listens on :3000. The proxy makes
   * the two look like one origin, so the client can always talk to `window.location.origin` and
   * there is no development-only branch in the code that decides where the server is. In
   * production the same is true for a different reason: the server hosts these files itself.
   */
  server: {
    open: false,
    proxy: {
      '/rooms': API,
      '/health': API,
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { target: 'es2022', outDir: 'dist' },
});
