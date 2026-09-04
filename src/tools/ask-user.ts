import { tool } from 'ai';
import { z } from 'zod';
import type { ToolOptions, AskUserQuestion } from './types.js';
import { attachMeta } from '../framework/tools/adapter.js';

/**
 * Creates the `ask_user` tool that pauses the agent loop to ask the user one
 * or more clarifying questions. Without this tool the agent would write the
 * question as prose, which (a) provides no input back to the agent and (b) in
 * coordinator mode trips the plan-enforcement loop and aborts the turn.
 */
export function createAskUserTool(askUser: ToolOptions['askUser']) {
  return attachMeta(
    tool({
      description:
        'Ask the user one or more clarifying questions and wait for their answers. Use this whenever you need information only the user can provide (intent, preferences, missing arguments) — do NOT write the question as prose in your reply, since that gets no response back. Provide each question as an entry in `questions`; supply `choices` per question when the answer is constrained, otherwise the user gets a free-form prompt. Set `multi_select: true` on a question whose answer can include more than one choice ("select all that apply") — the user then checks several boxes and that question\'s answer comes back as a JSON array. Batch related questions in one call (e.g. title + body + labels) — a batch is presented one question per screen, and the user can go back, change an answer, and review the lot before it comes to you. Returns JSON: {"answers": ["...", ["a","b"]]} aligned by index (a multi-select slot is an array), {"cancelled": true, "answered": [...]} with whatever was answered before cancel, or {"unavailable": true} if running headless.',
      parameters: z.object({
        questions: z
          .array(
            z.object({
              question: z.string().min(1).describe('The question to show the user'),
              hint: z
                .string()
                .max(120)
                .optional()
                .describe(
                  'One short sentence of help shown beside the question — the KIND of answer you ' +
                    'are after, not a specific one. Stays on screen while they type.',
                ),
              summary: z
                .string()
                .max(30)
                .optional()
                .describe(
                  'A few words naming what this question was about, for the review screen where ' +
                    'the full question does not fit.',
                ),
              choices: z
                .array(z.string())
                .min(2)
                .optional()
                .describe(
                  'Optional list of answer labels. Provide 2+ entries; one-choice menus are rejected. Do NOT include your own "Other"/"None of the above" entry — an escape-hatch option is appended automatically (control it via allow_other / other_label).',
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
              multi_select: z
                .boolean()
                .optional()
                .describe(
                  'When choices are given, let the user select MULTIPLE options ("select all that apply") instead of just one. Set true when the choices are independent and more than one can be true at once (e.g. desired features, applicable tags). This question\'s answer is returned as an array of the chosen labels. Default false.',
                ),
            }),
          )
          .min(1)
          .max(10)
          .describe(
            'One or more questions to ask in sequence. A batch of 2+ is presented as a step-by-step wizard: one question per screen, with back, edit and a check-your-answers review.',
          ),
      }),
      execute: async ({ questions }, execOptions): Promise<string> => {
        if (!askUser) {
          return JSON.stringify({ unavailable: true, reason: 'no interactive user' });
        }
        const normalised: AskUserQuestion[] = questions.map((q) => ({
          question: q.question,
          ...(q.hint ? { hint: q.hint } : {}),
          ...(q.summary ? { summary: q.summary } : {}),
          choices: q.choices,
          allowOther: q.choices && q.choices.length > 0 ? q.allow_other !== false : true,
          otherLabel: q.other_label,
          multiSelect: q.choices && q.choices.length > 0 ? q.multi_select === true : false,
        }));
        const result = await askUser(normalised, execOptions?.abortSignal);
        return JSON.stringify(result);
      },
    }),
    {
      name: 'ask_user',
      kind: 'inert',
      deterministic: false,
      sideEffect: 'none',
      cacheable: false,
    },
  );
}
