import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from './__tests__/temp-home.js';

/**
 * Workspace retention (#585), against a REAL directory.
 *
 * Every assertion here is "the directory is (still) there" rather than "a
 * function was called", because the failure this closes is silent by
 * construction: the pruner #585 originally named drops directories before it
 * ranks them, so a spy-shaped test of it passes while nothing is ever removed.
 *
 * `WORKSPACES_DIR` is a module-level const resolved from `BERNARD_HOME` at
 * import, and `workspaces.ts` keeps its sweep timestamp at module scope — so
 * every test re-imports after `useTempHome` has set the home, which also resets
 * the sweep latch.
 */
useTempHome('bernard-workspaces');

type Mod = typeof import('./workspaces.js');
let m: Mod;
let paths: typeof import('./paths.js');

beforeEach(async () => {
  vi.resetModules();
  m = await import('./workspaces.js');
  paths = await import('./paths.js');
});

const DAY = 24 * 60 * 60 * 1000;

/** A workspace with output in it, optionally back-dated. */
function seed(namespace: string, id: string, ageMs = 0): string {
  const dir = paths.runWorkspace(namespace, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.md'), '# out');
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, when, when);
  }
  return dir;
}

describe('ensureRunWorkspace', () => {
  it('creates the workspace and reports no error', () => {
    const dir = paths.runWorkspace('cron', 'job-1');

    expect(m.ensureRunWorkspace(dir)).toBeNull();

    expect(fs.existsSync(dir)).toBe(true);
  });

  /**
   * The stamp is what makes the age axis mean "time since a run last used
   * this" rather than "time since the last file landed here". Without it a job
   * that writes its output once and reads it back on every later run has that
   * output reclaimed while the job is live.
   */
  it('stamps an existing workspace as used now', () => {
    const dir = seed('cron', 'job-1', 90 * DAY);

    m.ensureRunWorkspace(dir);

    expect(Date.now() - fs.statSync(dir).mtimeMs).toBeLessThan(5_000);
  });

  /**
   * The ordering inside `ensureRunWorkspace`. A dormant workspace being picked
   * up again IS older than the bound at the moment it is picked up — so a sweep
   * that ran first would delete the very output this run is re-using and then
   * hand it a fresh empty directory, silently.
   */
  it('does not reclaim the workspace it is being asked to prepare', () => {
    const dir = seed('cron', 'nightly', 400 * DAY);

    m.ensureRunWorkspace(dir);

    expect(fs.readFileSync(path.join(dir, 'report.md'), 'utf-8')).toBe('# out');
  });

  it('reclaims a stale sibling on the way past', () => {
    seed('cron', 'gone', 400 * DAY);

    m.ensureRunWorkspace(paths.runWorkspace('cron', 'live'));

    expect(fs.existsSync(paths.runWorkspace('cron', 'gone'))).toBe(false);
    expect(fs.existsSync(paths.runWorkspace('cron', 'live'))).toBe(true);
  });

  it('reports a message rather than throwing when the path cannot be created', () => {
    // A file where the directory should go: `mkdirSync` fails with EEXIST/ENOTDIR.
    const blocked = paths.runWorkspace('cron', 'blocked');
    fs.mkdirSync(path.dirname(blocked), { recursive: true });
    fs.writeFileSync(blocked, 'not a directory');

    expect(m.ensureRunWorkspace(path.join(blocked, 'inner'))).toBeTruthy();
  });

  /**
   * Retention hangs off the module's entry points rather than a call in
   * `index.ts`, which is what makes a third producer inherit it — but the
   * sweep is at most hourly per process, or the cron daemon would re-walk the
   * tree on every job fire.
   */
  it('sweeps at most once per interval', () => {
    m.ensureRunWorkspace(paths.runWorkspace('cron', 'live'));
    seed('cron', 'gone', 400 * DAY);

    m.ensureRunWorkspace(paths.runWorkspace('cron', 'live'));

    expect(fs.existsSync(paths.runWorkspace('cron', 'gone'))).toBe(true);
  });
});

describe('removeRunWorkspace', () => {
  it('removes the workspace and its contents', () => {
    seed('apps', 'notes');

    m.removeRunWorkspace('apps', 'notes');

    expect(fs.existsSync(paths.runWorkspace('apps', 'notes'))).toBe(false);
  });

  it('leaves siblings alone', () => {
    seed('cron', 'a');
    seed('cron', 'b');

    m.removeRunWorkspace('cron', 'a');

    expect(fs.existsSync(paths.runWorkspace('cron', 'b'))).toBe(true);
  });

  it('is a no-op for a workspace that was never created', () => {
    expect(() => m.removeRunWorkspace('cron', 'never')).not.toThrow();
  });

  /**
   * A cron job id reaches this straight off a model's `cron {action:'delete'}`
   * call, and `path.join` resolves `..` — so `runWorkspace('cron', '../../memory')`
   * names a real directory outside the workspaces root, and this function is a
   * recursive delete. Nothing supplies such an id today; that is exactly the
   * kind of thing that stops being true quietly.
   */
  it.each(['../../memory', '..', '.', 'a/b', ''])('refuses to climb out for %j', (id) => {
    const escapee = path.join(paths.DATA_DIR, 'memory');
    fs.mkdirSync(escapee, { recursive: true });
    fs.writeFileSync(path.join(escapee, 'keep.md'), 'user content');

    m.removeRunWorkspace('cron', id);

    expect(fs.existsSync(path.join(escapee, 'keep.md'))).toBe(true);
  });

  it('refuses a namespace that is not a single segment', () => {
    const escapee = path.join(paths.DATA_DIR, 'memory');
    fs.mkdirSync(escapee, { recursive: true });

    m.removeRunWorkspace('../memory', 'anything');

    expect(fs.existsSync(escapee)).toBe(true);
  });

  /**
   * The other half of "the sweeper rides the same path as the grower": a
   * process that only ever deletes still bounds what it can see. Same reason
   * `WorkQueue.ensureSwept` hangs off `peek` as well as `enqueue`.
   */
  it('sweeps too', () => {
    seed('cron', 'gone', 400 * DAY);

    m.removeRunWorkspace('apps', 'unrelated');

    expect(fs.existsSync(paths.runWorkspace('cron', 'gone'))).toBe(false);
  });
});

describe('pruneRunWorkspaces', () => {
  it('walks every namespace', () => {
    seed('cron', 'old', 400 * DAY);
    seed('apps', 'old', 400 * DAY);
    seed('apps', 'new', 1 * DAY);

    m.pruneRunWorkspaces();

    expect(fs.existsSync(paths.runWorkspace('cron', 'old'))).toBe(false);
    expect(fs.existsSync(paths.runWorkspace('apps', 'old'))).toBe(false);
    expect(fs.existsSync(paths.runWorkspace('apps', 'new'))).toBe(true);
  });

  /**
   * A namespace is structural, not a workspace. Removing an empty
   * `workspaces/cron/` would only mean recreating it on the next run, and it is
   * not what #585 is about.
   */
  it('never removes a namespace directory', () => {
    const dir = seed('cron', 'old', 400 * DAY);

    m.pruneRunWorkspaces();

    expect(fs.existsSync(path.dirname(dir))).toBe(true);
  });

  it('is a no-op before any workspace exists', () => {
    expect(() => m.pruneRunWorkspaces()).not.toThrow();
  });

  /** The bound is `paths.WORKSPACE_MAX_AGE_MS`, not a second copy of 30 days. */
  it('prunes exactly at the declared bound', () => {
    seed('cron', 'just-inside', paths.WORKSPACE_MAX_AGE_MS - 60_000);
    seed('cron', 'just-outside', paths.WORKSPACE_MAX_AGE_MS + 60_000);

    m.pruneRunWorkspaces();

    expect(fs.existsSync(paths.runWorkspace('cron', 'just-inside'))).toBe(true);
    expect(fs.existsSync(paths.runWorkspace('cron', 'just-outside'))).toBe(false);
  });
});
