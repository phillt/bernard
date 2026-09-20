import { describe, it, expect } from 'vitest';
import {
  TOOL_RESULT_OUTPUT_TARGET,
  normalizeToolResultPart,
  replaceToolResultOutput,
  toolResultOutputType,
  unwrapToolResultOutput,
} from './tool-result-output.js';

const v4Part = (result: unknown) => ({
  type: 'tool-result' as const,
  toolCallId: 'call-1',
  toolName: 'shell',
  result,
});

const ERROR_TYPES: ReadonlySet<string> = new Set(['error-text', 'error-json']);

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

  it('cannot have its `output`-writing branch exercised on the installed SDK', () => {
    // Stated rather than pretended-covered. That branch is the bump's target
    // and is reachable only by flipping `TOOL_RESULT_OUTPUT_TARGET`, which no
    // test may do — the constant is what every other assertion here is
    // relative to. The READ half of the v5 shape is covered above; the WRITE
    // half is not, and this is the test that says so out loud so a coverage
    // report is not mistaken for a guarantee.
    expect(TOOL_RESULT_OUTPUT_TARGET).toBe('result');
  });

  it('returns the input BY REFERENCE when nothing needs changing', () => {
    // This is the cost claim, not a nicety: `truncateToolResults` promises the
    // same array back when it truncated nothing, and `HistoryStore.load`
    // promises to allocate nothing for a file already in the target shape.
    const part = v4Part('same');
    expect(replaceToolResultOutput(part, 'same')).toBe(part);
  });
});

describe('the v5 output vocabulary round-trips', () => {
  // `LanguageModelV2ToolResultOutput` has FIVE members. Covering only `json`
  // — one of the two that happen to be lossless — is what let a downgrade that
  // reclassified `error-text` as `text` pass: a tool failure shown to the model
  // as a success, made permanent by the next save.
  const ROUND_TRIP: Array<[type: string, value: unknown]> = [
    ['text', 'hi'],
    ['json', { a: 1 }],
    ['error-text', 'boom'],
    ['error-json', { err: 1 }],
  ];

  it.each(ROUND_TRIP)('%s survives the downgrade and comes back as itself', (type, value) => {
    // Down: the live direction.
    const down = normalizeToolResultPart(v5Part(type, value)) as Record<string, unknown>;
    expect(unwrapToolResultOutput(down)).toEqual(value);
    expect(down.isError).toBe(ERROR_TYPES.has(type) ? true : undefined);

    // Up: composed from the exported helper, because the `output` arm of
    // `replaceToolResultOutput` is guarded off by the installed target and no
    // test may flip that constant.
    expect(toolResultOutputType(unwrapToolResultOutput(down), down.isError === true)).toBe(type);
  });

  it('degrades `content` to `json` — the value survives, the tag does not', () => {
    // Named rather than fixed: v4's analogue is `experimental_content`, whose
    // element shape genuinely differs, so mapping it is a real conversion. No
    // failure is reclassified, which is why this one is acceptable.
    const value = [{ type: 'text', text: 'hi' }];
    const down = normalizeToolResultPart(v5Part('content', value)) as Record<string, unknown>;
    expect(unwrapToolResultOutput(down)).toEqual(value);
    expect(down.isError).toBeUndefined();
    expect(toolResultOutputType(value, false)).toBe('json');
  });

  it('flags a downgraded failure to the PROVIDER, not just to a later upgrade', () => {
    // `isError` is v4's own channel: `convertToLanguageModelPrompt` forwards it
    // and `@ai-sdk/anthropic` emits `is_error`. Carrying a stray `output` key
    // instead would be recoverable but silent on the wire.
    const down = normalizeToolResultPart(v5Part('error-text', 'boom')) as Record<string, unknown>;
    expect(down.isError).toBe(true);
    expect(down.output).toBeUndefined();
  });

  it('does not invent an error flag for a result that is not one', () => {
    const down = normalizeToolResultPart(v5Part('text', 'fine')) as Record<string, unknown>;
    expect('isError' in down).toBe(false);
  });
});

describe('toolResultOutputType', () => {
  it('maps value shape and the error bit onto the four scalar output types', () => {
    expect(toolResultOutputType('s', false)).toBe('text');
    expect(toolResultOutputType({ a: 1 }, false)).toBe('json');
    expect(toolResultOutputType('s', true)).toBe('error-text');
    expect(toolResultOutputType({ a: 1 }, true)).toBe('error-json');
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
