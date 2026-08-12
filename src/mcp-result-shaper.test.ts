import { describe, it, expect } from 'vitest';
import { shapeMCPResult, DEFAULT_MCP_RESULT_MAX_CHARS } from './mcp-result-shaper.js';

const off = { mode: 'off' as const, maxChars: 100 };
const cap = (maxChars: number) => ({ mode: 'cap' as const, maxChars });

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

  it('caps a large string and stays under budget', () => {
    const out = shapeMCPResult('y'.repeat(50_000), cap(1000)) as string;
    expect(typeof out).toBe('string');
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).toContain('truncated');
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

  it('falls back to a valid {_truncated, preview} wrapper for a huge object with no array to trim', () => {
    const result: Record<string, string> = {};
    for (let i = 0; i < 500; i++) result[`key_${i}`] = 'v'.repeat(40);
    const out = shapeMCPResult(result, cap(800)) as any;
    expect(out._truncated).toBe(true);
    expect(typeof out.preview).toBe('string');
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(800 + 64);
  });

  it('falls back to a wrapper when a top-level array’s leading element alone exceeds budget', () => {
    // capArray refuses to drop the first element; a single huge leading item
    // would otherwise be returned over-budget. The array path must re-check and
    // fall back to the valid {_truncated, preview} wrapper.
    const arr = [{ id: 0, body: 'q'.repeat(5000) }, { id: 1 }, { id: 2 }];
    const out = shapeMCPResult(arr, cap(500)) as any;
    expect(out._truncated).toBe(true);
    expect(typeof out.preview).toBe('string');
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(500 + 64);
  });

  it('leaves primitive results alone', () => {
    expect(shapeMCPResult(42, cap(1))).toBe(42);
    expect(shapeMCPResult(true, cap(1))).toBe(true);
    expect(shapeMCPResult(null, cap(1))).toBe(null);
  });

  it('exposes a sane default budget', () => {
    expect(DEFAULT_MCP_RESULT_MAX_CHARS).toBeGreaterThan(1000);
  });
});
