import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUN_ROOT_ENV } from './global-run-root.js';

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
/**
 * Created inside the run-scoped parent from `global-run-root.ts` (#319), so the
 * whole run's homes are removed by one `rmSync` at the end rather than by a
 * per-file hook plus a prefix scan of `os.tmpdir()`.
 *
 * Setup files run once per test file under Vitest's default isolation — which
 * is what makes the isolation work — so without a cleanup the suite left one
 * directory per test file per run, forever. A developer machine had accumulated
 * **12,448**. Nothing here has to run on the crash path: if a worker is killed,
 * `teardown` still removes the parent.
 *
 * Falls back to `os.tmpdir()` if the parent is missing, so running a single
 * test file directly (without `globalSetup`) still gets an isolated home.
 */
const testHome = mkdtempSync(join(process.env[RUN_ROOT_ENV] ?? tmpdir(), 'bernard-test-home-'));
process.env.BERNARD_HOME = testHome;
