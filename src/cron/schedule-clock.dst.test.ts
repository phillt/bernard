import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseCronFields, nextMatchAfter } from './schedule-clock.js';

/**
 * Daylight saving, pinned in a fixed zone.
 *
 * These assertions are unobservable for eleven months of the year and in half
 * the world's timezones, so the zone is set rather than assumed. That only works
 * in a forked child — hence the `.dst.test.ts` suffix and the `poolMatchGlobs`
 * entry routing it there; see the comment in `vitest.config.ts` for why a
 * worker thread cannot do it. Restored in `afterAll`: Vitest runs one file at a
 * time per worker, so nothing else can be mid-run while it is changed.
 *
 * `America/New_York`, 2026: 2026-11-01 falls back (01:00–01:59 EDT, 05:00Z–
 * 05:59Z, repeats as EST at 06:00Z–06:59Z) and 2026-03-08 springs forward
 * (02:00–02:59 local does not exist).
 */
const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = 'America/New_York';
  // Guard the guard. Under Vitest's default worker-THREAD pool the assignment
  // above is silently ignored — `process.env` is a thread-local copy that never
  // reaches the OS `setenv`, so V8's timezone cache keeps whatever the process
  // started with. Four of the assertions below happen to hold in
  // `America/Los_Angeles` as well, so without this the file would pass for the
  // wrong reason if its `poolMatchGlobs` entry were ever dropped.
  const inTheFold = new Date(Date.parse('2026-11-01T05:30:00Z'));
  if (inTheFold.getHours() !== 1 || inTheFold.getTimezoneOffset() !== 240) {
    throw new Error(
      `TZ=America/New_York did not take effect (got offset ${inTheFold.getTimezoneOffset()}). ` +
        'This file must run in the `forks` pool — see `poolMatchGlobs` in vitest.config.ts.',
    );
  }
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** Every boundary the expression names in `(from, until]`, as ISO instants. */
function boundaries(expr: string, fromZ: string, untilZ: string): string[] {
  const f = parseCronFields(expr);
  if (!f) throw new Error(`expected "${expr}" to parse`);
  const until = Date.parse(untilZ);
  const out: string[] = [];
  let cursor = new Date(Date.parse(fromZ));
  for (let i = 0; i < 200; i++) {
    const next = nextMatchAfter(f, cursor);
    if (!next || next.getTime() > until) break;
    out.push(next.toISOString());
    cursor = next;
  }
  return out;
}

describe('a repeated hour', () => {
  it('is traversed by a job that recurs within the day', () => {
    // The second 01:00 is 06:00Z. Before the fix the walk stepped from 05:00Z
    // straight to 07:00Z: an hourly job fired 24 times that day instead of 25,
    // and because `countBoundaries` walks this same function the lost fire was
    // not counted as missed either.
    expect(boundaries('0 * * * *', '2026-11-01T04:05:00Z', '2026-11-01T08:00:00Z')).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T08:00:00.000Z',
    ]);
  });

  it('is traversed at sub-hour granularity too', () => {
    expect(boundaries('*/30 * * * *', '2026-11-01T04:45:00Z', '2026-11-01T07:00:00Z')).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T06:30:00.000Z',
      '2026-11-01T07:00:00.000Z',
    ]);
  });

  it('is stepped over by a job that names a time of day, which must not fire twice', () => {
    // Vixie's rule, and the constraint on the fix: "half past one" means half
    // past one, not half past one and again. Traversing the fold for these
    // would double-fire every fixed-time job once a year — worse than the bug.
    expect(boundaries('30 1 * * *', '2026-11-01T04:05:00Z', '2026-11-02T00:00:00Z')).toEqual([
      '2026-11-01T05:30:00.000Z',
    ]);
    expect(boundaries('0 1 * * *', '2026-11-01T04:05:00Z', '2026-11-02T00:00:00Z')).toEqual([
      '2026-11-01T05:00:00.000Z',
    ]);
  });

  it('is traversed at seconds granularity, where the minute step never runs', () => {
    // The second step's own branch: from 01:59:50 EDT the walk crosses the fold
    // one second at a time and never reaches a minute step, so this is the only
    // case that exercises it.
    expect(boundaries('*/10 * * * * *', '2026-11-01T05:59:45Z', '2026-11-01T06:00:10Z')).toEqual([
      '2026-11-01T05:59:50.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T06:00:10.000Z',
    ]);
  });

  it('does not let the walk return a boundary it has already returned', () => {
    // `setSeconds(s + 1)` from 01:00:00 EST names the local time 01:00:01,
    // which JS resolves to the FIRST (EDT) occurrence — an hour before the
    // instant it was asked to advance past. The walk then re-derived 06:00Z
    // forever, and `*/30` went backwards.
    const f = parseCronFields('0 * * * *')!;
    const fold = new Date(Date.parse('2026-11-01T06:00:00Z'));
    expect(nextMatchAfter(f, fold)?.toISOString()).toBe('2026-11-01T07:00:00.000Z');
  });
});

describe('a missing hour', () => {
  it('is skipped rather than spun on, for a daily job', () => {
    // 02:30 local does not exist on 2026-03-08, so the job simply does not run
    // that day. Getting this wrong is an infinite walk, not a wrong answer.
    expect(boundaries('30 2 * * *', '2026-03-08T06:05:00Z', '2026-03-11T00:00:00Z')).toEqual([
      '2026-03-09T06:30:00.000Z',
      '2026-03-10T06:30:00.000Z',
    ]);
  });

  it('is skipped by an hourly job, which resumes at the hour that does exist', () => {
    expect(boundaries('0 * * * *', '2026-03-08T06:05:00Z', '2026-03-08T09:00:00Z')).toEqual([
      '2026-03-08T07:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
      '2026-03-08T09:00:00.000Z',
    ]);
  });
});
