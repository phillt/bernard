import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { RUN_ROOT_ENV } from './global-run-root.js';

/**
 * Gives each test in a suite its own `BERNARD_HOME`.
 *
 * The sibling `setup-test-home.ts` does this once per *file* via `setupFiles`,
 * which is the right granularity for most suites. Store tests that write to
 * disk need a fresh directory per test, and the save/set/restore/remove dance
 * for that had been copy-pasted into nine files.
 *
 * **Created inside the run root, not `os.tmpdir()` directly.** That is the
 * point of extracting it: the hand-rolled copies called `mkdtempSync(tmpdir())`
 * and so landed outside the run-scoped parent whose single `teardown` (#319)
 * exists precisely so a killed worker leaves nothing behind — the leak that
 * reached 12,448 directories on one machine. Falls back to `os.tmpdir()` only
 * when the run root is absent (a file executed outside the configured
 * `globalSetup`), so the helper still works standalone.
 *
 * Returns a getter rather than the path: the value changes every test, and a
 * captured string would silently address the previous test's directory.
 *
 * **The same sentence is true of a captured MODULE, which is why the reset is
 * here (#457).** `paths.ts` reads `BERNARD_HOME` once at load, so a module
 * imported before this hook ran still addresses the *previous* test's
 * directory — now deleted. Writes land where nothing looks, and the assertion
 * fails only under a shuffled order, passing in declaration order. Three call
 * sites had already discovered this and opened their own `load()` with
 * `vi.resetModules()`; a fourth had a comment asserting the opposite and was
 * the test that failed. Doing it here makes the rule structural for every
 * suite instead of a convention each helper must remember.
 *
 * The store caches are closed on the way out for the same reason: a reset
 * orphans the module instance holding them, so a connection opened this test
 * could never be closed by any later one. That close is gated on the store's
 * directory existing — see the hook, where the measurement is.
 */
export function useTempHome(prefix: string): () => string {
  let dir = '';
  let originalHome: string | undefined;

  beforeEach(() => {
    // First, before anything can capture the old home.
    vi.resetModules();
    const parent = process.env[RUN_ROOT_ENV] ?? tmpdir();
    dir = mkdtempSync(join(parent, `${prefix}-`));
    originalHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = dir;
  });

  afterEach(async () => {
    // Against the instance this test actually used — the next `resetModules`
    // orphans it, cache and open descriptors included.
    //
    // **Gated on the store's own directory existing, and that gate is the whole
    // cost of this hook.** `resetModules` invalidates the registry, so an
    // unconditional `await import()` here RE-EVALUATES both modules on every
    // test rather than hitting a cache, and both pull `node:sqlite` through
    // `createRequire`: measured at 2.40 ms per test against 0.015 ms cached,
    // ~0.9 s of added CPU across the 32 suites that use this helper. Measured
    // again with a probe, only 19 of 379 invocations had a store directory at
    // all — 360 of them loaded SQLite to close an empty connection cache. Two
    // `existsSync` calls cost ~4 µs and answer the question directly.
    //
    // Named imports rather than a scan over exports: this file is not a
    // `*.test.ts`, so it IS inside the `tsc` program, and a renamed closer is
    // then a compile error instead of a regex that quietly matches nothing —
    // which would reinstate the leak this hook exists to prevent, with every
    // test green.
    //
    // The two directories come from `paths.js` rather than a literal layout —
    // it is the owner of `<BERNARD_HOME>/bernard/...` and it imports only
    // `node:path` and `node:os`, so re-evaluating it per test is free where
    // re-evaluating a SQLite store is not.
    const { appletDataDir, knowledgeDir } = await import('../paths.js');
    if (existsSync(dirname(appletDataDir('probe')))) {
      const { closeAllAppletStores } = await import('../apps/store.js');
      closeAllAppletStores();
    }
    if (existsSync(dirname(knowledgeDir('probe')))) {
      const { closeAllKnowledgeStores } = await import('../knowledge/store.js');
      closeAllKnowledgeStores();
    }
    if (originalHome === undefined) delete process.env.BERNARD_HOME;
    else process.env.BERNARD_HOME = originalHome;
    // Best-effort: a temp directory that vanished mid-test must not fail the
    // suite, and the run root's teardown sweeps whatever survives.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  return () => dir;
}
