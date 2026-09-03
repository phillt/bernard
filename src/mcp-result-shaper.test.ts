import { describe, it, expect } from 'vitest';
import {
  shapeMCPResult,
  DEFAULT_MCP_RESULT_MAX_CHARS,
  type ShapeStats,
} from './mcp-result-shaper.js';

const off = { mode: 'off' as const, maxChars: 100 };
const cap = (maxChars: number) => ({ mode: 'cap' as const, maxChars });

/**
 * An object whose bulk is spread across many fields, none individually large
 * enough to be worth shrinking. Nothing the structure-aware paths can trim, so
 * this is what genuinely reaches the `{_truncated, preview}` wrapper.
 */
function manySmallFields(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < 500; i++) out[`key_${i}`] = 'v'.repeat(40);
  return out;
}

describe('shapeMCPResult', () => {
  it('mode "off" is a pass-through even for huge results', () => {
    const big = {
      items: Array.from({ length: 500 }, (_, i) => ({ id: i, body: 'x'.repeat(100) })),
    };
    expect(shapeMCPResult(big, off)).toBe(big);
  });

  it('leaves small results untouched (identity, no added work)', () => {
    const small = { content: [{ type: 'text', text: 'hello' }] };
    expect(shapeMCPResult(small, cap(8000))).toBe(small);
    expect(shapeMCPResult('short string', cap(8000))).toBe('short string');
  });

  it('caps a large string to head and tail, naming what it lost', () => {
    // Head AND tail: a result that IS one large string is the case where a
    // head-only slice costs most, which is the general form of #458.
    const out = shapeMCPResult('a'.repeat(25_000) + 'TAILMARK', cap(1000)) as string;
    expect(typeof out).toBe('string');
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).toContain('chars omitted');
    expect(out).toContain('TAILMARK');
  });

  it('caps a large top-level array to a valid, bounded JSON array', () => {
    const arr = Array.from({ length: 200 }, (_, i) => ({ id: i, body: 'z'.repeat(50) }));
    const out = shapeMCPResult(arr, cap(1000));
    expect(Array.isArray(out)).toBe(true);
    // Still valid JSON, bounded, and the last element flags the omission.
    const serialized = JSON.stringify(out);
    expect(serialized.length).toBeLessThanOrEqual(1000 + 64);
    expect(JSON.parse(serialized)).toBeTruthy(); // never mid-token invalid
    const last = (out as unknown[])[(out as unknown[]).length - 1];
    expect(String(last)).toContain('more items omitted');
  });

  it('truncates the dominant array field of an object while keeping other fields', () => {
    const result = {
      total: 200,
      nextPageToken: 'abc',
      messages: Array.from({ length: 200 }, (_, i) => ({ id: i, snippet: 'w'.repeat(60) })),
    };
    const out = shapeMCPResult(result, cap(1200)) as any;
    // Small sibling fields survive; the big array is bounded.
    expect(out.total).toBe(200);
    expect(out.nextPageToken).toBe('abc');
    expect(Array.isArray(out.messages)).toBe(true);
    expect(out.messages.length).toBeLessThan(200);
    const serialized = JSON.stringify(out);
    expect(serialized.length).toBeLessThanOrEqual(1200 + 128);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  // Was a wrapper case before #458. `capArray` still refuses to drop the first
  // element, so the array path still comes back over budget — but the recursive
  // shrink now reaches INSIDE that element and cuts `body`, which keeps the
  // array (and every sibling's `id`) instead of replacing the lot with a
  // preview. The re-check this was written to pin is still the thing under
  // test; what changed is which fallback it reaches.
  it('shrinks inside a leading element that alone exceeds budget, keeping the array', () => {
    const arr = [{ id: 0, body: 'q'.repeat(5000) }, { id: 1 }, { id: 2 }];
    const out = shapeMCPResult(arr, cap(500)) as any;
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].id).toBe(0);
    expect(out[1]).toEqual({ id: 1 });
    expect(out[2]).toEqual({ id: 2 });
    expect(out[0].body.length).toBeLessThan(5000);
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(500);
  });

  // The wrapper is still reachable, and still has to be: a payload made only of
  // fields too small to be worth shrinking individually cannot be brought under
  // budget by shrinking any one of them. This is the fixture the three #363
  // wrapper properties below are pinned on.
  it('still falls back to the wrapper when no single field is worth shrinking', () => {
    const out = shapeMCPResult(manySmallFields(), cap(800)) as any;
    expect(out._truncated).toBe(true);
    expect(typeof out.preview).toBe('string');
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(800);
  });

  it('keeps the wrapper under budget even when the preview is escape-heavy', () => {
    // A payload dominated by quotes/backslashes: each char is escaped when the
    // preview string is embedded in the wrapper, roughly doubling its encoded
    // length. Budgeting the raw preview alone would let the wrapper overshoot;
    // the shrink loop must re-measure the *encoded* wrapper and stay bounded.
    const result: Record<string, string> = {};
    for (let i = 0; i < 500; i++) result[`k${i}`] = '"\\'.repeat(40);
    const out = shapeMCPResult(result, cap(800)) as any;
    expect(out._truncated).toBe(true);
    const serialized = JSON.stringify(out);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized.length).toBeLessThanOrEqual(800);
  });

  it('leaves primitive results alone', () => {
    expect(shapeMCPResult(42, cap(1))).toBe(42);
    expect(shapeMCPResult(true, cap(1))).toBe(true);
    expect(shapeMCPResult(null, cap(1))).toBe(null);
  });

  // #363: an over-budget failure must never arrive downstream looking like a
  // success. Asserted on BOTH paths, because they preserve the flag by
  // different mechanisms and only one of them was ever covered: the shrink
  // path carries `isError` along with every other field for free, while the
  // wrapper replaces the envelope wholesale and has to re-stamp it explicitly.
  it('keeps isError when the shrink path preserves the structure', () => {
    const huge = { isError: true, detail: 'x'.repeat(5000), note: 'y'.repeat(5000) };
    const shaped = shapeMCPResult(huge, { mode: 'cap', maxChars: 500 }) as Record<string, unknown>;
    expect(shaped.isError).toBe(true);
    expect(JSON.stringify(shaped).length).toBeLessThanOrEqual(500);
  });

  it('keeps isError on a failing MCP result that falls back to the wrapper', () => {
    const huge = { isError: true, ...manySmallFields() };
    const shaped = shapeMCPResult(huge, { mode: 'cap', maxChars: 800 }) as Record<string, unknown>;
    expect(shaped._truncated).toBe(true);
    expect(shaped.isError).toBe(true);
  });

  it('does not invent isError on a large successful result', () => {
    const shaped = shapeMCPResult(manySmallFields(), {
      mode: 'cap',
      maxChars: 800,
    }) as Record<string, unknown>;
    expect(shaped._truncated).toBe(true);
    expect(shaped.isError).toBeUndefined();
  });

  it('exposes a sane default budget', () => {
    expect(DEFAULT_MCP_RESULT_MAX_CHARS).toBeGreaterThan(1000);
  });
});

/**
 * #458. The shape production actually hands the shaper — `{content: [{type:
 * 'text', text: '<json>'}]}` — which no test covered over budget, so every
 * structure-aware assertion above was made against an already-parsed object the
 * shaper never sees in the wild.
 *
 * The payload is a Gmail `messages.get?format=full`: kilobytes of `Received` /
 * `ARC-Seal` / `DKIM-Signature` noise, then the four headers a person actually
 * reads, then a base64 body blob. Bernard reported that a CC it had sent was
 * dropped, and sent a duplicate email to fix it, because the front-slicing
 * wrapper cut everything after the noise.
 */
function smtpNoise(n: number) {
  const names = ['Received', 'ARC-Seal', 'ARC-Message-Signature', 'DKIM-Signature'];
  return Array.from({ length: n }, (_, i) => ({
    name: names[i % names.length],
    value: 'x'.repeat(180),
  }));
}

function gmailMessage() {
  return {
    id: '18f0',
    threadId: '18f0',
    labelIds: ['INBOX'],
    snippet: 'Following up on the sync',
    sizeEstimate: 48211,
    payload: {
      mimeType: 'multipart/alternative',
      // Nested, which is the whole point: `largestArrayKey` is top-level only,
      // so it finds `labelIds` and nothing else.
      headers: [
        ...smtpNoise(30),
        { name: 'From', value: 'phill@example.com' },
        { name: 'To', value: 'jeff@example.com' },
        { name: 'Cc', value: 'kevin@example.com' },
        { name: 'Subject', value: 'ARMOR on NEXT testing sync' },
      ],
      // The real bulk, and also nested.
      parts: [{ mimeType: 'text/html', body: { size: 20000, data: 'QUJD'.repeat(5000) } }],
    },
  };
}

/** The text the model is actually shown, envelope unwrapped. */
function visibleText(out: unknown): string {
  const entry = (out as any)?.content?.[0]?.text;
  return typeof entry === 'string' ? entry : JSON.stringify(out);
}

describe('shapeMCPResult — MCP text envelopes (#458)', () => {
  it('keeps To, Cc and Subject on an over-budget Gmail format:full read', () => {
    const enveloped = { content: [{ type: 'text', text: JSON.stringify(gmailMessage()) }] };
    const out = shapeMCPResult(enveloped, cap(8000));
    const visible = visibleText(out);

    // The headers, not merely "some output" — this is the assertion that fails
    // on the pre-#458 shaper.
    expect(visible).toContain('"From"');
    expect(visible).toContain('"To"');
    expect(visible).toContain('"Cc"');
    expect(visible).toContain('"Subject"');
    expect(visible).toContain('kevin@example.com');

    // Still a valid envelope carrying valid JSON, and still bounded.
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(8000);
    expect(() => JSON.parse(visible)).not.toThrow();
  });

  it('spends the base64 body blob rather than the headers', () => {
    const enveloped = { content: [{ type: 'text', text: JSON.stringify(gmailMessage()) }] };
    const payload = JSON.parse(visibleText(shapeMCPResult(enveloped, cap(8000))));
    // Every header survives; the blob is what paid for them.
    expect(payload.payload.headers).toHaveLength(34);
    expect(payload.payload.parts[0].body.data.length).toBeLessThan(20000);
  });

  it('reports what it cut through the observer', () => {
    const enveloped = { content: [{ type: 'text', text: JSON.stringify(gmailMessage()) }] };
    const seen: ShapeStats[] = [];
    shapeMCPResult(enveloped, cap(8000), (st) => seen.push(st));
    expect(seen).toHaveLength(1);
    expect(seen[0].unwrapped).toBe(true);
    expect(seen[0].strategy).toBe('shrink');
    expect(seen[0].rawChars).toBeGreaterThan(20000);
    expect(seen[0].keptChars).toBeLessThanOrEqual(8000);
  });

  it('does not fire the observer for a result that fits', () => {
    const seen: ShapeStats[] = [];
    shapeMCPResult({ content: [{ type: 'text', text: '{"ok":true}' }] }, cap(8000), (st) =>
      seen.push(st),
    );
    expect(seen).toHaveLength(0);
  });

  it('leaves a non-JSON text entry to the ordinary paths', () => {
    // Plenty of servers return prose. Parsing is not the point, so a text entry
    // that is not JSON must not be mangled into one.
    const prose = { content: [{ type: 'text', text: 'a'.repeat(20000) }] };
    const out = shapeMCPResult(prose, cap(2000)) as any;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(2000 + 64);
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });

  it('leaves a multi-entry content array alone', () => {
    // Several values whose relative importance this module cannot know; the
    // ordinary paths handle it rather than inventing one.
    const multi = {
      content: [
        { type: 'text', text: JSON.stringify({ a: 'x'.repeat(9000) }) },
        { type: 'text', text: JSON.stringify({ b: 'y'.repeat(9000) }) },
      ],
    };
    const seen: ShapeStats[] = [];
    const out = shapeMCPResult(multi, cap(2000), (st) => seen.push(st));
    expect(seen[0].unwrapped).toBe(false);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(2000 + 64);
  });

  it('keeps isError on an over-budget enveloped failure', () => {
    const failing = {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ detail: 'x'.repeat(20000) }) }],
    };
    const out = shapeMCPResult(failing, cap(2000)) as Record<string, unknown>;
    expect(out.isError).toBe(true);
  });
});

describe('shapeMCPResult — termination guards', () => {
  it('never throws on a value structuredClone refuses', () => {
    // `JSON.stringify` drops a function silently, so this measures finite,
    // clears the cycle guard, and reaches `structuredClone`. A throw here lands
    // in `mcp.ts`'s reconnect catch and tears down a healthy stdio connection.
    const withFn = { keep: 'a', blob: 'x'.repeat(20_000), fn: () => 1 };
    const out = shapeMCPResult(withFn, cap(500)) as any;
    expect(out._truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(500);
  });

  it('bounds a cyclic result instead of walking it', () => {
    const cyclic: Record<string, unknown> = { big: 'x'.repeat(20000) };
    cyclic.self = cyclic;
    const out = shapeMCPResult(cyclic, cap(500)) as any;
    expect(out._truncated).toBe(true);
  });

  it('bounds a deeply nested payload', () => {
    let deep: Record<string, unknown> = { leaf: 'x'.repeat(20000) };
    for (let i = 0; i < 20; i++) deep = { [`d${i}`]: deep };
    const out = shapeMCPResult(deep, cap(800));
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(800 + 64);
  });

  it('does not mutate the caller\u2019s result', () => {
    // The under-budget path returns the input by identity, so every caller is
    // entitled to assume shaping is non-destructive.
    const input = { isError: true, detail: 'x'.repeat(5000), note: 'y'.repeat(5000) };
    const before = structuredClone(input);
    shapeMCPResult(input, cap(500));
    expect(input).toEqual(before);
  });

  it('does not write through a __proto__ key from a server payload', () => {
    // MCP output is untrusted and `JSON.parse` \u2014 which the envelope unwrap runs
    // on the server's own text \u2014 makes `__proto__` a genuine own property,
    // unlike an object literal. The walk must refuse it as a slot.
    const hostile = `{"__proto__":{"pad":"${'p'.repeat(20000)}"},"filler":"${'x'.repeat(20000)}"}`;
    const out = shapeMCPResult({ content: [{ type: 'text', text: hostile }] }, cap(800));
    expect((Object.prototype as Record<string, unknown>).pad).toBeUndefined();
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(800 + 64);
  });

  it('never exceeds the budget across a sweep of sizes and budgets', () => {
    // The cap is a contract, not a target. `truncatedString` keeps its own
    // marker inside the budget it is handed — which is what let `shrinkLargest`
    // drop the hand-tuned `- 40` allowance that used to stand in for it.
    const over: string[] = [];
    for (let budget = 100; budget <= 3000; budget += 7) {
      for (const n of [500, 5000, 100_000]) {
        const out = shapeMCPResult({ meta: 1, blob: 'x'.repeat(n) }, cap(budget));
        const len = JSON.stringify(out).length;
        if (len > budget) over.push(`budget=${budget} n=${n} -> ${len}`);
      }
    }
    expect(over).toEqual([]);
  });

  it('bounds a large array of scalars', () => {
    const out = shapeMCPResult(
      Array.from({ length: 5000 }, (_, i) => i),
      cap(500),
    );
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(500 + 64);
  });
});
