import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The linking through the REAL stack: `runAgent` driving the real `streamText`
 * loop, tools wrapped by the real `augmentTools`, and a tool that starts a
 * nested `runAgent` — the sub-agent shape. Nothing here stamps a trace by
 * hand; if the AI SDK dropped the async context on its way into `execute`, the
 * child would come out unparented and this fails.
 */
describe('trace linking through runAgent + augmentTools', () => {
  let home: string;
  const saved = { ...process.env };

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-trace-int-'));
    process.env.BERNARD_HOME = home;
    process.env.BERNARD_DEBUG = '1';
    vi.resetModules();
  });
  afterAll(() => {
    process.env = { ...saved };
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a sub-agent started by a tool hangs off that tool call', async () => {
    const { tool } = await import('ai');
    const { z } = await import('zod');
    const { runAgent } = await import('../framework/runner.js');
    const { augmentTools } = await import('../tools/augment.js');
    const { ToolProfileStore } = await import('../tool-profiles.js');
    const { runWithTurn } = await import('../framework/dispatch-context.js');
    const { getSessionLogPath } = await import('../logger.js');
    const { scriptedModel, toolStep, TEXT_STEP } = await import('../__tests__/scripted-model.js');
    const { buildTraces } = await import('./build.js');
    const { readLogRows } = await import('./cli.js');

    const profileStore = new ToolProfileStore();
    const lookup = augmentTools(
      {
        lookup: tool({
          description: 'look up',
          parameters: z.object({ q: z.string() }),
          execute: async ({ q }) => ({ found: q }),
        }),
      },
      { profileStore },
    );
    const outer = augmentTools(
      {
        subagent: tool({
          description: 'delegate',
          parameters: z.object({ task: z.string() }),
          execute: async ({ task }) => {
            const child = scriptedModel([toolStep('lookup', { q: task }), TEXT_STEP]);
            const r = await runAgent({
              model: child.model,
              tools: lookup,
              maxSteps: 3,
              system: 'child',
              messages: [{ role: 'user', content: task }],
              useStreaming: true,
              traceLabel: { definitionId: 'sub', site: 'sub' },
            });
            return r.text;
          },
        }),
      },
      { profileStore },
    );
    const parent = scriptedModel([toolStep('subagent', { task: 'deploy' }), TEXT_STEP]);

    await runWithTurn('turn-1', () =>
      runAgent({
        model: parent.model,
        tools: outer,
        maxSteps: 3,
        system: 'parent',
        messages: [{ role: 'user', content: 'go' }],
        useStreaming: true,
        traceLabel: { definitionId: 'main', site: 'main' },
      }),
    );

    const [turn] = buildTraces(readLogRows(getSessionLogPath()));
    expect(turn.id).toBe('turn-1');
    const main = turn.children.find((c) => c.kind === 'dispatch')!;
    expect(main.name).toBe('main');
    const sub = main.children.find((c) => c.kind === 'tool')!;
    expect(sub.name).toBe('subagent');
    expect(sub.open).toBeFalsy();
    const child = sub.children.find((c) => c.kind === 'dispatch')!;
    expect(child.name).toBe('sub');
    expect(child.children.filter((c) => c.kind === 'tool').map((c) => c.name)).toEqual(['lookup']);
  });
});
