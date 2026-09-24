/**
 * The streaming branch owns its step loop (#200). This file is what licenses
 * that: it drives the REAL `streamText` — no `vi.mock('ai')` anywhere here —
 * once with the SDK running the loop (`maxSteps: n`) and once through
 * `runAgent`, which issues one `maxSteps: 1` call per step, and asserts the two
 * are indistinguishable from the model's side and from the caller's.
 *
 * "From the model's side" is the load-bearing half: every prompt the provider
 * receives is recorded and compared whole. If owning the loop changed a single
 * byte of what step 2 is sent — a dropped message, a reordered part, a lost
 * cache marker — the prompt-cache prefix would stop matching and the model
 * would see a different conversation. The aggregate half is what keeps every
 * downstream reader (`agent.ts`, plan enforcement, the partial observer)
 * unchanged.
 */
import { describe, it, expect } from 'vitest';
import { streamText, tool } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { z } from 'zod';
import type { LanguageModelV1StreamPart } from '@ai-sdk/provider';
import { runAgent } from '../runner.js';
import type { CoreMessage } from '../sdk.js';
import type { StepFinishPayload } from '../hooks/types.js';

type Script = LanguageModelV1StreamPart[][];

const TOOL_STEP: LanguageModelV1StreamPart[] = [
  { type: 'text-delta', textDelta: 'Checking. ' },
  {
    type: 'tool-call',
    toolCallType: 'function',
    toolCallId: 'call-1',
    toolName: 'lookup',
    args: JSON.stringify({ q: 'deploy' }),
  },
  { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 10, completionTokens: 5 } },
];
const TEXT_STEP: LanguageModelV1StreamPart[] = [
  { type: 'text-delta', textDelta: 'Done.' },
  { type: 'finish', finishReason: 'stop', usage: { promptTokens: 20, completionTokens: 3 } },
];

/** A model that plays `script` one step per call and records every prompt. */
function scriptedModel(script: Script, onCall?: (index: number) => void) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV1({
    doStream: async (options) => {
      const index = prompts.length;
      prompts.push(JSON.stringify(options.prompt));
      onCall?.(index);
      const parts = script[index] ?? TEXT_STEP;
      return {
        stream: new ReadableStream<LanguageModelV1StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  return { model, prompts };
}

function lookupTool(onExecute?: () => void) {
  return tool({
    description: 'look something up',
    parameters: z.object({ q: z.string() }),
    execute: async ({ q }) => {
      onExecute?.();
      return { found: q };
    },
  });
}

const SYSTEM = 'You are a test.';
const MESSAGES: CoreMessage[] = [{ role: 'user', content: 'Is the deploy done?' }];

/** Message ids are random per run; everything else must match exactly. */
function withoutIds(messages: unknown[]): unknown[] {
  return messages.map((m) => {
    const { id: _id, ...rest } = m as { id?: string };
    return rest;
  });
}

async function viaSdk(script: Script, maxSteps: number) {
  const { model, prompts } = scriptedModel(script);
  const result = streamText({
    model,
    tools: { lookup: lookupTool() },
    maxSteps,
    system: SYSTEM,
    messages: MESSAGES,
  });
  for await (const _part of result.fullStream) {
    // drain
  }
  const [text, steps, finishReason, usage, response, toolCalls] = await Promise.all([
    result.text,
    result.steps,
    result.finishReason,
    result.usage,
    result.response,
    result.toolCalls,
  ]);
  return { prompts, text, steps, finishReason, usage, response, toolCalls };
}

async function viaRunner(
  script: Script,
  maxSteps: number,
  extra: {
    takeInterjections?: () => CoreMessage[];
    onExecute?: () => void;
    onCall?: (index: number) => void;
    onStep?: (p: StepFinishPayload) => void;
  } = {},
) {
  const { model, prompts } = scriptedModel(script, extra.onCall);
  const result = await runAgent({
    model,
    tools: { lookup: lookupTool(extra.onExecute) },
    maxSteps,
    system: SYSTEM,
    messages: MESSAGES,
    useStreaming: true,
    takeInterjections: extra.takeInterjections,
    hooks: extra.onStep ? [{ onStepFinish: extra.onStep }] : undefined,
  });
  return { prompts, result };
}

describe('runStreaming owns the step loop (#200)', () => {
  it('sends the model exactly what the SDK loop sends, step for step', async () => {
    const sdk = await viaSdk([TOOL_STEP, TEXT_STEP], 3);
    const ours = await viaRunner([TOOL_STEP, TEXT_STEP], 3);

    // Two steps, so the second prompt is the one the loop assembled itself.
    expect(sdk.prompts).toHaveLength(2);
    expect(ours.prompts).toEqual(sdk.prompts);
  });

  it('aggregates the result the way streamText does', async () => {
    const sdk = await viaSdk([TOOL_STEP, TEXT_STEP], 3);
    const { result } = await viaRunner([TOOL_STEP, TEXT_STEP], 3);

    // `streamText`'s text is EVERY step's text, unlike `generateText`'s.
    expect(sdk.text).toBe('Checking. Done.');
    expect(result.text).toBe(sdk.text);
    expect(result.finishReason).toBe(sdk.finishReason);
    expect(result.usage).toEqual(sdk.usage);
    expect(result.steps).toHaveLength(sdk.steps.length);
    expect(result.steps.map((s) => s.stepType)).toEqual(sdk.steps.map((s) => s.stepType));
    expect(result.toolCalls).toEqual(sdk.toolCalls);
    expect(withoutIds(result.response.messages)).toEqual(withoutIds(sdk.response.messages));
    // Each step's own snapshot is cumulative on both sides.
    expect(result.steps.map((s) => s.response.messages.length)).toEqual(
      sdk.steps.map((s) => s.response.messages.length),
    );
  });

  it('stops at the step budget exactly where the SDK does', async () => {
    const sdk = await viaSdk([TOOL_STEP, TOOL_STEP, TEXT_STEP], 2);
    const ours = await viaRunner([TOOL_STEP, TOOL_STEP, TEXT_STEP], 2);

    expect(ours.prompts).toEqual(sdk.prompts);
    expect(ours.result.finishReason).toBe('tool-calls');
    expect(ours.result.steps).toHaveLength(2);
  });

  it('delivers a message sent during a tool call into the next request', async () => {
    const inbox: CoreMessage[] = [];
    const steered: CoreMessage = { role: 'user', content: 'use the staging cluster' };
    const snapshots: number[] = [];
    const { prompts, result } = await viaRunner([TOOL_STEP, TEXT_STEP], 3, {
      takeInterjections: () => inbox.splice(0),
      // Sent while the tool is running — the case the whole feature is for.
      onExecute: () => inbox.push(steered),
      onStep: (p) => snapshots.push(p.response?.messages?.length ?? -1),
    });

    // Step 1's request is untouched; step 2's ends with the tool result and
    // then the user's message, which is the only order a provider accepts.
    const second = JSON.parse(prompts[1]) as { role: string; content: unknown }[];
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(JSON.stringify(second.at(-1))).toContain('use the staging cluster');
    expect(JSON.parse(prompts[0])).toHaveLength(2);

    // It rides `response.messages` in position, which is how it reaches history.
    expect(result.response.messages.map((m) => m.role)).toEqual([
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
    expect(result.response.messages[2]).toBe(steered);
    // The hook contract stays cumulative, interjection included.
    expect(snapshots).toEqual([2, 4]);
    expect(inbox).toHaveLength(0);
  });

  it('delivers a message waiting before the first request into that request', async () => {
    const inbox: CoreMessage[] = [{ role: 'user', content: 'actually, check prod' }];
    const { prompts, result } = await viaRunner([TEXT_STEP], 3, {
      takeInterjections: () => inbox.splice(0),
    });
    const first = JSON.parse(prompts[0]) as { role: string }[];
    expect(first.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(result.response.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('leaves a message sent during the final step with its sender', async () => {
    // The model has already decided to stop, so there is no next request to
    // carry it. It must stay in the inbox — the caller runs it as the next turn.
    const inbox: CoreMessage[] = [];
    const late: CoreMessage = { role: 'user', content: 'one more thing' };
    const { prompts, result } = await viaRunner([TOOL_STEP, TEXT_STEP], 3, {
      takeInterjections: () => inbox.splice(0),
      onCall: (i) => {
        if (i === 1) inbox.push(late);
      },
    });
    expect(prompts).toHaveLength(2);
    expect(inbox).toEqual([late]);
    expect(result.response.messages).not.toContain(late);
  });

  it('never drains in the middle of a tool call', async () => {
    // Drains are counted against tool executions: every drain happens either
    // before any tool ran or after every tool of the step returned.
    const events: string[] = [];
    await viaRunner([TOOL_STEP, TOOL_STEP, TEXT_STEP], 5, {
      takeInterjections: () => {
        events.push('drain');
        return [];
      },
      onExecute: () => events.push('tool'),
    });
    expect(events).toEqual(['drain', 'tool', 'drain', 'tool', 'drain']);
  });
});
