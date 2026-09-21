import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildFingerprint, watchOwnBuild, ownBuildDir } from './build-stamp.js';

/**
 * The detector behind both daemons' self-restart.
 *
 * Its two jobs pull in opposite directions and each has a real cost when it
 * gets the call wrong: missing a real rebuild leaves a daemon serving code
 * that cannot link (the nine-day-old applet host, every button a `500`),
 * while firing on a build that changed nothing rotates the host's tokens and
 * breaks every open applet tab for no reason. So both directions are pinned.
 */
describe('buildFingerprint', () => {
  const dirs: string[] = [];
  const mk = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-stamp-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('is stable across calls on an unchanged tree', () => {
    const d = mk();
    fs.writeFileSync(path.join(d, 'a.js'), 'export const a = 1;');
    fs.mkdirSync(path.join(d, 'sub'));
    fs.writeFileSync(path.join(d, 'sub', 'b.js'), 'export const b = 2;');
    expect(buildFingerprint(d)).toBe(buildFingerprint(d));
  });

  it('ignores mtime, so a no-op rebuild is not a change', () => {
    // The whole reason this hashes CONTENT. `tsc` has no `incremental` flag
    // here and rewrites all 425 outputs every build, so an mtime-based
    // signal would call every no-op rebuild a change — and each one would
    // cost the user a token rotation and a reload of every applet tab.
    const d = mk();
    const f = path.join(d, 'a.js');
    fs.writeFileSync(f, 'export const a = 1;');
    const before = buildFingerprint(d);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(f, later, later);
    fs.writeFileSync(f, 'export const a = 1;'); // same bytes, new mtime
    expect(buildFingerprint(d)).toBe(before);
  });

  it('changes when a .js file changes', () => {
    const d = mk();
    const f = path.join(d, 'a.js');
    fs.writeFileSync(f, 'export const a = 1;');
    const before = buildFingerprint(d);
    fs.writeFileSync(f, 'export const a = 2;');
    expect(buildFingerprint(d)).not.toBe(before);
  });

  it('changes when a .js file is added or removed', () => {
    const d = mk();
    fs.writeFileSync(path.join(d, 'a.js'), 'x');
    const one = buildFingerprint(d);
    fs.writeFileSync(path.join(d, 'b.js'), 'y');
    const two = buildFingerprint(d);
    expect(two).not.toBe(one);
    fs.rmSync(path.join(d, 'b.js'));
    expect(buildFingerprint(d)).toBe(one);
  });

  it('ignores files that are not .js', () => {
    // The module cache is the surface this is about. A changed
    // `dist/data/*.json` or a re-copied builtin specialist is read from disk
    // at use, so restarting a daemon for one would be a restart that could
    // not have fixed anything.
    const d = mk();
    fs.writeFileSync(path.join(d, 'a.js'), 'x');
    const before = buildFingerprint(d);
    fs.writeFileSync(path.join(d, 'catalog.json'), '{"a":1}');
    fs.writeFileSync(path.join(d, 'notes.md'), 'hello');
    expect(buildFingerprint(d)).toBe(before);
  });

  it('distinguishes the same bytes at a different path', () => {
    // Path is hashed alongside content, so moving a module is a change.
    const a = mk();
    const b = mk();
    fs.writeFileSync(path.join(a, 'one.js'), 'same');
    fs.writeFileSync(path.join(b, 'two.js'), 'same');
    expect(buildFingerprint(a)).not.toBe(buildFingerprint(b));
  });

  it('survives a directory that does not exist', () => {
    // An upgrade replacing `dist/` can be observed mid-swap. Throwing here
    // would take down the daemon this exists to keep alive.
    expect(() => buildFingerprint(path.join(os.tmpdir(), 'bernard-nope-xyz'))).not.toThrow();
  });
});

describe('ownBuildDir', () => {
  it('names the directory this module was loaded from', () => {
    // Derived from `import.meta.url`, so it is right for a checkout, a
    // global npm install and an `npm link` alike — where `process.cwd()`
    // would be right for none of them.
    const d = ownBuildDir();
    expect(fs.existsSync(d)).toBe(true);
    expect(fs.existsSync(path.join(d, path.basename(d)))).toBe(false);
  });
});

describe('watchOwnBuild', () => {
  const dirs: string[] = [];
  const stops: Array<() => void> = [];
  const mk = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-watch-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const s of stops.splice(0)) s();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Short enough to keep the suite quick, long enough to be a real window. */
  const FAST = { debounceMs: 20, settleMs: 40 };

  it('fires once when the tree changes', async () => {
    const d = mk();
    fs.writeFileSync(path.join(d, 'a.js'), 'export const a = 1;');
    const seen: string[] = [];
    stops.push(watchOwnBuild({ dir: d, ...FAST, onStale: (fp) => seen.push(fp) }));

    fs.writeFileSync(path.join(d, 'a.js'), 'export const a = 2;');
    await sleep(300);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(buildFingerprint(d));
  });

  it('does NOT fire on a rewrite with identical content', async () => {
    // The guard against restarting on a no-op `npm run build`. Without it a
    // user who builds without changing anything loses every open applet tab.
    const d = mk();
    fs.writeFileSync(path.join(d, 'a.js'), 'export const a = 1;');
    let fired = 0;
    stops.push(watchOwnBuild({ dir: d, ...FAST, onStale: () => (fired += 1) }));

    fs.writeFileSync(path.join(d, 'a.js'), 'export const a = 1;');
    await sleep(300);
    expect(fired).toBe(0);
  });

  it('waits for a tree that is still being written', async () => {
    // A build emits hundreds of files over seconds. Firing on the first one
    // would boot a replacement against a half-emitted graph — the exact
    // failure this whole module exists to remove, caused by its own fix.
    const d = mk();
    fs.writeFileSync(path.join(d, 'a.js'), 'v0');
    const at: number[] = [];
    stops.push(watchOwnBuild({ dir: d, ...FAST, onStale: () => at.push(Date.now()) }));

    const start = Date.now();
    for (let i = 1; i <= 6; i += 1) {
      fs.writeFileSync(path.join(d, `f${i}.js`), `v${i}`);
      await sleep(25);
    }
    expect(at).toHaveLength(0); // still writing
    await sleep(300);
    expect(at).toHaveLength(1);
    expect(at[0]).toBeGreaterThanOrEqual(start + 6 * 25);
  });

  it('fires at most once, so a caller cannot be asked to restart twice', async () => {
    const d = mk();
    fs.writeFileSync(path.join(d, 'a.js'), 'v0');
    let fired = 0;
    stops.push(watchOwnBuild({ dir: d, ...FAST, onStale: () => (fired += 1) }));

    fs.writeFileSync(path.join(d, 'a.js'), 'v1');
    await sleep(250);
    fs.writeFileSync(path.join(d, 'a.js'), 'v2');
    await sleep(250);
    expect(fired).toBe(1);
  });

  it('re-arms when a change is reverted before it settles', async () => {
    // Written and undone is not a rebuild. The watcher must go back to
    // waiting rather than latch, or the next real build is missed.
    const d = mk();
    const f = path.join(d, 'a.js');
    fs.writeFileSync(f, 'v0');
    let fired = 0;
    stops.push(watchOwnBuild({ dir: d, ...FAST, onStale: () => (fired += 1) }));

    fs.writeFileSync(f, 'v1');
    await sleep(30);
    fs.writeFileSync(f, 'v0'); // reverted
    await sleep(250);
    expect(fired).toBe(0);

    fs.writeFileSync(f, 'v2'); // a real one, after the revert
    await sleep(300);
    expect(fired).toBe(1);
  });

  it('stops watching once stopped', async () => {
    const d = mk();
    fs.writeFileSync(path.join(d, 'a.js'), 'v0');
    let fired = 0;
    const stop = watchOwnBuild({ dir: d, ...FAST, onStale: () => (fired += 1) });
    stop();
    fs.writeFileSync(path.join(d, 'a.js'), 'v1');
    await sleep(250);
    expect(fired).toBe(0);
  });
});
