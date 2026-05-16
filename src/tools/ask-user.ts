import { tool } from 'ai';
import { z } from 'zod';
import type { ToolOptions, AskUserQuestion } from './types.js';

/**
 * Creates the `ask_user` tool that pauses the agent loop to ask the user one
 * or more clarifying questions. Without this tool the agent would write the
 * question as prose, which (a) provides no input back to the agent and (b) in
 * coordinator mode trips the plan-enforcement loop and aborts the turn.
 */
export function createAskUserTool(askUser: ToolOptions['askUser']) {
  return tool({
    description:
      'Ask the user one or more clarifying questions and wait for their answers. Use this whenever you need information only the user can provide (intent, preferences, missing arguments) — do NOT write the question as prose in your reply, since that gets no response back. Provide each question as an entry in `questions`; supply `choices` per question when the answer is constrained, otherwise the user gets a free-form prompt. Batch related questions in one call (e.g. title + body + labels) — the user sees a tab strip showing progress. Returns JSON: {"answers": ["...", "..."]} aligned by index, {"cancelled": true, "answered": [...]} with whatever was answered before cancel, or {"unavailable": true} if running headless.',
    parameters: z.object({
      questions: z
        .array(
          z.object({
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
        )
        .min(1)
        .max(10)
        .describe(
          'One or more questions to ask in sequence. For batches of 2+, the user sees a tab strip with completed/current/upcoming markers.',
        ),
    }),
    execute: async ({ questions }, execOptions): Promise<string> => {
      if (!askUser) {
        return JSON.stringify({ unavailable: true, reason: 'no interactive user' });
      }
      const normalised: AskUserQuestion[] = questions.map((q) => ({
        question: q.question,
        choices: q.choices,
        allowOther: q.choices && q.choices.length > 0 ? q.allow_other !== false : true,
        otherLabel: q.other_label,
      }));
      const result = await askUser(normalised, execOptions?.abortSignal);
      return JSON.stringify(result);
    },
  });
}
