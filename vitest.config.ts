import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Isolate every test run from the developer's real ~/.config|.local/share/bernard
    // data by pointing BERNARD_HOME at a throwaway dir before any module loads.
    setupFiles: ['./src/__tests__/setup-test-home.ts'],
    // Creates one run-scoped temp parent and removes it (with every per-file
    // home inside) at the end (#319). Vitest has no `globalTeardown` option — a
    // `globalSetup` file exports `setup`/`teardown`, and an unknown config key
    // is ignored silently, so getting this wrong is invisible.
    globalSetup: ['./src/__tests__/global-run-root.ts'],
  },
});
