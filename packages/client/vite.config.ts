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
export default defineConfig({
  resolve: {
    alias: {
      '@catan/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  server: { open: false },
  build: { target: 'es2022', outDir: 'dist' },
});
