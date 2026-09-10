import { describe, it, expect, beforeEach } from 'vitest';
import {
  OFFERABLE_BUDGETS,
  claimOffer,
  _resetOffers,
  doubled,
  offerChoices,
  shellTimeoutMessage,
  MAX_SHELL_TIMEOUT_MS,
} from './timeout-offer.js';
import * as optionsModule from './config.js';
import { WIZARD_CATEGORIES_DATA } from './profiles-wizard-data.js';

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
  it('never offers either stall guard, and offers exactly one thing', () => {
    // The load-bearing assertion. Both stall guards are liveness detectors: a dead
    // connection stays dead, so doubling buys a 180-second wait for the same
    // failure — and #302 sized the provider guard at 3.3x the worst legitimate
    // TTFB across 1,230 real requests precisely so it never fires on slow-but-alive.
    //
    // Exact equality on the keys, not three `not.toContain`s. It is strictly
    // stronger (it fails on ANY new row, which is the event a human should look
    // at) and it cannot go vacuous. The predecessor sliced the module's own SOURCE
    // between two `indexOf` anchors, one of which this very review unexported — at
    // which point `indexOf` returns -1, the slice becomes the file tail, and the
    // assertions pass without examining the table at all.
    expect(Object.keys(OFFERABLE_BUDGETS)).toEqual(['shell']);
  });

  it('names a rationale and a real /options command for the row it has', () => {
    // A row without a rationale is a row somebody added without deciding whether
    // the budget expresses work or liveness, which is the distinction the module
    // exists to hold.
    for (const [budget, spec] of Object.entries(OFFERABLE_BUDGETS)) {
      expect(spec?.rationale, budget).toBeTruthy();
      expect(spec?.command, budget).toMatch(/^\/options /);
    }
  });

  it('persists to a key `/options` actually knows, and the command names that row', () => {
    // The table restates `OPTIONS_REGISTRY`'s `configKey` and its key. Rename
    // either and the offer would tell the user to type one command while writing a
    // different setting, with nothing failing. Pinned rather than imported:
    // `config.ts` pulls dotenv, providers and the model policy, and this is a
    // zero-import leaf reached from the eager tool group.
    const { OPTIONS_REGISTRY } = optionsModule;
    for (const spec of Object.values(OFFERABLE_BUDGETS)) {
      const optionName = spec!.command.replace('/options ', '');
      expect(OPTIONS_REGISTRY[optionName as keyof typeof OPTIONS_REGISTRY]).toBeDefined();
      expect(OPTIONS_REGISTRY[optionName as keyof typeof OPTIONS_REGISTRY].configKey).toBe(
        spec!.settingKey,
      );
    }
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
  it('doubles, and stops at the ceiling the wizard already declares', () => {
    // The step-limit ladder this copies carries two bounds and only one was
    // copied. Without the clamp, a user at a hand-raised budget can accept their
    // way to a twenty-minute SYNCHRONOUS `spawnSync` on Ink's render thread — and
    // a `profile`-scoped acceptance would persist a value
    // `profiles-wizard-data.ts` declares out of range.
    expect(doubled(30_000)).toBe(60_000);
    expect(doubled(400_000)).toBe(MAX_SHELL_TIMEOUT_MS);
    expect(doubled(MAX_SHELL_TIMEOUT_MS)).toBe(MAX_SHELL_TIMEOUT_MS);
  });

  it('agrees with the bound the settings wizard enforces', () => {
    // Restated rather than imported, so a test holds the two together.
    const shell = WIZARD_CATEGORIES_DATA.flatMap((c) => c.fields).find(
      (o) => o.key === 'shellTimeout',
    );
    expect(shell?.field).toMatchObject({ max: MAX_SHELL_TIMEOUT_MS });
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
