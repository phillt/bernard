import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWaitTool, MAX_WAIT_SECONDS, MIN_WAIT_SECONDS } from './wait.js';

describe('wait tool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for specified seconds', async () => {
    const tool = createWaitTool();
    const promise = tool.execute!({ seconds: 5 }, {} as any);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result).toBe('Waited 5 seconds.');
  });

  it('returns singular "second" for exactly 1', async () => {
    const tool = createWaitTool();
    const promise = tool.execute!({ seconds: 1 }, {} as any);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe('Waited 1 second.');
  });

  it('handles fractional seconds', async () => {
    const tool = createWaitTool();
    const promise = tool.execute!({ seconds: 0.5 }, {} as any);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;
    expect(result).toBe('Waited 0.5 seconds.');
  });

  it('clamps values above max', async () => {
    const tool = createWaitTool();
    const promise = tool.execute!({ seconds: 999 }, {} as any);
    await vi.advanceTimersByTimeAsync(MAX_WAIT_SECONDS * 1000);
    const result = await promise;
    expect(result).toBe(`Waited ${MAX_WAIT_SECONDS} seconds.`);
  });

  it('clamps values below min', async () => {
    const tool = createWaitTool();
    const promise = tool.execute!({ seconds: 0.01 }, {} as any);
    await vi.advanceTimersByTimeAsync(MIN_WAIT_SECONDS * 1000);
    const result = await promise;
    expect(result).toBe(`Waited ${MIN_WAIT_SECONDS} seconds.`);
  });

  describe('schema validation', () => {
    it('accepts a valid number', () => {
      const tool = createWaitTool();
      const parsed = tool.parameters.parse({ seconds: 10 });
      expect(parsed.seconds).toBe(10);
    });

    it('accepts the minimum value', () => {
      const tool = createWaitTool();
      const parsed = tool.parameters.parse({ seconds: MIN_WAIT_SECONDS });
      expect(parsed.seconds).toBe(MIN_WAIT_SECONDS);
    });

    it('accepts the maximum value', () => {
      const tool = createWaitTool();
      const parsed = tool.parameters.parse({ seconds: MAX_WAIT_SECONDS });
      expect(parsed.seconds).toBe(MAX_WAIT_SECONDS);
    });

    it('rejects values below minimum', () => {
      const tool = createWaitTool();
      expect(() => tool.parameters.parse({ seconds: 0.05 })).toThrow();
    });

    it('rejects values above maximum', () => {
      const tool = createWaitTool();
      expect(() => tool.parameters.parse({ seconds: 301 })).toThrow();
    });

    it('rejects negative values', () => {
      const tool = createWaitTool();
      expect(() => tool.parameters.parse({ seconds: -1 })).toThrow();
    });

    it('rejects non-number values', () => {
      const tool = createWaitTool();
      expect(() => tool.parameters.parse({ seconds: 'five' })).toThrow();
    });

    it('rejects missing seconds', () => {
      const tool = createWaitTool();
      expect(() => tool.parameters.parse({})).toThrow();
    });
  });
});
