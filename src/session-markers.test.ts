import { describe, it, expect } from 'vitest';
import {
  BOUNDARY_PREFIXES,
  MISSING_PLAN_PREFIX,
  PLAN_ENFORCEMENT_PREFIX,
  isBoundaryNotice,
  isSessionScaffolding,
} from './session-markers.js';
import { buildEnforcementFeedback, buildMissingPlanFeedback } from './react.js';

/**
 * The plan-enforcement re-prompt is scaffolding, and was not on the list (#447).
 *
 * `wrapIterate` pushes strategy extras into persistent history so the model
 * sees them on the next iterate, and the enforcement feedback is `role: 'user'`
 * — so a whole rendered plan, followed by "Resolve each remaining step", landed
 * in the transcript as a right-aligned `❯` bubble. Bernard instructing itself,
 * painted as something the user said.
 *
 * This module's own docstring predicted it: every consumer that hand-rolled a
 * list of scaffolding drifted. It had drifted again, in a way that was visible
 * on screen.
 */
describe('the plan-enforcement re-prompt is scaffolding', () => {
  it('is what the producer actually emits', () => {
    // The anti-drift assertion, and the only one that matters: a detector keyed
    // on a sentence someone retyped is one that silently stops matching when
    // the prompt is reworded. `react.ts` interpolates these constants, so this
    // fails the moment it stops doing so.
    expect(
      buildEnforcementFeedback('1. [pending] do the thing').startsWith(PLAN_ENFORCEMENT_PREFIX),
    ).toBe(true);
    expect(buildMissingPlanFeedback().startsWith(MISSING_PLAN_PREFIX)).toBe(true);
  });

  it('is recognised as a notice, so nothing renders it as a turn', () => {
    expect(isBoundaryNotice(buildEnforcementFeedback('1. [pending] x'))).toBe(true);
    expect(isBoundaryNotice(buildMissingPlanFeedback())).toBe(true);
    // `isSessionScaffolding` is the resume replay's gate and now the live
    // transcript's too; `isBoundaryNotice` is the RAG query builder's, which
    // was embedding a rendered plan into retrieval queries for every enforced
    // turn. Both are covered by one list.
    expect(isSessionScaffolding(buildEnforcementFeedback('1. [pending] x'))).toBe(true);
  });

  it('does not swallow an ordinary turn', () => {
    // The direction that would be catastrophic rather than merely noisy: a
    // prefix loose enough to match real prose would drop the user's own words
    // out of the transcript AND out of the retrieval query.
    for (const text of [
      'Your plan sounds good, go ahead',
      'you are operating on the wrong branch',
      'what is this?',
      '',
    ]) {
      expect(isSessionScaffolding(text), text).toBe(false);
    }
  });

  it('keeps every prefix non-empty', () => {
    // Guard the guard: one empty string in the list makes `startsWith` true for
    // everything, and every message in history becomes scaffolding.
    for (const p of BOUNDARY_PREFIXES) expect(p.length).toBeGreaterThan(10);
  });
});

/**
 * Why two of the prefixes may safely be unbracketed prose (#447 follow-up).
 *
 * `isBoundaryNotice` is `startsWith`, and `PLAN_ENFORCEMENT_PREFIX` /
 * `MISSING_PLAN_PREFIX` are ordinary sentences rather than `[bracketed]` — so
 * on raw text a user who types "Your plan still has unresolved steps: which one
 * is blocked?" classifies as scaffolding and their turn is silently dropped
 * from the resume replay and the RAG query.
 *
 * It does not reproduce, and that is the point of pinning it: what prevents it
 * is that no user text reaches this detector RAW. `Agent.processInput` stamps
 * every turn through `timestampUserMessage` inside `wrapUserMessage`, so the
 * string in history begins with a timestamp or a wrapper tag and never with the
 * user's first word. Nothing states that, and it is exactly the kind of thing a
 * plausible token-cost change removes — dropping the per-turn timestamp is a
 * one-line saving with no failing test and a silently-dropped user turn.
 *
 * The alternative fix is bracketing the two prefixes, and this module's own
 * docstring rules it out: the text is tuned prompt wording the model reads
 * verbatim, so bracketing changes what every coordinator turn is told. Pinning
 * the invariant is what is left.
 */
describe('a real user turn cannot be mistaken for scaffolding', () => {
  it('classifies the bare sentence as scaffolding — the hazard, stated', () => {
    // Not a bug report: it documents the exposure the invariant below covers,
    // so the next reader knows what the stamping is load-bearing for.
    expect(isBoundaryNotice(`${PLAN_ENFORCEMENT_PREFIX} which one is blocked?`)).toBe(true);
    expect(isBoundaryNotice(`${MISSING_PLAN_PREFIX} plan — why not?`)).toBe(true);
  });

  it('but no user turn reaches the detector as bare text', async () => {
    const { timestampUserMessage } = await import('./tools/datetime.js');
    // Exactly what `processInput` builds, for the worst-case input: a user
    // quoting the enforcement wording back at Bernard.
    for (const typed of [
      `${PLAN_ENFORCEMENT_PREFIX} which one is blocked?`,
      `${MISSING_PLAN_PREFIX} plan — why not?`,
    ]) {
      const asStored = timestampUserMessage(typed);
      expect(isBoundaryNotice(asStored), asStored.slice(0, 40)).toBe(false);
      expect(isSessionScaffolding(asStored)).toBe(false);
    }
  });

  it('and the real notices are still matched after that stamping is applied', () => {
    // Guard the guard. A mutation that made `isBoundaryNotice` return false for
    // everything would pass the case above; scaffolding is injected WITHOUT the
    // timestamp, so it must still match in its own raw form.
    for (const prefix of BOUNDARY_PREFIXES) {
      expect(isBoundaryNotice(`${prefix} …`), prefix).toBe(true);
    }
  });
});
