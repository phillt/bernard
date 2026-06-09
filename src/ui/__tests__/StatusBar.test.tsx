import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import stripAnsi from 'strip-ansi';
import { StatusBar } from '../StatusBar.js';
import { COMPRESSION_THRESHOLD } from '../../context.js';
import type { Agent } from '../../agent.js';

/**
 * Builds a stub Agent carrying just the fields StatusBar reads. The context
 * window is overridden to a round number so `usedFrac` is easy to steer:
 * with window=1000 the compression budget is 1000 * COMPRESSION_THRESHOLD,
 * and `latestPromptTokens = frac * budget` yields an exact gauge fraction.
 */
function stubAgent(usedFrac: number): Agent {
  const contextWindow = 1000;
  const budget = contextWindow * COMPRESSION_THRESHOLD;
  return {
    spinnerStats: {
      startTime: 0,
      turnPromptTokens: 1234,
      turnCompletionTokens: 567,
      latestPromptTokens: usedFrac * budget,
      model: 'test-model',
      contextWindowOverride: contextWindow,
    },
    currentStrategy: null,
  } as unknown as Agent;
}

function gauge(frame: string): string {
  // Strip everything except the gauge glyphs.
  return frame.replace(/[^●◐○]/g, '');
}

describe('<StatusBar> context gauge (half-dot resolution)', () => {
  it('renders a half dot when the fill lands mid-dot', () => {
    // 0.55 * 10 = 5.5 dots → 5 full + 1 half + 4 empty.
    const { lastFrame } = render(createElement(StatusBar, { agent: stubAgent(0.55) }));
    expect(gauge(lastFrame() ?? '')).toBe('●●●●●◐○○○○');
  });

  it('rounds a >= .75 remainder up to a full dot', () => {
    // 0.58 * 10 = 5.8 dots → 6 full, no half.
    const { lastFrame } = render(createElement(StatusBar, { agent: stubAgent(0.58) }));
    expect(gauge(lastFrame() ?? '')).toBe('●●●●●●○○○○');
  });

  it('drops a < .25 remainder to empty', () => {
    // 0.52 * 10 = 5.2 dots → 5 full, no half.
    const { lastFrame } = render(createElement(StatusBar, { agent: stubAgent(0.52) }));
    expect(gauge(lastFrame() ?? '')).toBe('●●●●●○○○○○');
  });

  it('shows a lone half dot for tiny usage instead of an all-empty gauge', () => {
    // 0.04 * 10 = 0.4 dots → 0 full + 1 half.
    const { lastFrame } = render(createElement(StatusBar, { agent: stubAgent(0.04) }));
    expect(gauge(lastFrame() ?? '')).toBe('◐○○○○○○○○○');
  });

  it('saturates at all-full when usage hits the compression budget', () => {
    const { lastFrame } = render(createElement(StatusBar, { agent: stubAgent(1) }));
    expect(gauge(lastFrame() ?? '')).toBe('●●●●●●●●●●');
  });
});

describe('<StatusBar> token readout labels (#234)', () => {
  it('labels the per-turn odometer as turn-scoped', () => {
    const { lastFrame } = render(createElement(StatusBar, { agent: stubAgent(0.55) }));
    // Strip ANSI: Ink inserts color/reset codes between adjacent <Text> nodes,
    // which would otherwise break regexes that span component boundaries.
    const frame = stripAnsi(lastFrame() ?? '');
    // The odometer must read "turn ...↑ ...↓" so it can't be misread as the
    // adjacent context gauge.
    expect(frame).toMatch(/turn\s+1\.2k↑\s+567↓/);
  });

  it('labels the gauge with the current context size (ctx)', () => {
    const { lastFrame } = render(createElement(StatusBar, { agent: stubAgent(0.55) }));
    const frame = stripAnsi(lastFrame() ?? '');
    // ctx reflects latestPromptTokens (0.55 * 1000 * COMPRESSION_THRESHOLD) and
    // sits between the per-turn odometer and the gauge glyphs.
    expect(frame).toMatch(/ctx \S+ *●/);
  });
});

describe('<StatusBar> idle-tick guard (#232)', () => {
  it('still refreshes the readout when spinnerStats changes between polls', async () => {
    // The poll only forces a re-render when a rendered value actually moved
    // (#232). This guards the positive path: an in-place mutation of the
    // stable spinnerStats object (exactly how the token hooks update it) must
    // surface on the next poll, so the equality snapshot can't be over-eager.
    const agent = stubAgent(0.55);
    const { lastFrame } = render(createElement(StatusBar, { agent }));
    expect(stripAnsi(lastFrame() ?? '')).toMatch(/turn\s+1\.2k↑/);
    (agent.spinnerStats as { turnPromptTokens: number }).turnPromptTokens = 2222;
    await new Promise((r) => setTimeout(r, 600)); // past the 500ms poll interval
    expect(stripAnsi(lastFrame() ?? '')).toMatch(/turn\s+2\.2k↑/);
  });
});
