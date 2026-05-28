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
  /** Max time to wait for another process's seed to finish before returning. Default 5s. */
  waitMs?: number;
}

/**
 * Runs `seedFn` exactly once per `markerPath`, serializing across processes via
 * a sibling `<markerPath>.lock` file opened with `wx` (atomic create-exclusive).
 *
 * The marker is written **after** `seedFn` succeeds, so its presence truthfully
 * means "we are seeded". A process that crashes mid-seed leaves only the lock
 * file behind, which is reclaimed after `staleMs` on the next call.
 *
 * Concurrent callers that lose the race for the lock wait (up to `waitMs`) for
 * the marker to appear, then return without invoking `seedFn` themselves.
 */
export function seedOnce(markerPath: string, seedFn: () => void, opts: SeedOnceOptions = {}): void {
  const staleMs = opts.staleMs ?? 30_000;
  const waitMs = opts.waitMs ?? 5_000;
  if (fs.existsSync(markerPath)) return;

  const lockPath = markerPath + '.lock';
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    // Possibly stale — a previous holder crashed before unlinking.
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > staleMs) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another process may have just cleaned it up; fall through.
        }
        return seedOnce(markerPath, seedFn, opts);
      }
    } catch {
      // Lock vanished between EEXIST and stat; let the wait loop below handle it.
    }
    // Another process is actively seeding — wait briefly for the marker.
    const deadline = Date.now() + waitMs;
    const buf = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(markerPath) && Date.now() < deadline) {
      Atomics.wait(buf, 0, 0, 50);
    }
    return;
  }

  try {
    // Re-check: another process may have completed between our existsSync and openSync.
    if (fs.existsSync(markerPath)) return;
    seedFn();
    fs.writeFileSync(markerPath, new Date().toISOString(), 'utf-8');
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
