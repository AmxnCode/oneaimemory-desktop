import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Model download/first-load is slow on a cold cache — generous but bounded.
    testTimeout: 30_000,
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/**/__tests__/**', 'src/index.ts'] },
  },
});
