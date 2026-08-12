import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // The engine is pure and fast; a short timeout keeps accidental infinite
    // loops in graph search from hanging the suite.
    testTimeout: 10_000,
  },
});
