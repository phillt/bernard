import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RUN_ROOT_ENV } from './__tests__/global-run-root.js';
import {
  atomicRemoveDirectorySync,
  isRemovalTombstone,
  pruneSubdirectoriesByAge,
} from './fs-utils.js';

/**
 * The directory-shaped half of `fs-utils`, against a REAL filesystem (#585).
 *
 * `fs-utils.test.ts` mocks `node:fs` wholesale, which is right for the write
 * helpers' call shape and useless here. The only assertion that means anything
 * for a pruner is *the directory is gone* — and a naive test would pass with
 * the bug fully present, because the mechanism #585 originally reached for
 * (`pruneFileGroupsByMtime`) fails silently twice over: it filters directories
 * out before ranking them, and its `unlinkSync` would throw on one inside an
 * empty `catch`. A mock cannot tell those apart from a removal.
 *
 * The "wrong pruner" case is asserted directly below, so the distinction is
 * pinned rather than argued.
 */

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.env[RUN_ROOT_ENV] ?? os.tmpdir(), 'bernard-fs-dirs-'));
});

afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/** A subdirectory holding a file, aged by back-dating its own mtime. */
function seedDir(name: string, ageMs = 0): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'out.txt'), 'work');
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, when, when);
  }
  return dir;
}

const DAY = 24 * 60 * 60 * 1000;

describe('atomicRemoveDirectorySync', () => {
  it('removes the directory and everything under it', () => {
    const dir = seedDir('work');
    fs.mkdirSync(path.join(dir, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'deeper', 'a.txt'), 'x');

    atomicRemoveDirectorySync(dir);

    expect(fs.existsSync(dir)).toBe(false);
  });

  /**
   * The property the name claims: the directory is gone *by name* before the
   * recursive walk starts, so an interruption cannot leave it half-emptied
   * under the id a later run would adopt.
   */
  it('leaves nothing behind under the original name', () => {
    seedDir('work');
    atomicRemoveDirectorySync(path.join(root, 'work'));
    expect(fs.readdirSync(root)).toEqual([]);
  });

  /**
   * The property the rename buys, and the only case that can tell the two
   * implementations apart: a plain `fs.rmSync(dir, {recursive:true})` that dies
   * part-way leaves the directory under its ORIGINAL name holding whatever the
   * walk did not reach — which the next run then adopts as though it were its
   * own output. With the rename the name is already gone and what survives is a
   * tombstone the sweep collects.
   *
   * The failure is produced with a real permission rather than a spy: `node:fs`
   * exports non-configurable properties, so `vi.spyOn(fs, 'rmSync')` throws
   * `Cannot redefine property`, and mocking the module wholesale is what
   * `fs-utils.test.ts` already does and what this file exists not to do.
   * Skipped as root, who is not stopped by a mode.
   */
  it.skipIf(process.getuid?.() === 0)('has already removed the name when the walk fails', () => {
    const dir = seedDir('work');
    // 0o500 leaves the directory readable and traversable but not writable,
    // so its entries cannot be unlinked and `rmSync` fails mid-walk.
    fs.chmodSync(dir, 0o500);
    try {
      atomicRemoveDirectorySync(dir);

      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.readdirSync(root)).toHaveLength(1);
      expect(fs.readdirSync(root).every(isRemovalTombstone)).toBe(true);
    } finally {
      // Or `afterEach` cannot clean up either, and the leftover outlives the run.
      for (const name of fs.readdirSync(root)) {
        try {
          fs.chmodSync(path.join(root, name), 0o700);
        } catch {
          // ignore
        }
      }
    }
  });

  it('is a no-op for a directory that is not there', () => {
    expect(() => atomicRemoveDirectorySync(path.join(root, 'absent'))).not.toThrow();
    expect(fs.existsSync(root)).toBe(true);
  });
});

describe('isRemovalTombstone', () => {
  // Both halves are required — see the predicate's own doc. A workspace whose
  // owner is literally called `nightly.removing` must survive, and so must an
  // unrelated dotfile directory somebody dropped in.
  it.each([
    ['.work.123.abcd1234.removing', true],
    ['nightly.removing', false],
    ['.hidden', false],
    ['work', false],
  ])('%s → %s', (name, expected) => {
    expect(isRemovalTombstone(name)).toBe(expected);
  });
});

describe('pruneSubdirectoriesByAge', () => {
  it('removes a subdirectory older than the bound, contents and all', () => {
    seedDir('stale', 40 * DAY);

    pruneSubdirectoriesByAge(root, 30 * DAY);

    expect(fs.existsSync(path.join(root, 'stale'))).toBe(false);
  });

  it('keeps a subdirectory inside the bound', () => {
    seedDir('fresh', 2 * DAY);

    pruneSubdirectoriesByAge(root, 30 * DAY);

    expect(fs.readFileSync(path.join(root, 'fresh', 'out.txt'), 'utf-8')).toBe('work');
  });

  /**
   * Age is judged per directory, never as a ranking. Fifty live cron jobs must
   * all survive one sweep — which is the whole reason this is not a count cap.
   */
  it('judges each subdirectory on its own age', () => {
    seedDir('a', 1 * DAY);
    seedDir('b', 5 * DAY);
    seedDir('c', 90 * DAY);

    pruneSubdirectoriesByAge(root, 30 * DAY);

    expect(fs.readdirSync(root).sort()).toEqual(['a', 'b']);
  });

  it('collects a tombstone whatever its age', () => {
    const tombstone = path.join(root, '.work.99.deadbeef.removing');
    fs.mkdirSync(tombstone, { recursive: true });
    fs.writeFileSync(path.join(tombstone, 'leftover.txt'), 'x');

    pruneSubdirectoriesByAge(root, 30 * DAY);

    expect(fs.existsSync(tombstone)).toBe(false);
  });

  it('leaves files alone', () => {
    fs.writeFileSync(path.join(root, 'notes.json'), '{}');
    const when = new Date(Date.now() - 90 * DAY);
    fs.utimesSync(path.join(root, 'notes.json'), when, when);

    pruneSubdirectoriesByAge(root, 30 * DAY);

    expect(fs.existsSync(path.join(root, 'notes.json'))).toBe(true);
  });

  it('is a no-op for a directory that does not exist', () => {
    expect(() => pruneSubdirectoriesByAge(path.join(root, 'nope'), 1)).not.toThrow();
  });

  /**
   * Why this module exists at all.
   *
   * `pruneFileGroupsByMtime` is what #585 named as the answer, and handing it a
   * directory root does nothing: `listFilesByMtime` drops directories before
   * grouping, and `unlinkSync` on one throws into an empty `catch`. Pinned so
   * nobody "simplifies" the new pruner back onto the file-shaped one.
   */
  it('the file-shaped pruner cannot do this', async () => {
    const { pruneFileGroupsByMtime } = await import('./jsonl.js');
    seedDir('stale', 90 * DAY);

    pruneFileGroupsByMtime(root, 0, (name) => name);

    expect(fs.existsSync(path.join(root, 'stale'))).toBe(true);
  });
});
