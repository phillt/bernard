import { tool } from 'ai';
import { z } from 'zod';
import { printEvaluation } from '../output.js';

/**
 * Creates the `evaluate` tool for coordinator (ReAct) mode.
 *
 * Publishes a post-action self-evaluation. Unlike `think` (pre-action
 * reasoning), `evaluate` runs AFTER a tool call or batch of tool calls to
 * check whether the result matches expectations, surface surprises, and
 * decide whether to continue or course-correct.
 */
export function createEvaluateTool() {
  return tool({
    description:
      "Self-evaluate after a tool call or batch of parallel calls. Required in coordinator mode between each act and the next think/act. State in 1-3 sentences: (1) did the result match what you expected, (2) did it reveal any surprises, errors, or risks, (3) should you continue on the current path or course-correct? Be willing to catch yourself — phrases like 'Actually, that's not right because...' or 'Wait — this might make things worse, let me take a different approach' are exactly what this is for.",
    parameters: z.object({
      evaluation: z
        .string()
        .describe(
          'A concise self-check after the most recent action (1-3 sentences). Cover: expectation vs. actual, any red flags, and whether to continue or correct course.',
        ),
    }),
    execute: async ({ evaluation }): Promise<string> => {
      printEvaluation(evaluation);
      return 'Evaluation recorded.';
    },
  });
}
