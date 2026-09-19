import { describe, it, expect, beforeEach } from 'vitest';
import { saveActiveSettings } from './profiles.js';
import {
  FirstUseHints,
  hintFor,
  loadShownHints,
  markHintShown,
  renderHint,
} from './setting-hints.js';
import { WIZARD_FIELDS, type HintTrigger } from './profiles-wizard-data.js';

/**
 * First-use hints: the mechanism, against a real throwaway profile (#583).
 *
 * `setup-test-home.ts` gives every test file its own `BERNARD_HOME`, so the
 * persisted half is exercised for real rather than against a stub — which
 * matters, because "once ever" is the whole point and a latch that only works
 * in memory would pass every in-process assertion and repeat on every launch.
 */

/** Triggers the registry actually declares, so no case invents one. */
const DECLARED = WIZARD_FIELDS.flatMap((f) => (f.hint ? [f.hint.trigger] : []));

// One throwaway home per FILE, not per case, so the latch a case writes is
// still there for the next one — which is the feature, and would make every
// case after the first see an already-announced hint.
beforeEach(() => {
  saveActiveSettings({ shownHints: undefined });
});

describe('renderHint', () => {
  it('always ends with the door out of it', () => {
    // The signpost is composed rather than written, which is what makes "every
    // hint names a command" a property instead of a habit. A hint the reader
    // cannot act on is the one thing this must never produce.
    for (const field of WIZARD_FIELDS) {
      if (!field.hint) continue;
      const text = renderHint(field.hint);
      expect(text, field.key).toContain(field.hint.surface);
      expect(text, field.key).toMatch(/ to change it\.$/);
    }
  });

  it('says what happened before it says where to go', () => {
    const hint = hintFor('voice:first-readback')!;
    expect(renderHint(hint).indexOf(hint.message)).toBe(0);
  });
});

describe('hintFor', () => {
  it('finds each declared trigger exactly once', () => {
    for (const trigger of DECLARED) expect(hintFor(trigger)?.trigger, trigger).toBe(trigger);
  });

  it('answers null for a trigger nothing declares', () => {
    // The union makes this a compile error at a real call site; the cast covers
    // the runtime path, where the honest answer is silence rather than a throw
    // from a courtesy.
    expect(hintFor('nothing:declares-this' as HintTrigger)).toBeNull();
  });
});

describe('FirstUseHints', () => {
  it('shows a hint once and then never again in the same session', () => {
    const hints = new FirstUseHints();
    hints.beginTurn();
    expect(hints.take('voice:first-readback')).toContain('/voice');
    hints.beginTurn();
    expect(hints.take('voice:first-readback')).toBeNull();
  });

  it('shows at most one per turn, and re-opens the budget on the next', () => {
    // The load-bearing limit rather than the polite one: two hints firing
    // milliseconds apart in the pre-turn pipeline would otherwise have the
    // first toast replaced by the second AND marked shown, so it would be spent
    // without ever having been on screen.
    const hints = new FirstUseHints();
    hints.beginTurn();
    expect(hints.take('rewriter:first-rewrite')).not.toBeNull();
    expect(hints.take('recall:first-injection')).toBeNull();
    hints.beginTurn();
    expect(hints.take('recall:first-injection')).not.toBeNull();
  });

  it('refusing a hint does not spend it', () => {
    // Guard the guard for the case above: the second trigger must come back on
    // a later turn rather than having been consumed by the refusal.
    const hints = new FirstUseHints();
    hints.beginTurn();
    hints.take('rewriter:first-rewrite');
    hints.take('recall:first-injection');
    expect(loadShownHints().has('recall:first-injection')).toBe(false);
  });

  it('stops at the session cap however many turns run', () => {
    // One per turn alone still allows twenty in twenty turns, which is the
    // burst #583 asks not to produce, spread out. The cap has to BIND for this
    // to mean anything — set at or above the number of declared hints it is
    // inert, and this case would pass against no cap at all.
    expect(DECLARED.length).toBeGreaterThan(2);
    const hints = new FirstUseHints();
    const shown: string[] = [];
    for (const trigger of DECLARED) {
      hints.beginTurn();
      const text = hints.take(trigger);
      if (text !== null) shown.push(text);
    }
    expect(shown).toHaveLength(2);
  });

  it('gives the capped hint back on the next session', () => {
    // Guard the guard: a cap that SPENT the hint it refused would quietly
    // destroy it, which is worse than the burst.
    const first = new FirstUseHints();
    for (const trigger of DECLARED) {
      first.beginTurn();
      first.take(trigger);
    }
    const second = new FirstUseHints();
    const rest = DECLARED.filter((t) => !loadShownHints().has(t));
    expect(rest).toHaveLength(1);
    second.beginTurn();
    expect(second.take(rest[0])).not.toBeNull();
  });

  it('remembers across sessions, not just across turns', () => {
    // A fresh holder is a fresh session. Without the persisted half this passes
    // in memory and tells every user the same thing on every launch.
    const first = new FirstUseHints();
    first.beginTurn();
    expect(first.take('rewriter:first-rewrite')).not.toBeNull();

    const second = new FirstUseHints();
    second.beginTurn();
    expect(second.take('rewriter:first-rewrite')).toBeNull();
  });

  it('writes the latch where a profile delete takes it with it', () => {
    markHintShown('recall:first-injection');
    expect(loadShownHints().has('recall:first-injection')).toBe(true);
    // Idempotent: a second call must not grow the stored list.
    markHintShown('recall:first-injection');
    expect([...loadShownHints()].filter((t) => t === 'recall:first-injection')).toHaveLength(1);
  });

  it('stays quiet for a trigger the registry does not declare', () => {
    const hints = new FirstUseHints();
    hints.beginTurn();
    expect(hints.take('nothing:declares-this' as HintTrigger)).toBeNull();
    // …and does not spend the turn's budget on the refusal.
    expect(hints.take('voice:first-readback')).not.toBeNull();
  });
});
