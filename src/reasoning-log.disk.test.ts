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
  it('rotates on append rather than growing forever', async () => {
    // The writer owns rotation — `apps/invocation-log.ts` states the rule, and
    // `apps/invoke.ts` / `apps/capability-log.ts` are the two loggers that
    // already follow it. This one had a rotate function nothing called.
    const { appendReasoningLog, TOOL_WRAPPER_LOG } = await load();
    for (let i = 0; i < 2100; i++) appendReasoningLog(at(i));
    expect(lineCount(TOOL_WRAPPER_LOG)).toBeLessThanOrEqual(2000);
  });

  it('keeps the NEWEST entries when it rotates', async () => {
    const { appendReasoningLog, readReasoningLog, TOOL_WRAPPER_LOG } = await load();
    for (let i = 0; i < 2100; i++) appendReasoningLog(at(i, { input: `run-${i}` }));
    expect(lineCount(TOOL_WRAPPER_LOG)).toBeLessThanOrEqual(2000);
    expect(readReasoningLog(1).at(-1)?.input).toBe('run-2099');
  });

  it('caps a field so one entry cannot dwarf the rows around it', async () => {
    // The row budget is a COUNT, which is `apps/invoke.ts`'s stated reason for
    // its own per-field cap. `finalOutput` is a whole dispatch's answer.
    const { appendReasoningLog, readReasoningLog } = await load();
    appendReasoningLog(at(1, { finalOutput: 'x'.repeat(50_000), error: 'y'.repeat(50_000) }));
    const entry = readReasoningLog(1)[0];
    expect(String(entry.finalOutput).length).toBeLessThan(3000);
    expect(entry.error!.length).toBeLessThan(3000);
  });

  it('leaves a structured finalOutput structured', async () => {
    // Guards the guard: the cap is on TEXT. A JSON result must survive as JSON
    // or the log stops being replayable, which is what it exists for.
    const { appendReasoningLog, readReasoningLog } = await load();
    appendReasoningLog(at(1, { finalOutput: { status: 'ok', rows: 3 } }));
    expect(readReasoningLog(1)[0].finalOutput).toEqual({ status: 'ok', rows: 3 });
  });
});

describe('reading since a cursor', () => {
  it('returns everything after it, however many entries precede it', async () => {
    // The property a tail read cannot have. With a fixed window, entries
    // between the cursor and the window's start are dropped silently — which is
    // what `specialist-recall:window-truncated` was reporting without being
    // able to recover.
    const { appendReasoningLog, readReasoningLogSince } = await load();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 1500; i++) appendReasoningLog(at(base + i * 1000, { input: `run-${i}` }));
    const since = readReasoningLogSince(base + 1496 * 1000);
    expect(since.map((e) => e.input)).toEqual(['run-1497', 'run-1498', 'run-1499']);
  });

  it('returns nothing when the cursor is at the end', async () => {
    const { appendReasoningLog, readReasoningLogSince } = await load();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    appendReasoningLog(at(base));
    expect(readReasoningLogSince(base)).toEqual([]);
  });

  it('keeps an entry whose timestamp will not parse', async () => {
    // On an append-only log the only thing worse than re-reading an entry is
    // not reading it, so an unparseable `ts` must not read as "old".
    const { appendReasoningLog, readReasoningLogSince } = await load();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    appendReasoningLog(at(base, { ts: 'not-a-date' }));
    expect(readReasoningLogSince(base + 10_000)).toHaveLength(1);
  });

  it('returns [] rather than throwing when the log does not exist', async () => {
    const { readReasoningLogSince } = await load();
    expect(readReasoningLogSince(0)).toEqual([]);
  });
});
