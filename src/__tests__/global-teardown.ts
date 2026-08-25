import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'bernard-test-home-';

/**
 * Sweeps any `bernard-test-home-*` directory left in the OS temp dir (#319).
 *
 * `setup-test-home.ts` removes its own directory in `afterAll`, which covers
 * the normal path. This is the belt-and-braces half, and it exists for two
 * reasons the per-file hook cannot address:
 *
 * 1. `afterAll` does not run when a worker is hard-killed (OOM, `process.exit`,
 *    some `--bail` teardown paths), so a crashed run still leaks.
 * 2. It is the only thing that reclaims directories left by *earlier* runs —
 *    12,255 of them had accumulated before this landed.
 *
 * Wired via `globalSetup`, which is the only mechanism Vitest offers — there is
 * no `globalTeardown` option, and an unknown config key is ignored in silence.
 * Runs once, after the whole suite. Best-effort throughout: a temp directory
 * someone else owns, or one that vanishes mid-sweep, must not fail the run.
 */
export function teardown(): void {
  const dir = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(PREFIX)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      // Another run may own it, or it may already be gone.
    }
  }
}
