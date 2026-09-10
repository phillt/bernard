import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { useTempHome } from './__tests__/temp-home.js';
import type { ReasoningLogEntry } from './reasoning-log.js';

/**
 * The reasoning log against a real filesystem.
 *
 * Its own file because the main suite mocks `node:fs`, and the two properties
 * under test — the file stays bounded, and a reader with a cursor sees
 * everything since that cursor — are exactly the ones a mock cannot express.
 *
 * Both were absent. `rotateReasoningLog` had **no production caller anywhere in
 * the tree**, so the file grew forever (6.7 MB / 2,354 entries on a real
 * install), and `runSpecialistRecall` read it with a fixed 500-entry tail
 * against a timestamp marker — a window, not a queue.
 */
useTempHome('reasoning-log');

async function load() {
  const { vi } = await import('vitest');
  vi.resetModules();
  const mod = await import('./reasoning-log.js');
  const { TOOL_WRAPPER_LOG } = await import('./paths.js');
  return { ...mod, TOOL_WRAPPER_LOG };
}

const at = (ms: number, over: Partial<ReasoningLogEntry> = {}): ReasoningLogEntry => ({
  ts: new Date(ms).toISOString(),
  specialistId: 'coder',
  input: 'do it',
  toolCalls: [],
  finalOutput: 'done',
  status: 'ok',
  ...over,
});

const lineCount = (file: string) =>
  fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).length;

describe('the file stays bounded', () => {
  // `keep` (2,000) plus the 25% slack `appendJsonlBounded` trades for not
  // rewriting the whole file on every append — the naive pairing measured
  // 25.7 ms per write on the real 6.7 MB log, synchronously, on every dispatch.
  const CEILING = 2500;

  it('stays bounded rather than growing forever', async () => {
    // The writer owns rotation — `apps/invocation-log.ts` states the rule, and
    // the two loggers beside it already follow it. This one had a rotate
    // function nothing called.
    const { recordDispatch, TOOL_WRAPPER_LOG } = await load();
    for (let i = 0; i < 3000; i++) recordDispatch(at(i));
    expect(lineCount(TOOL_WRAPPER_LOG)).toBeLessThanOrEqual(CEILING);
  });

  it('stays bounded across many multiples of the budget', async () => {
    // Guards the guard: a one-shot trim would pass the case above and still grow
    // without limit. 6,000 appends is three budgets' worth.
    const { recordDispatch, TOOL_WRAPPER_LOG } = await load();
    for (let i = 0; i < 6000; i++) recordDispatch(at(i));
    expect(lineCount(TOOL_WRAPPER_LOG)).toBeLessThanOrEqual(CEILING);
  });

  it('keeps the NEWEST entries when it trims', async () => {
    const { recordDispatch, readReasoningLog, TOOL_WRAPPER_LOG } = await load();
    for (let i = 0; i < 3000; i++) recordDispatch(at(i, { input: `run-${i}` }));
    expect(lineCount(TOOL_WRAPPER_LOG)).toBeLessThanOrEqual(CEILING);
    expect(readReasoningLog(1).at(-1)?.input).toBe('run-2999');
  });

  it('caps every field, so one entry cannot dwarf the rows around it', async () => {
    // A count budget is only honest if EVERY field is capped, and the first cut
    // capped four of five — it left `toolCalls[].args` out on the argument that
    // the renderer bounds it, which is a PROMPT bound and not a disk one.
    // Measured, `args` is where the mass is: the largest real one is a 15.7 KB
    // `shell` invocation, and a `file_write` carries a whole file.
    const { recordDispatch, readReasoningLog } = await load();
    recordDispatch(
      at(1, {
        finalOutput: 'x'.repeat(50_000),
        error: 'y'.repeat(50_000),
        toolCalls: [
          { tool: 'file_write', args: { content: 'z'.repeat(50_000) }, resultPreview: 'ok' },
        ],
      }),
    );
    const entry = readReasoningLog(1)[0];
    expect(String(entry.finalOutput).length).toBeLessThan(3000);
    expect(entry.error!.length).toBeLessThan(3000);
    expect(JSON.stringify(entry.toolCalls[0].args).length).toBeLessThan(3000);
  });

  it('leaves a small args object structured', async () => {
    // Guards the guard: the cap keeps structure when it fits, or the log stops
    // being replayable — which is what it exists for.
    const { recordDispatch, readReasoningLog } = await load();
    recordDispatch(
      at(1, { toolCalls: [{ tool: 'shell', args: { command: 'ls' }, resultPreview: 'ok' }] }),
    );
    expect(readReasoningLog(1)[0].toolCalls[0].args).toEqual({ command: 'ls' });
  });

  it('leaves a structured finalOutput structured', async () => {
    // Guards the guard: the cap is on TEXT. A JSON result must survive as JSON
    // or the log stops being replayable, which is what it exists for.
    const { recordDispatch, readReasoningLog } = await load();
    recordDispatch(at(1, { finalOutput: { status: 'ok', rows: 3 } }));
    expect(readReasoningLog(1)[0].finalOutput).toEqual({ status: 'ok', rows: 3 });
  });
});

describe('recording a dispatch', () => {
  it('writes the log entry AND the queue item', async () => {
    // One function rather than two calls at each producer, because the pair is
    // what has to stay together: a dispatch in the log and not in the queue is
    // one a specialist never learns from, silently — the class of bug the queue
    // replaces.
    const { recordDispatch, readReasoningLog } = await load();
    const { recallQueue } = await import('./recall-queue.js');
    recordDispatch(at(Date.now(), { input: 'do it' }));
    expect(readReasoningLog(1)[0].input).toBe('do it');
    expect(recallQueue().pending()).toBe(1);
  });

  it('bounds the entry once, for both consumers', async () => {
    const { recordDispatch, readReasoningLog } = await load();
    const { recallQueue } = await import('./recall-queue.js');
    recordDispatch(at(Date.now(), { finalOutput: 'x'.repeat(50_000) }));
    expect(String(readReasoningLog(1)[0].finalOutput).length).toBeLessThan(3000);
    const [item] = recallQueue().claim();
    expect(String(item.payload.finalOutput).length).toBeLessThan(3000);
  });
});

describe('every field is bounded, count included', () => {
  it('caps how many tool calls one entry keeps, and says how many it dropped', async () => {
    // The field the file's own "a count budget is only honest if EVERY field is
    // capped" rule had missed. `input`, `finalOutput` and each `args` were
    // bounded; `toolCalls.length` was not, against a 150-step ceiling — which is
    // what let one dispatch render past the 12,000-char recall budget and starve
    // its own queue.
    const { recordDispatch, readReasoningLog } = await load();
    recordDispatch(
      at(Date.now(), {
        toolCalls: Array.from({ length: 40 }, (_, i) => ({
          tool: `t${i}`,
          args: { i },
          resultPreview: 'ok',
        })),
      }),
    );
    const [entry] = readReasoningLog(1);
    expect(entry.toolCalls).toHaveLength(12);
    expect(entry.droppedToolCalls).toBe(28);
    // The TAIL is kept: this log exists so a failure can be inspected, and the
    // call that failed is the last one.
    expect(entry.toolCalls.at(-1)?.tool).toBe('t39');
  });

  it('says nothing when nothing was dropped', async () => {
    // An absent marker has to mean complete, or a reader cannot tell a short
    // dispatch from a clipped one.
    const { recordDispatch, readReasoningLog } = await load();
    recordDispatch(at(Date.now()));
    expect(readReasoningLog(1)[0].droppedToolCalls).toBeUndefined();
  });
});
