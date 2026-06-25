import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Isolate every test run from the developer's real ~/.config|.local/share/bernard
    // data by pointing BERNARD_HOME at a throwaway dir before any module loads.
    setupFiles: ['./src/__tests__/setup-test-home.ts'],
  },
});
