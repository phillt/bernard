import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * Writes `data` to a `.tmp` file then renames it into place for crash-safe
 * persistence.
 *
 * `mode` is applied to the temp file **before** the rename, which is what
 * makes a 0600 file achievable atomically: `writeFileSync` then `chmodSync`
 * leaves a window at the default umask, and a rename does not carry a mode of
 * its own. Callers that need restrictive permissions should pass it here
 * rather than chmod afterwards.
 */
export function atomicWriteFileSync(
  filePath: string,
  data: string,
  opts: { mode?: number } = {},
): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(
    tmp,
    data,
    opts.mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode: opts.mode },
  );
  fs.renameSync(tmp, filePath);
}

/**
 * The same crash-safe write, through a temp path no other writer can collide
 * with — and which is unlinked when the write fails.
 *
 * Separate from {@link atomicWriteFileSync} rather than an option on it,
 * because the two answer different questions and the fixed-suffix form is
 * correct where it is used: a store with one writer wants a predictable temp
 * name, and the sweeps that exist for orphans (`RAGStore.cleanupStaleTemp`,
 * `pruneFileGroupsByMtime`) are written against known names.
 *
 * Use this where SEVERAL processes write one file. `memories.json` has four —
 * the REPL, the detached exit worker, the cron daemon and `bernard facts` — so
 * a shared `.tmp` means two concurrent persists write one file and rename it
 * twice. `tools/file.ts` reached the same conclusion independently and had
 * hand-rolled it; this is that function, lifted rather than copied a third
 * time.
 *
 * The unlink-on-failure half is what makes a unique name safe: without it every
 * failed write leaves a distinct orphan forever, where a fixed suffix left one
 * that the next write overwrote. Returns an error message, never throws, so a
 * caller on a best-effort path (a debounced flush) can stay silent.
 *
 * `mode` is applied to the temp file before the rename, for the reason
 * {@link atomicWriteFileSync} gives: a `chmodSync` afterwards leaves a window at
 * the default umask, and a rename carries no mode of its own. It was missing here,
 * which forced a caller wanting 0600 to choose between a restrictive mode and a
 * collision-free temp name.
 */
export function atomicWriteFileSyncUnique(
  filePath: string,
  data: string,
  opts: { mode?: number } = {},
): string | null {
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(
      tmp,
      data,
      opts.mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode: opts.mode },
    );
    fs.renameSync(tmp, filePath);
    return null;
  } catch (err: unknown) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup: the write already failed, and a failed unlink on
      // top of it is not something a caller can act on.
    }
    return `Write failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export interface SeedOnceOptions {
  /** A lockfile older than this is treated as orphaned and reclaimed. Default 30s. */
  staleMs?: number;
  /** Max time to wait for another process's seed to finish before retrying. Default 5s. */
  waitMs?: number;
  /** Max retry passes through the lock-acquire loop before giving up (fail-open). Default 3. */
  maxAttempts?: number;
}

/**
 * Runs `seedFn` exactly once per `markerPath`, serializing across processes via
 * a sibling `<markerPath>.lock` file opened with `wx` (atomic create-exclusive).
 *
 * The marker is written **after** `seedFn` succeeds (atomically), so its
 * presence truthfully means "we are seeded". A process that crashes mid-seed
 * leaves only the lock file behind, which is reclaimed after `staleMs`.
 *
 * Loser-of-the-race semantics: a caller that finds the lock held waits up to
 * `waitMs` for the marker. If the marker appears, return. If not — the holder
 * may have died, or the lock may have vanished entirely — the caller loops
 * back and re-attempts lock acquisition. Bounded by `maxAttempts` so a
 * pathological churn cannot loop forever; on exhaustion we fail open.
 */
export function seedOnce(markerPath: string, seedFn: () => void, opts: SeedOnceOptions = {}): void {
  const staleMs = opts.staleMs ?? 30_000;
  const waitMs = opts.waitMs ?? 5_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const lockPath = markerPath + '.lock';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (fs.existsSync(markerPath)) return;

    let fd: number;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;

      // Lock held by someone — alive, dead, or already gone. Classify, then
      // either reclaim, wait, or retry immediately.
      let action: 'reclaim' | 'wait' | 'retry' = 'wait';
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) action = 'reclaim';
      } catch {
        // Lock vanished between EEXIST and stat — no active holder. Retry now.
        action = 'retry';
      }

      if (action === 'reclaim') {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another process may have just cleaned it up; either way, retry.
        }
        continue;
      }
      if (action === 'retry') continue;

      // Wait briefly for the marker to appear.
      const deadline = Date.now() + waitMs;
      const buf = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(markerPath) && Date.now() < deadline) {
        Atomics.wait(buf, 0, 0, 50);
      }
      if (fs.existsSync(markerPath)) return;
      // Deadline expired without a marker — holder likely died. Loop and
      // re-acquire (stale-reclaim will catch it on this or a later attempt).
      continue;
    }

    try {
      // Re-check inside the lock: another process may have just finished.
      if (fs.existsSync(markerPath)) return;
      seedFn();
      atomicWriteFileSync(markerPath, new Date().toISOString());
      return;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
  }
  // All attempts exhausted — best-effort: skip seeding this run. The next
  // process to start (after staleMs passes) will reclaim and seed.
}

/**
 * Copies one bundled `.json` file into a data directory, unless it is already
 * there.
 *
 * The shared primitive behind every bundled-file seed. `SpecialistStore` and
 * `AppRegistry` had independently grown the same body: never overwrite a
 * user-edited copy, `JSON.parse` first so an obviously corrupt bundle file is
 * skipped rather than written, and swallow a single bad file so the rest of
 * the seed continues. Those semantics are exactly the ones that must not drift
 * between two seeded directories.
 */
export function copyBundledJsonIfAbsent(bundledDir: string, destDir: string, file: string): void {
  const dest = path.join(destDir, file);
  if (fs.existsSync(dest)) return; // never overwrite a user-edited copy
  try {
    const raw = fs.readFileSync(path.join(bundledDir, file), 'utf-8');
    JSON.parse(raw); // catch an obviously corrupt bundle file before seeding
    atomicWriteFileSync(dest, raw);
  } catch {
    // skip individual bad files; continue seeding the rest
  }
}

/**
 * Seeds every `.json` file from a bundled directory into a data directory,
 * once, behind a marker.
 *
 * Returns silently when the bundle directory is absent — a build that did not
 * copy it must not break the caller. Best-effort throughout: seeding must
 * never block startup or an invocation.
 */
export function seedBundledJsonDir(
  bundledDir: string,
  destDir: string,
  markerPath: string,
  /**
   * Extra copying to perform under the SAME marker and the same cross-process
   * lock — e.g. an applet's served assets alongside its manifest. Running it
   * outside would re-do the work on every construction and, worse, lose
   * `seedOnce`'s lock, letting two concurrent callers race the copy.
   */
  also?: (bundledDir: string, destDir: string) => void,
): void {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    seedOnce(markerPath, () => {
      if (!fs.existsSync(bundledDir)) return;
      for (const file of fs.readdirSync(bundledDir).filter((f) => f.endsWith('.json'))) {
        copyBundledJsonIfAbsent(bundledDir, destDir, file);
      }
      also?.(bundledDir, destDir);
    });
  } catch {
    // best-effort
  }
}

/**
 * The names of the directories directly under `dir`, sorted. `[]` when `dir`
 * does not exist or cannot be read.
 *
 * The fourth copy of this dance is what made it a function: `KnowledgeCorpus`,
 * `bundledAppIds` and the specialist-RAG listing each had their own
 * `readdirSync(dir, { withFileTypes: true })` + dirent filter + fail-open catch,
 * and `jsonl.listFilesByMtime` owns the file-shaped sibling.
 *
 * Fail-open like its neighbours here: an unreadable directory is an empty one,
 * because every caller is answering "what exists?" for a listing.
 */
export function listSubdirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
