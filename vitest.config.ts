import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // vi.stubEnv() changes are undone after every test.
    unstubEnvs: true,
  },
});
