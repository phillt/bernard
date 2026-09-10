import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  OFFERABLE_BUDGETS,
  isOfferable,
  claimOffer,
  _resetOffers,
  doubled,
  offerChoices,
  shellTimeoutMessage,
} from './timeout-offer.js';

/**
 * Which timeouts may offer to raise themselves (#477).
 *
 * The assertions that matter here are about what is NOT offerable. Offering to
 * raise a liveness guard is a correctness bug — it trains a user to disable the
 * thing that stops a wedged turn — while declining to offer a work budget is only
 * an annoyance, so the tests are weighted accordingly.
 */

beforeEach(() => _resetOffers());

describe('the offerable set', () => {
  it('offers the shell timeout, which is the one that bit', () => {
    expect(isOfferable('shell')).toBe(true);
  });

  it('never offers either stall guard', () => {
    // The load-bearing test. Both are liveness detectors: a dead connection stays
    // dead, so doubling buys a 180-second wait for the same failure — and #302
    // sized the provider guard at 3.3x the worst legitimate TTFB across 1,230 real
    // requests precisely so it never fires on slow-but-alive.
    //
    // Asserted against the table's KEYS rather than by calling `isOfferable` with
    // a string the type rejects: the point is that no row exists, and a row is
    // what a future edit would add.
    const keys = Object.keys(OFFERABLE_BUDGETS);
    expect(keys).not.toContain('provider-stall');
    expect(keys).not.toContain('stream-stall');
    expect(keys).not.toContain('cron-job');
  });

  it('names a rationale for every budget it does offer', () => {
    // A row without one is a row somebody added without deciding whether the
    // budget expresses work or liveness, which is the distinction the whole
    // module exists to hold.
    for (const [budget, spec] of Object.entries(OFFERABLE_BUDGETS)) {
      expect(spec?.rationale, budget).toBeTruthy();
      expect(spec?.command, budget).toMatch(/^\/options /);
    }
  });

  it('keeps the two stall guards out of the source as offerable, not just out of the table', () => {
    // A scan rather than a type: the env names are the thing a future edit would
    // reach for, and `meta-coverage`-style source checks are this repo's idiom
    // where the invariant is "nobody wired this up".
    const src = fs.readFileSync(path.join(import.meta.dirname, 'timeout-offer.ts'), 'utf-8');
    const table = src.slice(
      src.indexOf('OFFERABLE_BUDGETS'),
      src.indexOf('export function isOfferable'),
    );
    expect(table).not.toContain('PROVIDER_STALL');
    expect(table).not.toContain('STREAM_STALL');
  });
});

describe('claimOffer', () => {
  it('is true once and false after', () => {
    // A command that times out in a loop must not ask five times.
    expect(claimOffer('shell')).toBe(true);
    expect(claimOffer('shell')).toBe(false);
    expect(claimOffer('shell')).toBe(false);
  });

  it('refuses a budget that is not offerable, even on the first ask', () => {
    expect(claimOffer('mcp-connect')).toBe(false);
    expect(claimOffer('dispatch')).toBe(false);
  });
});

describe('the offer itself', () => {
  it('doubles, because a killed command reveals no duration to derive one from', () => {
    expect(doubled(30_000)).toBe(60_000);
  });

  it('offers once / session / profile / decline, in that order', () => {
    // The step-limit ladder's shape, reused so a user who has met one ceiling
    // prompt recognises the next.
    expect(offerChoices(60_000, '/options shell-timeout').map((c) => c.scope)).toEqual([
      'once',
      'session',
      'profile',
      'decline',
    ]);
  });

  it('names the new value in seconds and the command in the persist row', () => {
    const rows = offerChoices(60_000, '/options shell-timeout');
    expect(rows[0].label).toContain('60s');
    expect(rows[2].label).toContain('/options shell-timeout');
  });

  it('never renders a sub-second budget as 0s', () => {
    // `Math.round(300 / 1000)` is 0, and "Retry once with a 0s timeout" is worse
    // than no row. Only reachable with a hand-lowered budget, which is exactly
    // what somebody debugging a timeout would set.
    expect(offerChoices(300, '/x')[0].label).toContain('300ms');
    expect(offerChoices(300, '/x')[0].label).not.toContain('0s');
  });

  it('always offers a way out', () => {
    // A ceiling prompt with no decline is a prompt that cannot be answered
    // honestly by someone who wants the guard left alone.
    expect(offerChoices(60_000, '/x').some((c) => c.scope === 'decline')).toBe(true);
  });
});

describe('shellTimeoutMessage', () => {
  it('names the command and the budget it exceeded', () => {
    // Against `spawnSync /bin/sh ETIMEDOUT`, which named neither — so the
    // taxonomy said "Timed out — operation took too long" with no path from there
    // to "the budget was 50 s and this needs 60".
    const msg = shellTimeoutMessage('npm test', 50_000, '');
    expect(msg).toContain('npm test');
    expect(msg).toContain('50000 ms');
  });

  it('keeps whatever the command printed before it was killed', () => {
    // `spawnSync` fills stdout/stderr with the partial output and the predecessor
    // threw `proc.error` before reading them, so a command that printed nine lines
    // and hung on the tenth reported nothing at all.
    expect(shellTimeoutMessage('slow', 1000, 'line one\nline two')).toContain('line two');
  });

  it('says nothing about output when there was none', () => {
    expect(shellTimeoutMessage('slow', 1000, '   ')).not.toContain('Output before');
  });
});
