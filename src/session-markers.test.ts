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
