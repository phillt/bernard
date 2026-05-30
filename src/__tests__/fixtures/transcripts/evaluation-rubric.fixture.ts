import { defineFixture } from '../fixture-schema.js';

/**
 * Issue #145 — measurable evaluation rubric. Invariants here pin the
 * `verdictOf` worst-of aggregation, the `PlanStore.evaluateRubric` derivation,
 * and the `ToolMeta.verifyOutput` post-write hook contract end-to-end. Long-
 * term safety net so changes to any of the three surfaces fail loudly here.
 */
export const evaluationRubricFixture = defineFixture({
  name: 'evaluation-rubric',
  category: 'evaluation-rubric',
  invariants: [
    // verdictOf — worst-of aggregation
    {
      type: 'rubric_verdict_of',
      checks: [],
      expected: 'pass',
    },
    {
      type: 'rubric_verdict_of',
      checks: [
        { id: 'a', label: 'a', status: 'pass' },
        { id: 'b', label: 'b', status: 'pass' },
      ],
      expected: 'pass',
    },
    {
      type: 'rubric_verdict_of',
      checks: [
        { id: 'a', label: 'a', status: 'pass' },
        { id: 'b', label: 'b', status: 'warn' },
        { id: 'c', label: 'c', status: 'skip' },
      ],
      expected: 'warn',
    },
    {
      type: 'rubric_verdict_of',
      checks: [
        { id: 'a', label: 'a', status: 'pass' },
        { id: 'b', label: 'b', status: 'warn' },
        { id: 'c', label: 'c', status: 'fail' },
      ],
      expected: 'fail',
    },
    {
      type: 'rubric_verdict_of',
      checks: [
        { id: 'a', label: 'a', status: 'skip' },
        { id: 'b', label: 'b', status: 'skip' },
      ],
      expected: 'pass',
    },

    // PlanStore.evaluateRubric — derivation
    {
      type: 'rubric_plan_evaluates_to',
      steps: [],
      expectedVerdict: 'pass',
      expectChecks: [
        { id: 'steps_terminal', status: 'skip' },
        { id: 'signoffs_present', status: 'skip' },
        { id: 'no_error_steps', status: 'pass' },
      ],
    },
    {
      type: 'rubric_plan_evaluates_to',
      steps: [
        {
          id: 1,
          description: 'do thing',
          verification: 'check thing',
          status: 'in_progress',
        },
      ],
      expectedVerdict: 'fail',
      expectChecks: [{ id: 'steps_terminal', status: 'fail' }],
    },
    {
      type: 'rubric_plan_evaluates_to',
      steps: [
        {
          id: 1,
          description: 'do thing',
          verification: 'check thing',
          status: 'done',
          signoff: 'confirmed via re-read of file',
        },
      ],
      expectedVerdict: 'pass',
      expectChecks: [
        { id: 'steps_terminal', status: 'pass' },
        { id: 'signoffs_present', status: 'pass' },
        { id: 'no_error_steps', status: 'pass' },
      ],
    },
    {
      type: 'rubric_plan_evaluates_to',
      steps: [
        {
          id: 1,
          description: 'do thing',
          verification: 'check thing',
          status: 'done',
          signoff: 'ok',
        },
      ],
      expectedVerdict: 'warn',
      expectChecks: [{ id: 'signoffs_present', status: 'warn' }],
    },
    {
      type: 'rubric_plan_evaluates_to',
      steps: [
        {
          id: 1,
          description: 'a',
          verification: 'va',
          status: 'error',
          note: 'boom',
        },
        {
          id: 2,
          description: 'b',
          verification: 'vb',
          status: 'error',
          note: 'boom2',
        },
      ],
      expectedVerdict: 'fail',
      expectChecks: [{ id: 'no_error_steps', status: 'fail' }],
    },

    // ToolMeta.verifyOutput — post-write hook contract
    {
      type: 'rubric_post_write_hook',
      meta: {
        name: 'fake_writer',
        kind: 'write',
        sideEffect: 'local',
        verifyOutput: (_args, result) => {
          const r = result as { ok?: boolean };
          return r.ok ? { status: 'pass', evidence: 'wrote' } : { status: 'fail', evidence: 'no' };
        },
      },
      args: {},
      result: { ok: true },
      expected: { status: 'pass' },
    },
    {
      type: 'rubric_post_write_hook',
      meta: {
        name: 'fake_writer',
        kind: 'write',
        sideEffect: 'local',
        verifyOutput: (_args, result) => {
          const r = result as { ok?: boolean };
          return r.ok ? { status: 'pass', evidence: 'wrote' } : { status: 'fail', evidence: 'no' };
        },
      },
      args: {},
      result: { ok: false },
      expected: { status: 'fail' },
    },
    {
      type: 'rubric_post_write_hook',
      meta: {
        name: 'fake_writer',
        kind: 'write',
        sideEffect: 'local',
        verifyOutput: () => null,
      },
      args: {},
      result: { ok: true },
      expected: null,
    },
  ],
});
