import { describe, it, expect } from 'vitest';
import {
  TOOL_RESULT_OUTPUT_TARGET,
  normalizeToolResultPart,
  replaceToolResultOutput,
  unwrapToolResultOutput,
} from './tool-result-output.js';

const v4Part = (result: unknown) => ({
  type: 'tool-result' as const,
  toolCallId: 'call-1',
  toolName: 'shell',
  result,
});

const v5Part = (type: string, value: unknown) => ({
  type: 'tool-result' as const,
  toolCallId: 'call-1',
  toolName: 'shell',
  output: { type, value },
});

describe('unwrapToolResultOutput', () => {
  it('reads the v4 slot', () => {
    expect(unwrapToolResultOutput(v4Part('out'))).toBe('out');
    expect(unwrapToolResultOutput(v4Part({ a: 1 }))).toEqual({ a: 1 });
    expect(unwrapToolResultOutput(v4Part([1, 2]))).toEqual([1, 2]);
  });

  it('unwraps the v5 envelope', () => {
    expect(unwrapToolResultOutput(v5Part('text', 'out'))).toBe('out');
    expect(unwrapToolResultOutput(v5Part('json', { a: 1 }))).toEqual({ a: 1 });
  });

  it('returns undefined for a part carrying neither, as every predecessor did', () => {
    // The four readers this replaces each yielded `undefined` here and their
    // callers all handle it (`typeof x === 'string' ? x : JSON.stringify(x)`),
    // so throwing would be a behaviour change on malformed input.
    expect(unwrapToolResultOutput({ type: 'tool-result' })).toBeUndefined();
    expect(unwrapToolResultOutput(null)).toBeUndefined();
    expect(unwrapToolResultOutput('not a part')).toBeUndefined();
  });

  it('keeps an explicit undefined value distinguishable from an absent slot', () => {
    // `'result' in p` rather than `p.result !== undefined`: a tool that really
    // returned `undefined` must not fall through to the envelope branch.
    expect(unwrapToolResultOutput({ type: 'tool-result', result: undefined })).toBeUndefined();
  });

  it('does not unwrap a value that merely looks like an envelope', () => {
    // A tool whose own result is `{type, value}` — `memory` and several MCP
    // servers return exactly this shape — must come back whole.
    const shaped = { type: 'text', value: 'inner' };
    expect(unwrapToolResultOutput(v4Part(shaped))).toEqual(shaped);
  });
});

describe('replaceToolResultOutput', () => {
  it('writes the slot the installed SDK requires', () => {
    expect(TOOL_RESULT_OUTPUT_TARGET).toBe('result');
    expect(replaceToolResultOutput(v4Part('old'), 'new')).toEqual(v4Part('new'));
  });

  it('preserves every other field, including ones the SDK type does not declare', () => {
    const part = { ...v4Part('old'), isError: true, providerMetadata: { x: 1 } };
    expect(replaceToolResultOutput(part, 'new')).toEqual({ ...part, result: 'new' });
  });

  it('converts a v5-shaped part to the installed shape', () => {
    // The rollback path: a history written by a bumped Bernard has to stay
    // readable by an older one.
    expect(replaceToolResultOutput(v5Part('text', 'old'), 'new')).toEqual(v4Part('new'));
  });

  it('returns the input BY REFERENCE when nothing needs changing', () => {
    // This is the cost claim, not a nicety: `truncateToolResults` promises the
    // same array back when it truncated nothing, and `HistoryStore.load`
    // promises to allocate nothing for a file already in the target shape.
    const part = v4Part('same');
    expect(replaceToolResultOutput(part, 'same')).toBe(part);
  });
});

describe('normalizeToolResultPart', () => {
  it('is identity, by reference, for a part already in the target shape', () => {
    const part = v4Part('out');
    expect(normalizeToolResultPart(part)).toBe(part);
  });

  it('leaves a non-tool-result part alone', () => {
    const text = { type: 'text', text: 'hello' };
    expect(normalizeToolResultPart(text)).toBe(text);
  });

  it('migrates a v5-shaped part into the installed shape', () => {
    expect(normalizeToolResultPart(v5Part('json', { a: 1 }))).toEqual(v4Part({ a: 1 }));
  });
});
