import { tool } from 'ai';
import { z } from 'zod';
import type { ToolOptions } from './types.js';

/**
 * Creates the `ask_user` tool that pauses the agent loop to ask the user a
 * clarifying question. Without this tool the agent would write the question as
 * prose, which (a) provides no input back to the agent and (b) in coordinator
 * mode trips the plan-enforcement loop and aborts the turn.
 */
export function createAskUserTool(askUser: ToolOptions['askUser']) {
  return tool({
    description:
      'Ask the user a clarifying question and wait for their answer. Use this whenever you need information only the user can provide (intent, preferences, missing arguments) — do NOT write the question as prose in your reply, since that gets no response back. Provide a short `question` and, when possible, a small list of `choices` so the user can pick instead of type. See the field descriptions for how to control the escape-hatch "Other" option. Returns JSON: {"answer": "..."} when the user answers, {"cancelled": true} if they cancel, {"unavailable": true} if running headless.',
    parameters: z.object({
      question: z.string().min(1).describe('The question to show the user'),
      choices: z
        .array(z.string())
        .min(2)
        .optional()
        .describe(
          'Optional list of answer labels. Provide 2+ entries; one-choice menus are rejected.',
        ),
      allow_other: z
        .boolean()
        .optional()
        .describe(
          'When choices are given, also append an escape-hatch option that lets the user type a custom answer. Set false when your choices already cover every case. Default true.',
        ),
      other_label: z
        .string()
        .optional()
        .describe(
          'Label for the appended escape-hatch option. Use this to make the wording specific to your question (e.g. "Other (I will specify title and body)"). Ignored when allow_other is false. Defaults to a generic "Other (type a custom answer)".',
        ),
    }),
    execute: async (
      { question, choices, allow_other, other_label },
      execOptions,
    ): Promise<string> => {
      if (choices?.length === 1) {
        return JSON.stringify({
          error: 'ask_user requires at least 2 choices, or omit choices for free-form input.',
        });
      }
      if (!askUser) {
        return JSON.stringify({ unavailable: true, reason: 'no interactive user' });
      }
      const allowOther = choices && choices.length > 0 ? allow_other !== false : true;
      const result = await askUser(
        question,
        choices,
        allowOther,
        other_label,
        execOptions?.abortSignal,
      );
      return JSON.stringify(result);
    },
  });
}
