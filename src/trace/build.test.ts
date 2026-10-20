import { describe, it, expect } from 'vitest';
import { buildTraces, summarizeTurn, type LogRow } from './build.js';
import { renderSummary, renderTurn } from './render.js';

const T0 = Date.parse('2026-10-20T20:00:00.000Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const row = (
  ms: number,
  label: string,
  trace: LogRow['trace'],
  data: Record<string, unknown> = {},
): LogRow => ({
  timestamp: at(ms),
  label,
  trace,
  data,
});

/**
 * The shape of a real email-check turn: pre-turn passes, the main agent, a
 * delegate tool whose helper runs two MCP calls in one step, then answers.
 */
function emailTurn(): LogRow[] {
  const turn = { turnId: 'turn-1' };
  const main = { ...turn, dispatchId: 'main1' };
  const del = { ...main, toolCallId: 'call_del' };
  const helper = {
    ...turn,
    dispatchId: 'help1',
    parentDispatchId: 'main1',
    parentToolCallId: 'call_del',
  };
  return [
    row(0, 'llm:end', turn, { site: 'reference-resolver', model: 'm', durationMs: 900 }),
    row(1500, 'llm:end', turn, { site: 'rewriter', model: 'm', durationMs: 600 }),
    row(1600, 'turn:start', turn, { inputPreview: 'check my work email' }),
    row(1700, 'agent:dispatch:start', main, { dispatchId: 'main1', site: 'main', model: 'grok' }),
    row(1710, 'http:request:start', main, { reqId: 'r1', host: 'api.x.ai', dispatchId: 'main1' }),
    row(10_000, 'http:response:end', main, { reqId: 'r1' }),
    row(10_010, 'tool:call:start', del, { tool: 'delegate_google' }),
    row(10_020, 'agent:dispatch:start', helper, {
      dispatchId: 'help1',
      site: 'mcp:google',
      model: 'fast',
    }),
    row(10_030, 'http:request:start', helper, {
      reqId: 'r2',
      host: 'api.x.ai',
      dispatchId: 'help1',
    }),
    row(11_600, 'http:response:end', helper, { reqId: 'r2' }),
    // Two MCP calls in one step that ran one AFTER the other.
    row(11_610, 'tool:call:start', { ...helper, toolCallId: 'c_a' }, { tool: 'gmail_list' }),
    row(11_610, 'tool:call:start', { ...helper, toolCallId: 'c_b' }, { tool: 'gmail_modify' }),
    row(
      12_600,
      'tool:execute:end',
      { ...helper, toolCallId: 'c_a' },
      { tool: 'gmail_list', durationMs: 990 },
    ),
    row(
      12_600,
      'tool:call:end',
      { ...helper, toolCallId: 'c_a' },
      { tool: 'gmail_list', durationMs: 990, ok: true },
    ),
    row(
      17_500,
      'tool:execute:end',
      { ...helper, toolCallId: 'c_b' },
      { tool: 'gmail_modify', durationMs: 4900 },
    ),
    row(
      17_500,
      'tool:call:end',
      { ...helper, toolCallId: 'c_b' },
      { tool: 'gmail_modify', durationMs: 5890, ok: true },
    ),
    // A step ends after its tools finish, as the SDK reports it.
    row(17_505, 'step:end', helper, { dispatchId: 'help1', n: 1 }),
    row(17_510, 'http:request:start', helper, {
      reqId: 'r3',
      host: 'api.x.ai',
      dispatchId: 'help1',
    }),
    row(20_000, 'http:response:end', helper, { reqId: 'r3' }),
    row(20_005, 'step:end', helper, { dispatchId: 'help1', n: 2 }),
    row(20_010, 'agent:dispatch:end', helper, { dispatchId: 'help1' }),
    row(20_020, 'tool:execute:end', del, { tool: 'delegate_google', durationMs: 10_000 }),
    row(20_020, 'tool:call:end', del, { tool: 'delegate_google', durationMs: 10_010, ok: true }),
    row(20_030, 'http:request:start', main, { reqId: 'r4', host: 'api.x.ai', dispatchId: 'main1' }),
    row(24_000, 'http:response:end', main, { reqId: 'r4' }),
    row(24_010, 'agent:dispatch:end', main, { dispatchId: 'main1' }),
  ];
}

describe('buildTraces', () => {
  it('nests a helper agent under the tool call that started it', () => {
    const [turn] = buildTraces(emailTurn());
    expect(turn.id).toBe('turn-1');
    expect(turn.preview).toBe('check my work email');
    const main = turn.children.find((c) => c.kind === 'dispatch')!;
    expect(main.name).toBe('main');
    const del = main.children.find((c) => c.kind === 'tool')!;
    expect(del.name).toBe('delegate_google');
    const helper = del.children.find((c) => c.kind === 'dispatch')!;
    expect(helper.name).toBe('mcp:google');
    expect(helper.children.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'model:model',
      'tool:gmail_list',
      'tool:gmail_modify',
      'model:model',
    ]);
  });

  it('places pre-turn passes in their turn, outside any agent', () => {
    const [turn] = buildTraces(emailTurn());
    expect(turn.children.filter((c) => c.kind === 'pre-turn').map((c) => c.name)).toEqual([
      'reference-resolver',
      'rewriter',
    ]);
    // The turn starts at the first pass, not at turn:start.
    expect(turn.start).toBe(T0 - 900);
  });

  it('keeps separate turns separate', () => {
    const rows = [
      ...emailTurn(),
      row(30_000, 'turn:start', { turnId: 'turn-2' }, { inputPreview: 'thanks' }),
      row(
        30_100,
        'agent:dispatch:start',
        { turnId: 'turn-2', dispatchId: 'main2' },
        { dispatchId: 'main2', site: 'main' },
      ),
      row(
        31_000,
        'agent:dispatch:end',
        { turnId: 'turn-2', dispatchId: 'main2' },
        { dispatchId: 'main2' },
      ),
    ];
    expect(buildTraces(rows).map((t) => t.id)).toEqual(['turn-1', 'turn-2']);
  });

  it('marks a dispatch that never finished instead of dropping it', () => {
    const rows = emailTurn().filter(
      (r) => !(r.label === 'agent:dispatch:end' && r.data?.dispatchId === 'help1'),
    );
    const [turn] = buildTraces(rows);
    const helper = turn.children[2].children[1].children[0];
    expect(helper.open).toBe(true);
  });

  it('ignores rows written before the trace stamp existed', () => {
    const legacy: LogRow = {
      timestamp: at(0),
      label: 'tool:execute:end',
      data: { tool: 'x', durationMs: 5 },
    };
    expect(buildTraces([legacy])).toEqual([]);
  });
});

describe('summarizeTurn', () => {
  it('splits the time by kind and finds the serial step', () => {
    const s = summarizeTurn(buildTraces(emailTurn())[0]);
    expect(s.preTurnMs).toBe(1500);
    expect(s.modelCalls).toBe(4);
    expect(s.toolMs.get('gmail_modify')).toEqual({ ms: 4900, calls: 1 });
    // gmail_modify waited ~1 s on the barrier before its 4.9 s ran.
    expect(s.waitMs).toBeGreaterThanOrEqual(990);
    expect(s.serialGroups).toEqual([
      {
        dispatch: 'mcp:google',
        tools: ['gmail_list', 'gmail_modify'],
        serialMs: 5890,
        couldBeMs: 4900,
      },
    ]);
  });

  it('does not call streamed tools serial: the model wrote them in order', () => {
    // Streaming: each tool starts while the model call is still open.
    const rows = emailTurn().map((r) =>
      r.label === 'http:response:end' && r.data?.reqId === 'r2'
        ? { ...r, timestamp: at(17_400) }
        : r,
    );
    expect(summarizeTurn(buildTraces(rows)[0]).serialGroups).toEqual([]);
  });

  it('does not call overlapping work serial', () => {
    const rows = emailTurn().map((r) =>
      r.trace?.toolCallId === 'c_b' && r.label === 'tool:execute:end'
        ? { ...r, data: { ...r.data, durationMs: 5890 } }
        : r,
    );
    expect(summarizeTurn(buildTraces(rows)[0]).serialGroups).toEqual([]);
  });

  it('renders a tree and a summary', () => {
    const turn = buildTraces(emailTurn())[0];
    const tree = renderTurn(turn).join('\n');
    expect(tree).toContain('◆ mcp:google (fast');
    expect(tree).toContain('gmail_modify  [waited 990 ms]');
    const summary = renderSummary(summarizeTurn(turn)).join('\n');
    expect(summary).toContain('gmail_list → gmail_modify');
  });
});
