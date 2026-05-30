import { defineFixture } from '../fixture-schema.js';

/**
 * Issue #169 — scratch is wiped on first turn, on `/CLEAR`-style explicit
 * markers, and when Jaccard token similarity against the previous user
 * input drops below `config.scratchSubjectThreshold` (0.15 by default).
 * Same-topic follow-ups keep scratch.
 */
export const scratchFixture = defineFixture({
  name: 'scratch',
  category: 'scratch',
  invariants: [
    {
      type: 'scratch_clears_on_subject_change',
      userInput: 'anything',
      previousUserInput: undefined,
      expectResetAll: true,
    },
    {
      type: 'scratch_clears_on_subject_change',
      userInput: '/CLEAR',
      previousUserInput: 'something we were doing',
      expectResetAll: true,
    },
    {
      type: 'scratch_clears_on_subject_change',
      userInput: 'now help me write a poem about lemons',
      previousUserInput: 'debug the failing test in agent.test.ts please',
      expectResetAll: true,
    },
    {
      type: 'scratch_clears_on_subject_change',
      userInput: 'and also rename the variable in agent.test.ts',
      previousUserInput: 'debug the failing test in agent.test.ts please',
      expectResetAll: false,
    },
  ],
});
