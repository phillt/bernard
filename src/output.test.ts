import { describe, it, expect, beforeEach } from 'vitest';
import {
  formatTokenCount,
  buildSpinnerMessage,
  setToolDetailsVisible,
  isToolDetailsVisible,
  type SpinnerStats,
} from './output.js';

describe('formatTokenCount', () => {
  it('renders raw integers under 1000', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(1)).toBe('1');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('formats 1k–9.9k with one decimal', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
    expect(formatTokenCount(1500)).toBe('1.5k');
    expect(formatTokenCount(9949)).toBe('9.9k');
  });

  it('rounds to whole k at 10k and above', () => {
    expect(formatTokenCount(10000)).toBe('10k');
    expect(formatTokenCount(12345)).toBe('12k');
    expect(formatTokenCount(99999)).toBe('100k');
  });

  it('renders non-finite token counts as 0 (no "NaNk" in the footer)', () => {
    expect(formatTokenCount(NaN)).toBe('0');
    expect(formatTokenCount(undefined as unknown as number)).toBe('0');
    expect(formatTokenCount(Infinity)).toBe('0');
  });
});

describe('buildSpinnerMessage', () => {
  function makeStats(overrides: Partial<SpinnerStats> = {}): SpinnerStats {
    return {
      startTime: Date.now(),
      turnPromptTokens: 0,
      turnCompletionTokens: 0,
      latestPromptTokens: 0,
      turnCacheReadTokens: 0,
      turnCacheWriteTokens: 0,
      model: 'claude-sonnet-4-5-20250929',
      turnLedger: new Map(),
      sessionCostUsd: 0,
      ...overrides,
    };
  }

  it('shows a ⚡cached segment when prompt-cache reads occurred (#269)', () => {
    const msg = buildSpinnerMessage(
      makeStats({ turnPromptTokens: 5000, turnCompletionTokens: 100, turnCacheReadTokens: 12000 }),
    );
    expect(msg).toContain('⚡cached');
    expect(msg).toContain('12k⚡cached');
  });

  it('omits the cached segment when there were no cache reads', () => {
    const msg = buildSpinnerMessage(makeStats({ turnPromptTokens: 5000, turnCompletionTokens: 100 }));
    expect(msg).not.toContain('cached');
  });

  it('returns "Thinking (Xs)" when no tokens have flowed yet', () => {
    const msg = buildSpinnerMessage(makeStats({ startTime: Date.now() - 5000 }));
    expect(msg).toMatch(/^Thinking \(\d+s\)$/);
  });

  it('treats non-finite token counts as 0 — never emits NaN', () => {
    const nan = NaN as number;
    const allNaN = buildSpinnerMessage(
      makeStats({
        startTime: Date.now() - 1000,
        turnPromptTokens: nan,
        turnCompletionTokens: nan,
        latestPromptTokens: nan,
      }),
    );
    // No usage yet → the bare "Thinking" form, and no "NaN" anywhere.
    expect(allNaN).toMatch(/^Thinking \(\d+s\)$/);
    expect(allNaN).not.toContain('NaN');

    // Tokens present but latest is NaN → percentage must still be a number.
    const partialNaN = buildSpinnerMessage(
      makeStats({ turnPromptTokens: 1234, turnCompletionTokens: 56, latestPromptTokens: nan }),
    );
    expect(partialNaN).not.toContain('NaN');
    expect(partialNaN).toMatch(/\d+% until compression/);
  });

  it('includes up / down counts and a remaining-percentage tail when populated', () => {
    const msg = buildSpinnerMessage(
      makeStats({
        startTime: Date.now() - 1000,
        turnPromptTokens: 1234,
        turnCompletionTokens: 56,
        latestPromptTokens: 1234,
      }),
    );
    expect(msg).toContain('↑');
    expect(msg).toContain('↓');
    expect(msg).toContain('% until compression');
  });

  it('honors contextWindowOverride', () => {
    const small = buildSpinnerMessage(
      makeStats({
        turnPromptTokens: 5000,
        turnCompletionTokens: 100,
        latestPromptTokens: 5000,
        contextWindowOverride: 10_000,
      }),
    );
    const large = buildSpinnerMessage(
      makeStats({
        turnPromptTokens: 5000,
        turnCompletionTokens: 100,
        latestPromptTokens: 5000,
        contextWindowOverride: 1_000_000,
      }),
    );
    const smallPct = Number(small.match(/(\d+)% until compression/)?.[1] ?? '-1');
    const largePct = Number(large.match(/(\d+)% until compression/)?.[1] ?? '-1');
    expect(smallPct).toBeLessThan(largePct);
  });

  it('clamps remainingPct to 0 when the latest prompt exceeds the threshold', () => {
    const msg = buildSpinnerMessage(
      makeStats({
        turnPromptTokens: 999_999,
        turnCompletionTokens: 1,
        latestPromptTokens: 999_999,
        contextWindowOverride: 10_000,
      }),
    );
    expect(msg).toContain('0% until compression');
  });
});

describe('tool-details visibility', () => {
  beforeEach(() => {
    setToolDetailsVisible(false);
  });

  it('round-trips through the setter/getter', () => {
    expect(isToolDetailsVisible()).toBe(false);
    setToolDetailsVisible(true);
    expect(isToolDetailsVisible()).toBe(true);
    setToolDetailsVisible(false);
    expect(isToolDetailsVisible()).toBe(false);
  });
});
