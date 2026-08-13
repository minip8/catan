import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The client imports `@catan/core` by name. Point that at the engine's *source* so the suite
  // tests what is written rather than what was last built — a stale `dist` would otherwise make
  // client tests pass against an engine nobody is running.
  resolve: {
    alias: {
      '@catan/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // The engine is pure and fast; a short timeout keeps accidental infinite
    // loops in graph search from hanging the suite.
    testTimeout: 10_000,
  },
});
