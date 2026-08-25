import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Global test isolation: point every test run at a throwaway BERNARD_HOME so the
 * suite can never read or mutate the developer's real `~/.config|.local/share/bernard`
 * data (cron jobs, memory, specialists, lineups, …).
 *
 * Why a setup file and not a per-test `process.env.BERNARD_HOME = …`: `src/paths.ts`
 * reads `BERNARD_HOME` exactly once at module-load and freezes every directory
 * constant from it. A test file's own env assignment is hoisted *below* its ESM
 * imports, so `paths.ts` has already captured the real home by the time that line
 * runs — which is how `App.test.tsx` was silently reading the user's actual cron
 * store (and tripping the 50-job cap on a populated machine). `setupFiles` run
 * before any test module is imported, and once per test file under Vitest's default
 * isolation, so this assignment is what `paths.ts` sees first and each file gets its
 * own clean, empty home.
 *
 * `BERNARD_HOME` forces a flat layout that overrides the `XDG_*` bases in `paths.ts`,
 * so setting it alone is sufficient — no need to clear the XDG vars. Tests that
 * exercise path resolution itself (`paths.test.ts`, `migrate.test.ts`) reset their
 * own env and re-import via `vi.resetModules()`, so they are unaffected.
 */
const testHome = mkdtempSync(join(tmpdir(), 'bernard-test-home-'));
process.env.BERNARD_HOME = testHome;

/**
 * Remove it again when this file's tests finish (#319). Setup files run once
 * per test file under Vitest's default isolation — which is what makes the
 * isolation work — so without this the suite left one directory per test file
 * per run, forever. A developer machine had accumulated **12,255**.
 *
 * Deletes the captured `testHome`, never `process.env.BERNARD_HOME`: the two
 * tests that exercise path resolution (`paths.test.ts`, `migrate.test.ts`)
 * delete or repoint that variable mid-run, so reading it here would either
 * no-op or remove the wrong tree.
 *
 * Errors are swallowed — a throwing `afterAll` fails the whole file, and a
 * leaked temp directory is not worth a red test. `globalTeardown` sweeps
 * whatever this misses (a hard-killed worker never runs `afterAll`).
 */
afterAll(() => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
});
