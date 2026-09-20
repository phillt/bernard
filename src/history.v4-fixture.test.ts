/**
 * `HistoryStore.load` against a real `ai@4` history file (#sdk-boundary).
 *
 * `src/__tests__/fixtures/history-v4.json` is a redacted copy of one — taken
 * from a working install, then every free-text value replaced and every server
 * name generalised, keeping the KEY STRUCTURE byte-for-byte. 30 messages
 * covering every (role, content-shape, part-type, value-type) combination that
 * appeared in the real 324, including the `id` field the SDK's own
 * `response.messages` adds and which `CoreMessage` does not declare.
 *
 * A hand-written fixture would not have found the two things this one did: that
 * `id`, and that a `tool-result`'s `result` is a string, an object AND an array
 * within one file.
 *
 * The property asserted today is IDENTITY — on `ai@4` the migration converts
 * nothing, so `load()` must hand back exactly what is on disk. That is what
 * makes adopting the normalization provably free rather than merely cheap. At
 * the SDK bump the same fixture stops being an identity case and becomes the
 * migration's input, and these assertions are what will say whether it worked.
 *
 * No `node:fs` mock: the file is written into this test file's own isolated
 * `BERNARD_HOME` (`setup-test-home.ts`) and read back through the real path, so
 * the read being exercised is the one production takes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HistoryStore } from './history.js';
import { HISTORY_FILE } from './paths.js';
import { TOOL_RESULT_OUTPUT_TARGET } from './tool-result-output.js';

const FIXTURE_TEXT = fs.readFileSync(
  fileURLToPath(new URL('./__tests__/fixtures/history-v4.json', import.meta.url)),
  'utf-8',
);
const FIXTURE = JSON.parse(FIXTURE_TEXT) as Record<string, unknown>[];

beforeAll(() => {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, FIXTURE_TEXT, 'utf-8');
});

/** Every `tool-result` part in a parsed history, in order. */
function toolResultParts(messages: unknown[]): Record<string, unknown>[] {
  return messages
    .filter(
      (m): m is { content: unknown[] } =>
        m !== null && typeof m === 'object' && Array.isArray((m as { content?: unknown }).content),
    )
    .flatMap((m) => m.content as Record<string, unknown>[])
    .filter((p) => p?.type === 'tool-result');
}

describe('HistoryStore.load against a real ai@4 history', () => {
  it('the fixture really is v4-shaped, or every assertion below is vacuous', () => {
    const parts = toolResultParts(FIXTURE);
    expect(parts.length).toBeGreaterThan(50);
    expect(parts.every((p) => 'result' in p)).toBe(true);
    expect(parts.some((p) => 'output' in p)).toBe(false);
    // The three value kinds the migration has to carry through untouched. A
    // hand-written fixture would have had one.
    const kinds = new Set(parts.map((p) => (Array.isArray(p.result) ? 'array' : typeof p.result)));
    expect(kinds).toEqual(new Set(['string', 'object', 'array']));
  });

  it('round-trips the file byte-for-byte on the installed SDK', () => {
    expect(TOOL_RESULT_OUTPUT_TARGET).toBe('result');
    // Byte equality rather than `toEqual`, because it also pins KEY ORDER: a
    // part rebuilt by `replaceToolResultOutput` would move `result` to the end
    // of its object, which structural equality cannot see.
    expect(JSON.stringify(new HistoryStore().load(), null, 2) + '\n').toBe(FIXTURE_TEXT);
  });

  it('preserves the `id` field the SDK adds and CoreMessage does not declare', () => {
    const loaded = new HistoryStore().load() as unknown as { role: string; id?: string }[];
    const withIds = loaded.filter((m) => m.id !== undefined);
    expect(withIds.length).toBeGreaterThan(0);
    expect(withIds.every((m) => m.role === 'assistant' || m.role === 'tool')).toBe(true);
  });

  it('keeps every tool-result value byte-identical', () => {
    const values = (ms: unknown[]) => toolResultParts(ms).map((p) => JSON.stringify(p.result));
    expect(values(new HistoryStore().load())).toEqual(values(FIXTURE));
  });

  it('converts a history written by a NEWER SDK back to the installed shape', () => {
    // The rollback path, and the only assertion that can see the migration
    // wired into `load` at all: on `ai@4` every other case here is an identity
    // pass, so deleting the `.map(normalizeStoredMessage)` would leave them
    // green. Derived from the same fixture rather than checked in as a second
    // file, so the two cannot drift.
    // All FIVE `LanguageModelV2ToolResultOutput` types, cycled across the
    // parts. Covering only `text`/`json` — the two that happen to be lossless —
    // is what let a downgrade that reclassified `error-text` as `text` pass
    // review-free: a tool failure re-read as a success, made permanent by the
    // next save.
    const OUTPUT_TYPES = ['text', 'json', 'error-text', 'error-json', 'content'];
    const v5 = JSON.parse(FIXTURE_TEXT) as Record<string, unknown>[];
    const assigned: string[] = [];
    toolResultParts(v5).forEach((part, i) => {
      const type = OUTPUT_TYPES[i % OUTPUT_TYPES.length];
      assigned.push(type);
      const value = part.result;
      delete part.result;
      part.output = { type, value };
    });
    expect(new Set(assigned)).toEqual(new Set(OUTPUT_TYPES));
    expect(toolResultParts(v5).every((p) => 'output' in p && !('result' in p))).toBe(true);

    const previous = fs.readFileSync(HISTORY_FILE, 'utf-8');
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(v5, null, 2) + '\n', 'utf-8');
      const loaded = new HistoryStore().load();
      const parts = toolResultParts(loaded);
      expect(parts.length).toBe(toolResultParts(FIXTURE).length);
      expect(parts.every((p) => 'result' in p && !('output' in p))).toBe(true);
      // Values survive the round trip, and so does everything around them.
      const values = (ms: unknown[]) => toolResultParts(ms).map((p) => JSON.stringify(p.result));
      expect(values(loaded)).toEqual(values(FIXTURE));
      expect(parts.map((p) => p.toolName)).toEqual(toolResultParts(FIXTURE).map((p) => p.toolName));
      // The failure bit crosses. `error-*` becomes `isError: true` — v4's own
      // channel, which the SDK forwards to the provider — and nothing else
      // acquires a flag it did not have.
      expect(parts.map((p) => p.isError === true)).toEqual(
        assigned.map((t) => t.startsWith('error-')),
      );
    } finally {
      fs.writeFileSync(HISTORY_FILE, previous, 'utf-8');
    }
  });
});
