import * as path from 'node:path';
import * as fs from 'node:fs';

/** Writes `data` to a `.tmp` file then renames it into place for crash-safe persistence. */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
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
export function seedBundledJsonDir(bundledDir: string, destDir: string, markerPath: string): void {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    seedOnce(markerPath, () => {
      if (!fs.existsSync(bundledDir)) return;
      for (const file of fs.readdirSync(bundledDir).filter((f) => f.endsWith('.json'))) {
        copyBundledJsonIfAbsent(bundledDir, destDir, file);
      }
    });
  } catch {
    // best-effort
  }
}
