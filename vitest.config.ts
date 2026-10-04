import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The CLI imports the API by its package name; tests run it from source, as tsconfig's `paths` does.
    alias: {
      '@antondanv/brainyard': fileURLToPath(new URL('./packages/brainyard/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // vi.stubEnv() changes are undone after every test.
    unstubEnvs: true,
  },
});
