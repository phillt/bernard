/**
 * A language model that plays one scripted step per request and records every
 * prompt it is sent (#200). Shared by the runner's owned-loop test and the
 * Agent's end-to-end one, which both drive the REAL `streamText` and differ
 * only in what they do while a request is in flight.
 */
import { MockLanguageModelV1 } from 'ai/test';
import type { LanguageModelV1Prompt, LanguageModelV1StreamPart } from '@ai-sdk/provider';

export type ScriptedStep = LanguageModelV1StreamPart[];

/** A step that calls `toolName` once, optionally saying something first. */
export function toolStep(toolName: string, args: unknown, lead?: string): ScriptedStep {
  return [
    ...(lead ? [{ type: 'text-delta' as const, textDelta: lead }] : []),
    {
      type: 'tool-call',
      toolCallType: 'function',
      toolCallId: `call-${toolName}`,
      toolName,
      args: JSON.stringify(args),
    },
    {
      type: 'finish',
      finishReason: 'tool-calls',
      usage: { promptTokens: 10, completionTokens: 5 },
    },
  ];
}

/** A final step: text, then stop. Also what an unscripted request plays. */
export const TEXT_STEP: ScriptedStep = [
  { type: 'text-delta', textDelta: 'Done.' },
  { type: 'finish', finishReason: 'stop', usage: { promptTokens: 20, completionTokens: 3 } },
];

/**
 * `during(i)` runs as request `i` is issued — after the step before it has
 * finished, which is the window a user types into. Returning `'hang'` leaves
 * that request's stream open, for a test that interrupts it.
 */
export function scriptedModel(
  steps: ScriptedStep[],
  during?: (index: number) => void | 'hang',
): { model: MockLanguageModelV1; prompts: LanguageModelV1Prompt[] } {
  const prompts: LanguageModelV1Prompt[] = [];
  const model = new MockLanguageModelV1({
    doStream: async (options) => {
      const index = prompts.length;
      prompts.push(options.prompt);
      const hang = during?.(index) === 'hang';
      return {
        stream: new ReadableStream<LanguageModelV1StreamPart>({
          start(controller) {
            if (hang) return;
            for (const part of steps[index] ?? TEXT_STEP) controller.enqueue(part);
            controller.close();
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  return { model, prompts };
}
