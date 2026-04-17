import { tool } from 'ai';
import { z } from 'zod';
import { printThought } from '../output.js';

/**
 * Creates the `think` tool for coordinator (ReAct) mode.
 *
 * Publishes a brief reasoning statement visibly to the user. The return value
 * to the model is intentionally minimal to avoid re-polluting the context.
 */
export function createThinkTool() {
  return tool({
    description:
      "Publish a brief 'thought' that the user can see — use this to think out loud before a tool call or batch of parallel calls. Keep each thought to 1-3 sentences. Explain what you know, what gap the next action fills, and what success looks like. Required in coordinator mode before each non-trivial tool-call batch.",
    parameters: z.object({
      thought: z.string().describe('A concise reasoning statement (1-3 sentences)'),
    }),
    execute: async ({ thought }): Promise<string> => {
      printThought(thought);
      return 'Thought recorded.';
    },
  });
}
