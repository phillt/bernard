import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The linking end to end through the REAL logger: nested scopes stamp every
 * row, and the builder reassembles the tree from nothing but those stamps.
 */
describe('trace linking through debugLog', () => {
  let home: string;
  const saved = { ...process.env };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-trace-'));
    process.env.BERNARD_HOME = home;
    process.env.BERNARD_DEBUG = '1';
  });
  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('stamps turn, dispatch, parent and tool call, and the tree rebuilds', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const { debugLog, getSessionLogPath } = await import('../logger.js');
    const ctx = await import('../framework/dispatch-context.js');
    const { buildTraces, summarizeTurn } = await import('./build.js');
    const { readLogRows } = await import('./cli.js');
    const tick = () => new Promise((r) => setTimeout(r, 5));

    await ctx.runWithTurn('turn-1', async () => {
      debugLog('turn:start', { inputPreview: 'hi' });
      await ctx.runWithDispatchId('d-main', async () => {
        debugLog('agent:dispatch:start', { dispatchId: 'd-main', site: 'main' });
        await ctx.runWithToolCall('call-1', async () => {
          debugLog('tool:call:start', { tool: 'subagent' });
          await ctx.runWithDispatchId('d-child', async () => {
            debugLog('agent:dispatch:start', { dispatchId: 'd-child', site: 'sub' });
            // Two tool calls at once, as one step's calls run.
            await Promise.all(
              ['a', 'b'].map((t) =>
                ctx.runWithToolCall(`call-${t}`, async () => {
                  debugLog('tool:call:start', { tool: t });
                  await tick();
                  debugLog('tool:execute:end', { tool: t, durationMs: 5 });
                  debugLog('tool:call:end', { tool: t, ok: true });
                }),
              ),
            );
            debugLog('agent:dispatch:end', { dispatchId: 'd-child' });
          });
          debugLog('tool:call:end', { tool: 'subagent', ok: true });
        });
        debugLog('agent:dispatch:end', { dispatchId: 'd-main' });
      });
    });

    const rows = readLogRows(getSessionLogPath());
    const child = rows.find(
      (r) => r.label === 'agent:dispatch:start' && r.data?.dispatchId === 'd-child',
    )!;
    expect(child.trace).toEqual({
      turnId: 'turn-1',
      dispatchId: 'd-child',
      parentDispatchId: 'd-main',
      parentToolCallId: 'call-1',
    });

    const [turn] = buildTraces(rows);
    const main = turn.children[0];
    const sub = main.children[0];
    expect(sub.name).toBe('subagent');
    const childDispatch = sub.children[0];
    expect(childDispatch.name).toBe('sub');
    expect(childDispatch.children.map((c) => c.name).sort()).toEqual(['a', 'b']);
    // Ran together, so not reported as a serial step.
    expect(summarizeTurn(turn).serialGroups).toEqual([]);
  });

  it('a new turn inherits nothing from the one it was started inside', async () => {
    const ctx = await import('../framework/dispatch-context.js');
    ctx.runWithTurn('turn-1', () =>
      ctx.runWithDispatchId('d', () =>
        ctx.runWithToolCall('c', () =>
          ctx.runWithTurn('turn-2', () => {
            expect(ctx.getTraceContext()).toEqual({ turnId: 'turn-2' });
          }),
        ),
      ),
    );
  });
});
