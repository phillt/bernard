import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
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
 */
export function useTempHome(prefix: string): () => string {
  let dir = '';
  let originalHome: string | undefined;

  beforeEach(() => {
    const parent = process.env[RUN_ROOT_ENV] ?? tmpdir();
    dir = mkdtempSync(join(parent, `${prefix}-`));
    originalHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = dir;
  });

  afterEach(() => {
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
