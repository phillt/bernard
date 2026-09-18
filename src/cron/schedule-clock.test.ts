import { describe, it, expect, vi, afterEach } from 'vitest';
import cron from 'node-cron';
import { parseCronFields, matchesAt, nextMatchAfter, countBoundaries } from './schedule-clock.js';

/** Local-time constructor, so these assertions do not depend on the runner's zone. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date =>
  new Date(y, mo - 1, d, h, mi, s, 0);

const fields = (expr: string) => {
  const parsed = parseCronFields(expr);
  if (!parsed) throw new Error(`expected "${expr}" to parse`);
  return parsed;
};

describe('parseCronFields', () => {
  it('accepts the five-field spelling by prepending a zero seconds field', () => {
    const f = fields('0 */2 * * *');
    expect([...f.second]).toEqual([0]);
    expect([...f.minute]).toEqual([0]);
    expect([...f.hour]).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    expect(f.dayOfMonth.size).toBe(31);
    expect(f.month.size).toBe(12);
    expect(f.dayOfWeek.size).toBe(7);
  });

  it('accepts the six-field spelling and keeps the seconds it was given', () => {
    expect([...fields('*/30 * * * * *').second]).toEqual([0, 30]);
  });

  it('expands lists, ranges and stepped ranges', () => {
    expect([...fields('15,45 * * * *').minute]).toEqual([15, 45]);
    expect([...fields('0 9-17 * * *').hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...fields('0 9-17/4 * * *').hour]).toEqual([9, 13, 17]);
  });

  it('reads month and weekday names, long and short, in either case', () => {
    expect([...fields('0 0 1 JAN *').month]).toEqual([1]);
    expect([...fields('0 0 1 jan-mar *').month]).toEqual([1, 2, 3]);
    expect([...fields('0 12 * * sun').dayOfWeek]).toEqual([0]);
    expect([...fields('0 12 * * Monday-Friday').dayOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads weekday 7 as Sunday, the spelling cron.validate accepts', () => {
    expect([...fields('0 0 * * 7').dayOfWeek]).toEqual([0]);
    expect([...fields('0 0 * * 1-7').dayOfWeek].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('rejects an expression it cannot expand rather than treating it as "never"', () => {
    // The scheduler refuses such a job loudly. A silent empty set would read as
    // a job that is scheduled and simply never fires, which is #400's whole
    // failure mode in miniature.
    expect(parseCronFields('0 0 * *')).toBeNull();
    expect(parseCronFields('0 0 * * * * *')).toBeNull();
    expect(parseCronFields('')).toBeNull();
    expect(parseCronFields('0 99 * * *')).toBeNull();
    expect(parseCronFields('0 0 * * banana')).toBeNull();
    expect(parseCronFields('*/0 * * * *')).toBeNull();
  });
});

describe('matchesAt', () => {
  it('ANDs day-of-month with day-of-week, as node-cron does', () => {
    // Vixie cron ORs them. Changing that here would silently re-time every
    // existing job, so the inherited meaning is pinned rather than improved.
    const f = fields('0 0 1 * 1');
    // 2026-06-01 is a Monday; 2026-07-01 is a Wednesday.
    expect(matchesAt(f, at(2026, 6, 1))).toBe(true);
    expect(matchesAt(f, at(2026, 7, 1))).toBe(false);
  });

  it('matches on local calendar parts', () => {
    const f = fields('30 4 1 * *');
    expect(matchesAt(f, at(2026, 6, 1, 4, 30))).toBe(true);
    expect(matchesAt(f, at(2026, 6, 1, 4, 31))).toBe(false);
  });
});

describe('nextMatchAfter', () => {
  it('is strictly after its argument, so a boundary never matches itself twice', () => {
    const f = fields('0 */2 * * *');
    const boundary = at(2026, 6, 15, 4, 0);
    expect(nextMatchAfter(f, boundary)).toEqual(at(2026, 6, 15, 6, 0));
  });

  it('coalesces nothing — it simply names the next boundary after a long gap', () => {
    const f = fields('0 */2 * * *');
    expect(nextMatchAfter(f, at(2026, 6, 15, 4, 0, 1))).toEqual(at(2026, 6, 15, 6, 0));
    expect(nextMatchAfter(f, at(2026, 6, 16, 3, 17))).toEqual(at(2026, 6, 16, 4, 0));
  });

  it('walks years for a February 29th expression without exhausting its budget', () => {
    const f = fields('0 0 29 2 *');
    expect(nextMatchAfter(f, at(2026, 3, 1))).toEqual(at(2028, 2, 29));
  });

  it('respects a weekday constraint instead of skipping to the next matching year', () => {
    // node-cron's own walker resolves a weekday mismatch by incrementing the
    // YEAR (`matcher-walker.js`), so from mid-June 2026 it answers 2034-01-01
    // for `0 12 * * sun` and 2030-01-01 for `0 0 1 * 1`. Both are wrong, and
    // both are why this module walks rather than delegating.
    expect(nextMatchAfter(fields('0 12 * * sun'), at(2026, 6, 15, 13, 0))).toEqual(
      at(2026, 6, 21, 12, 0),
    );
    expect(nextMatchAfter(fields('0 0 * * mon-fri'), at(2026, 6, 13, 9, 0))).toEqual(
      at(2026, 6, 15, 0, 0),
    );
  });

  it('honours seconds granularity', () => {
    expect(nextMatchAfter(fields('*/10 * * * * *'), at(2026, 6, 15, 4, 0, 3))).toEqual(
      at(2026, 6, 15, 4, 0, 10),
    );
  });
});

describe('countBoundaries', () => {
  const f = fields('0 */2 * * *');

  it('counts the first boundary and every one up to the ceiling, inclusive', () => {
    // The shape #400 reported: a two-hourly job whose last fire was 24 hours
    // ago owes 12 more fires, so 13 boundaries have passed in all.
    expect(countBoundaries(f, at(2026, 6, 15, 4, 0), at(2026, 6, 16, 4, 0), 500)).toEqual({
      count: 13,
      capped: false,
    });
  });

  it('is 1 when nothing further has passed', () => {
    expect(countBoundaries(f, at(2026, 6, 15, 4, 0), at(2026, 6, 15, 4, 0, 30), 500)).toEqual({
      count: 1,
      capped: false,
    });
  });

  it('reports that it stopped rather than quietly claiming the cap', () => {
    const every = fields('* * * * *');
    expect(countBoundaries(every, at(2026, 6, 15, 0, 0), at(2026, 6, 20, 0, 0), 10)).toEqual({
      count: 10,
      capped: true,
    });
  });

  it('counts nothing when the first boundary is still ahead', () => {
    expect(countBoundaries(f, at(2026, 6, 15, 6, 0), at(2026, 6, 15, 4, 0), 500).count).toBe(0);
  });
});

/**
 * Cross-checks the walk against the library it replaces.
 *
 * `cron.validate` remains the gate every write passes, so the expressions on
 * disk were written against node-cron and must keep meaning what they meant.
 * `ScheduledTask.getNextRun()` is the only public way to ask node-cron the
 * question, and it always asks from *now* — so the clock is pinned and the
 * comparison is at that instant.
 *
 * Mid-June deliberately: no mainstream timezone changes its offset then, so the
 * fixture cannot fail on a runner in a zone that observes daylight saving. The
 * weekday expressions are excluded for the reason above — node-cron gets them
 * wrong, and agreement there would be the bug, not the property.
 */
describe('agreement with node-cron on the expressions it gets right', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const AGREE = [
    '0 */2 * * *',
    '0 0 * * *',
    '*/5 * * * *',
    '15,45 * * * *',
    '30 4 1 * *',
    '*/10 * * * * *',
  ];

  it.each(AGREE)('%s', (expr) => {
    vi.useFakeTimers({ now: new Date('2026-06-15T12:00:00.000Z') });
    const task = cron.schedule(expr, () => {});
    try {
      expect(cron.validate(expr)).toBe(true);
      const theirs = task.getNextRun();
      const mine = nextMatchAfter(fields(expr), new Date());
      expect(mine?.toISOString()).toBe(theirs?.toISOString());
    } finally {
      void task.destroy();
    }
  });
});
