import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Env var carrying the run-scoped parent from `globalSetup` to each worker. */
export const RUN_ROOT_ENV = 'BERNARD_TEST_RUN_ROOT';

/**
 * Creates one temp directory for the whole run (#319).
 *
 * `setup-test-home.ts` then makes each test file's `BERNARD_HOME` *inside* it,
 * so teardown is a single recursive remove rather than a scan.
 *
 * The scan is what this replaces, and it had a hazard worth recording: sweeping
 * `os.tmpdir()` for a `bernard-test-home-*` prefix deletes directories owned by
 * **any** run, including one that is live right now. Two concurrent invocations
 * — `vitest --watch` in one terminal and `vitest run` in another, or two CI
 * jobs on one runner — and whichever finished first would delete the other's
 * `BERNARD_HOME` mid-suite. A run-scoped parent cannot do that.
 *
 * `globalSetup` runs in the Vitest main process before any worker spawns, and
 * each worker gets a copy of `process.env` at spawn, so the variable reaches
 * them. (`provide`/`inject` is the sanctioned channel if that ordering ever
 * changes.)
 */
export function setup(): void {
  process.env[RUN_ROOT_ENV] = mkdtempSync(join(tmpdir(), 'bernard-test-run-'));
}

/**
 * Removes the run root, and with it every per-file home inside it.
 *
 * Best-effort: a temp directory that vanished mid-run must not fail the suite.
 */
export function teardown(): void {
  const root = process.env[RUN_ROOT_ENV];
  if (!root) return;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Another process may own it, or it may already be gone.
  }
}
