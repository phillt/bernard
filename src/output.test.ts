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
});

describe('buildSpinnerMessage', () => {
  function makeStats(overrides: Partial<SpinnerStats> = {}): SpinnerStats {
    return {
      startTime: Date.now(),
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      latestPromptTokens: 0,
      model: 'claude-sonnet-4-5-20250929',
      ...overrides,
    };
  }

  it('returns "Thinking (Xs)" when no tokens have flowed yet', () => {
    const msg = buildSpinnerMessage(makeStats({ startTime: Date.now() - 5000 }));
    expect(msg).toMatch(/^Thinking \(\d+s\)$/);
  });

  it('includes up / down counts and a remaining-percentage tail when populated', () => {
    const msg = buildSpinnerMessage(
      makeStats({
        startTime: Date.now() - 1000,
        totalPromptTokens: 1234,
        totalCompletionTokens: 56,
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
        totalPromptTokens: 5000,
        totalCompletionTokens: 100,
        latestPromptTokens: 5000,
        contextWindowOverride: 10_000,
      }),
    );
    const large = buildSpinnerMessage(
      makeStats({
        totalPromptTokens: 5000,
        totalCompletionTokens: 100,
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
        totalPromptTokens: 999_999,
        totalCompletionTokens: 1,
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
