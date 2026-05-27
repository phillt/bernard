#!/usr/bin/env tsx
/**
 * Phase C parity harness (issue #158).
 *
 * Feeds 8 representative {@link AgentSpec} shapes through {@link runAgent}
 * with a recording {@link MockLanguageModelV1}. Captures everything that
 * lands on the model's `doGenerate` (system prompt, prompt messages, tools,
 * mode, maxTokens, providerMetadata, abortSignal presence) and serializes
 * the captures to a deterministic JSON snapshot.
 *
 * The snapshot is the regression fixture. To verify parity:
 *   1. Check out `master`, run the script, save output to `master.json`.
 *   2. Check out the PR branch, run the script, save output to `pr.json`.
 *   3. `diff master.json pr.json` — any byte difference is a forwarding bug.
 *
 * Usage:
 *   BERNARD_EVAL=1 npx tsx scripts/eval-framework-parity.ts
 *
 * Optional env:
 *   BERNARD_EVAL_OUT=/tmp/parity-pr.json    # output path (default: stdout)
 *   BERNARD_EVAL_BASELINE=/tmp/parity-master.json
 *                                            # if set, diff against this and exit nonzero on drift
 *
 * Notes:
 *   - No API keys required — the model is mocked.
 *   - Runs on `master` too, but on master {@link runAgent} doesn't exist;
 *     the script imports it dynamically so the import error itself signals
 *     "this commit predates Phase C" — useful as a sanity check.
 */

import * as fs from 'node:fs';

if (process.env.BERNARD_EVAL !== '1') {
  console.error('Refusing to run: set BERNARD_EVAL=1 to execute this eval.');
  process.exit(2);
}

interface RecordedCall {
  /** Index of the call within a single scenario (always 0 for our no-tool mocks). */
  callIndex: number;
  inputFormat: string;
  mode: unknown;
  prompt: unknown;
  maxTokens: number | undefined;
  temperature: number | undefined;
  topP: number | undefined;
  topK: number | undefined;
  presencePenalty: number | undefined;
  frequencyPenalty: number | undefined;
  stopSequences: string[] | undefined;
  responseFormat: unknown;
  seed: number | undefined;
  providerMetadata: unknown;
  abortSignalPresent: boolean;
  headers: Record<string, string | undefined> | undefined;
}

interface ScenarioRecord {
  id: string;
  description: string;
  /** Serialized AgentSpec shape (callback identities replaced with placeholders). */
  spec: unknown;
  /** Every doGenerate invocation the model received during this scenario. */
  calls: RecordedCall[];
  /** Hook execution log: which hook fired in which order, with payload shape. */
  hookFires: Array<{ hookId: string; payloadKeys: string[] }>;
}

async function main(): Promise<void> {
  const { runAgent } = await import('../src/framework/runner.js');
  const { MockLanguageModelV1 } = await import('ai/test');
  const { outputHook } = await import('../src/framework/hooks/output.js');
  const { tokenStatsHook } = await import('../src/framework/hooks/token-stats.js');
  const { cronStepRecorderHook } = await import('../src/framework/hooks/cron-step-recorder.js');

  type AnyAgentSpec = Parameters<typeof runAgent>[0];

  // Each scenario builds a deterministic spec for one call-site variant.
  // Every callback (prepareStep, repair, hook handlers) is replaced with an
  // identity-preserving stub so the JSON snapshot stays byte-stable.
  interface Scenario {
    id: string;
    description: string;
    build: () => { spec: AnyAgentSpec; hookFires: Array<{ hookId: string; payloadKeys: string[] }> };
  }

  function makeRecordingHook(id: string, log: Array<{ hookId: string; payloadKeys: string[] }>) {
    return {
      onStepFinish: (payload: any) => {
        log.push({ hookId: id, payloadKeys: Object.keys(payload).sort() });
      },
    };
  }

  const baseMessages = [{ role: 'user' as const, content: 'parity-probe' }];

  const SCENARIOS: Scenario[] = [
    {
      id: 'critic',
      description: 'src/critic.ts — single-shot, no tools, no hooks.',
      build: () => {
        const fires: Array<{ hookId: string; payloadKeys: string[] }> = [];
        return {
          spec: {
            model: null as any, // filled per-run with the recorder
            providerOptions: { anthropic: { thinking: { type: 'enabled' } } },
            messages: baseMessages,
            maxTokens: 4096,
            system: 'critic system prompt',
          },
          hookFires: fires,
        };
      },
    },
    {
      id: 'cron-initial',
      description: 'src/cron/runner.ts — repair + cronStepRecorderHook.',
      build: () => {
        const fires: Array<{ hookId: string; payloadKeys: string[] }> = [];
        const recorder = cronStepRecorderHook([]);
        const wrapped = {
          onStepFinish: (payload: any) => {
            fires.push({ hookId: 'cron-step-recorder', payloadKeys: Object.keys(payload).sort() });
            return recorder.onStepFinish?.(payload);
          },
        };
        return {
          spec: {
            model: null as any,
            providerOptions: undefined,
            tools: {},
            maxSteps: 25,
            maxTokens: 4096,
            system: 'cron system prompt',
            messages: baseMessages,
            repair: (() => {
              /* placeholder */
            }) as any,
            hooks: [wrapped],
          },
          hookFires: fires,
        };
      },
    },
    {
      id: 'task',
      description: 'src/tools/task.ts — prepareStep + outputHook("task:1"), no repair.',
      build: () => {
        const fires: Array<{ hookId: string; payloadKeys: string[] }> = [];
        const print = outputHook('task:1');
        const wrapped = {
          onStepFinish: (payload: any) => {
            fires.push({ hookId: 'output(task:1)', payloadKeys: Object.keys(payload).sort() });
            return print.onStepFinish?.(payload);
          },
        };
        return {
          spec: {
            model: null as any,
            tools: {},
            maxSteps: 10,
            maxTokens: 4096,
            system: 'task system prompt',
            messages: baseMessages,
            prepareStep: (() => undefined) as any,
            hooks: [wrapped],
          },
          hookFires: fires,
        };
      },
    },
    {
      id: 'tool-wrapper',
      description: 'src/tools/tool-wrapper-run.ts — repair + outputHook + optional prepareStep.',
      build: () => {
        const fires: Array<{ hookId: string; payloadKeys: string[] }> = [];
        return {
          spec: {
            model: null as any,
            tools: {},
            maxSteps: 8,
            maxTokens: 4096,
            system: 'wrapper system prompt',
            messages: baseMessages,
            prepareStep: (() => undefined) as any,
            repair: (() => undefined) as any,
            hooks: [makeRecordingHook('output(wrap:1)', fires)],
          },
          hookFires: fires,
        };
      },
    },
    {
      id: 'subagent-initial',
      description: 'src/tools/subagent.ts — initial call, shared outputHook("sub:1").',
      build: () => {
        const fires: Array<{ hookId: string; payloadKeys: string[] }> = [];
        return {
          spec: {
            model: null as any,
            tools: {},
            maxSteps: 12,
            maxTokens: 4096,
            system: 'subagent system prompt',
            messages: baseMessages,
            prepareStep: (() => undefined) as any,
            repair: (() => undefined) as any,
            hooks: [makeRecordingHook('output(sub:1)', fires)],
          },
          hookFires: fires,
        };
      },
    },
    {
      id: 'subagent-pac-retry',
      description: 'src/tools/subagent.ts — PAC retry shares same hook instance.',
      build: () => {
        const fires: Array<{ hookId: string; payloadKeys: string[] }> = [];
        return {
          spec: {
            model: null as any,
            tools: {},
            maxSteps: 10,
            maxTokens: 4096,
            system: 'subagent system prompt',
            messages: [
              ...baseMessages,
              { role: 'assistant' as const, content: 'first attempt' },
              { role: 'user' as const, content: 'critic feedback' },
            ],
            prepareStep: (() => undefined) as any,
            repair: (() => undefined) as any,
            hooks: [makeRecordingHook('output(sub:1)', fires)],
          },
          hookFires: fires,
        };
      },
    },
    {
      id: 'specialist-initial',
      description: 'src/tools/specialist-run.ts — initial call, outputHook("spec:1") + repair + prepareStep.',
      build: () => {
        const fires: Array<{ hookId: string; payloadKeys: string[] }> = [];
        return {
          spec: {
            model: null as any,
            tools: {},
            maxSteps: 15,
            maxTokens: 4096,
            system: 'specialist system prompt',
            messages: baseMessages,
            prepareStep: (() => undefined) as any,
            repair: (() => undefined) as any,
            hooks: [makeRecordingHook('output(spec:1)', fires)],
          },
          hookFires: fires,
        };
      },
    },
    {
      id: 'main-agent',
      description: 'src/agent.ts — tokenStatsHook + outputHook() + repair.',
      build: () => {
        const fires: Array<{ hookId: string; payloadKeys: string[] }> = [];
        const tokenTarget = { lastStepPromptTokens: 0, spinnerStats: null as any };
        const tokens = tokenStatsHook(tokenTarget);
        const print = outputHook();
        const wrappedTokens = {
          onStepFinish: (payload: any) => {
            fires.push({ hookId: 'token-stats', payloadKeys: Object.keys(payload).sort() });
            return tokens.onStepFinish?.(payload);
          },
        };
        const wrappedPrint = {
          onStepFinish: (payload: any) => {
            fires.push({ hookId: 'output()', payloadKeys: Object.keys(payload).sort() });
            return print.onStepFinish?.(payload);
          },
        };
        return {
          spec: {
            model: null as any,
            providerOptions: undefined,
            tools: {},
            maxSteps: 25,
            maxTokens: 4096,
            system: 'main agent system prompt',
            messages: baseMessages,
            repair: (() => undefined) as any,
            hooks: [wrappedTokens, wrappedPrint],
          },
          hookFires: fires,
        };
      },
    },
  ];

  function serializeSpec(spec: AnyAgentSpec): unknown {
    return {
      model: '<RecordingMockLanguageModelV1>',
      providerOptions: spec.providerOptions ?? null,
      tools: spec.tools ? Object.keys(spec.tools).sort() : null,
      maxSteps: spec.maxSteps ?? null,
      maxTokens: spec.maxTokens ?? null,
      system: spec.system ?? null,
      messages: spec.messages,
      abortSignalPresent: Boolean(spec.abortSignal),
      prepareStepPresent: Boolean(spec.prepareStep),
      repairPresent: Boolean(spec.repair),
      hookCount: spec.hooks?.length ?? 0,
    };
  }

  const records: ScenarioRecord[] = [];

  for (const scenario of SCENARIOS) {
    const { spec, hookFires } = scenario.build();
    const calls: RecordedCall[] = [];

    const model = new MockLanguageModelV1({
      provider: 'parity-recorder',
      modelId: 'parity-mock-v1',
      doGenerate: async (options: any) => {
        calls.push({
          callIndex: calls.length,
          inputFormat: options.inputFormat,
          mode: options.mode,
          prompt: options.prompt,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          topP: options.topP,
          topK: options.topK,
          presencePenalty: options.presencePenalty,
          frequencyPenalty: options.frequencyPenalty,
          stopSequences: options.stopSequences,
          responseFormat: options.responseFormat,
          seed: options.seed,
          providerMetadata: options.providerMetadata,
          abortSignalPresent: Boolean(options.abortSignal),
          headers: options.headers,
        });
        return {
          finishReason: 'stop' as const,
          usage: { promptTokens: 7, completionTokens: 11 },
          text: 'parity-mock-output',
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });

    spec.model = model as any;

    try {
      await runAgent(spec);
    } catch (err) {
      records.push({
        id: scenario.id,
        description: scenario.description,
        spec: serializeSpec(spec),
        calls,
        hookFires,
      });
      console.error(`Scenario ${scenario.id} threw: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    records.push({
      id: scenario.id,
      description: scenario.description,
      spec: serializeSpec(spec),
      calls,
      hookFires,
    });
  }

  const snapshot = {
    harnessVersion: 1,
    scenarios: records,
  };
  const json = JSON.stringify(snapshot, null, 2);

  const outPath = process.env.BERNARD_EVAL_OUT;
  if (outPath) {
    fs.writeFileSync(outPath, json + '\n');
    console.error(`Snapshot written to ${outPath}`);
  } else {
    process.stdout.write(json + '\n');
  }

  const baselinePath = process.env.BERNARD_EVAL_BASELINE;
  if (baselinePath) {
    if (!fs.existsSync(baselinePath)) {
      console.error(`Baseline not found: ${baselinePath}`);
      process.exit(3);
    }
    const baseline = fs.readFileSync(baselinePath, 'utf-8').trimEnd();
    if (baseline !== json) {
      console.error(`PARITY DRIFT detected vs ${baselinePath}`);
      process.exit(1);
    }
    console.error(`Parity OK vs ${baselinePath}`);
  }
}

main().catch((err) => {
  console.error('Parity harness crashed:', err);
  process.exit(1);
});
