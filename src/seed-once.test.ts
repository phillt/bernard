import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedOnce } from './fs-utils.js';

describe('seedOnce', () => {
  let dir: string;
  let marker: string;
  let lock: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedonce-'));
    marker = path.join(dir, '.seeded-v1');
    lock = marker + '.lock';
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs seedFn once and writes the marker on first call', () => {
    let calls = 0;
    seedOnce(marker, () => {
      calls++;
    });
    expect(calls).toBe(1);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('is a no-op on subsequent calls', () => {
    let calls = 0;
    seedOnce(marker, () => {
      calls++;
    });
    seedOnce(marker, () => {
      calls++;
    });
    seedOnce(marker, () => {
      calls++;
    });
    expect(calls).toBe(1);
  });

  it('waits and skips seedFn when a fresh lock is held by another process', () => {
    fs.writeFileSync(lock, 'held', 'utf-8');
    let calls = 0;
    const start = Date.now();
    seedOnce(
      marker,
      () => {
        calls++;
      },
      { waitMs: 200, staleMs: 60_000 },
    );
    const elapsed = Date.now() - start;
    expect(calls).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('reclaims a stale lock and seeds', () => {
    fs.writeFileSync(lock, 'stale', 'utf-8');
    const ancient = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, ancient, ancient);
    let calls = 0;
    seedOnce(
      marker,
      () => {
        calls++;
      },
      { waitMs: 200, staleMs: 5_000 },
    );
    expect(calls).toBe(1);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('propagates errors from seedFn, releases the lock, and does not write the marker', () => {
    expect(() =>
      seedOnce(marker, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
