import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The workspace script runs Vitest with apps/desktop as its cwd, while the
    // shared config also remains usable when invoked from the repository root.
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'apps/desktop/src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
    environmentMatchGlobs: [['**/renderer/**/*.{test,spec}.{ts,tsx}', 'jsdom']],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
