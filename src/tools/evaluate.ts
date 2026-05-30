import { tool } from 'ai';
import { z } from 'zod';
import { printEvaluation } from '../output.js';
import { verdictOf, type Check } from '../rubric.js';
import type { VerificationStore } from '../agent-status.js';

/**
 * Creates the `evaluate` tool for coordinator (ReAct) mode.
 *
 * Publishes a post-action self-evaluation. Unlike `think` (pre-action
 * reasoning), `evaluate` runs AFTER a tool call or batch of tool calls to
 * check whether the result matches expectations, surface surprises, and
 * decide whether to continue or course-correct.
 *
 * Issue #145 extension: callers may also pass a list of structured `checks`
 * which compute a machine-checkable verdict (pass/warn/fail) and write it
 * into the caller's `VerificationStore` if one was supplied.
 */
const CheckSchema = z.object({
  id: z.string().describe('Stable identifier for this check (e.g. "post_write_confirmed").'),
  label: z.string().describe('Short human-readable label.'),
  status: z.enum(['pass', 'warn', 'fail', 'skip']),
  evidence: z.string().optional().describe('Optional one-line evidence.'),
});

export function createEvaluateTool(verification?: VerificationStore) {
  return tool({
    description:
      "Self-evaluate after a tool call or batch of parallel calls. Required in coordinator mode between each act and the next think/act. State in 1-3 sentences: (1) did the result match what you expected, (2) did it reveal any surprises, errors, or risks, (3) should you continue on the current path or course-correct? Be willing to catch yourself — phrases like 'Actually, that's not right because...' or 'Wait — this might make things worse, let me take a different approach' are exactly what this is for. You may optionally attach a `checks` array of structured judgments (pass/warn/fail/skip) — these contribute to the turn's machine-checkable rubric (issue #145).",
    parameters: z.object({
      evaluation: z
        .string()
        .describe(
          'A concise self-check after the most recent action (1-3 sentences). Cover: expectation vs. actual, any red flags, and whether to continue or correct course.',
        ),
      checks: z
        .array(CheckSchema)
        .optional()
        .describe(
          'Optional structured checks behind the evaluation. Each Check states pass/warn/fail/skip plus optional evidence. Useful checks include: verification_ran, output_matched_schema, post_write_confirmed, plan_steps_terminal.',
        ),
    }),
    execute: async ({ evaluation, checks }): Promise<string> => {
      printEvaluation(evaluation);
      if (!checks || checks.length === 0) {
        return 'Evaluation recorded.';
      }
      const verdict = verdictOf(checks as Check[]);
      if (verification) {
        verification.setLast({
          verdict,
          reason: evaluation,
          source: 'evaluate',
          checks: checks as Check[],
        });
      }
      return `Evaluation recorded: ${verdict.toUpperCase()} (${checks.length} check${checks.length === 1 ? '' : 's'}).`;
    },
  });
}
