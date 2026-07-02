import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('<StatusBar> non-finite token stats', () => {
  it('renders 0 (never "NaNk") and an all-empty gauge when token fields are NaN', () => {
    const agent = {
      spinnerStats: {
        startTime: 0,
        turnPromptTokens: NaN,
        turnCompletionTokens: NaN,
        latestPromptTokens: NaN,
        model: 'test-model',
        contextWindowOverride: 1000,
      },
      currentStrategy: null,
    } as unknown as Agent;
    const frame = stripAnsi(render(createElement(StatusBar, { agent })).lastFrame() ?? '');
    expect(frame).not.toContain('NaN');
    expect(frame).toMatch(/turn\s+0↑\s+0↓/);
    expect(frame).toContain('ctx 0');
    expect(gauge(frame)).toBe('○○○○○○○○○○'); // gauge still drawn, fully empty
  });
});

describe('<StatusBar> session cost cell (#258)', () => {
  function agentWithSessionCost(sessionCostUsd: number): Agent {
    return {
      spinnerStats: {
        startTime: 0,
        turnPromptTokens: 0,
        turnCompletionTokens: 0,
        latestPromptTokens: 0,
        turnCacheReadTokens: 0,
        turnCacheWriteTokens: 0,
        model: 'test-model',
        contextWindowOverride: 1000,
        turnLedger: new Map(),
        sessionCostUsd,
      },
      currentStrategy: null,
    } as unknown as Agent;
  }

  it('renders a session cost cell once the session total is > 0', () => {
    const frame = stripAnsi(
      render(createElement(StatusBar, { agent: agentWithSessionCost(0.42) })).lastFrame() ?? '',
    );
    expect(frame).toContain('session ~$0.42');
  });

  it('shows the session cell at $0.00 rather than hiding it at zero cost', () => {
    const frame = stripAnsi(
      render(createElement(StatusBar, { agent: agentWithSessionCost(0) })).lastFrame() ?? '',
    );
    expect(frame).toContain('session ~$0.00');
  });

  it('joins readout groups with the `·` dot divider (matching the left HintBar)', () => {
    const frame = stripAnsi(
      render(createElement(StatusBar, { agent: agentWithSessionCost(0.42) })).lastFrame() ?? '',
    );
    expect(frame).toContain('·');
    // turn · session · ctx — three dividers minimum between the token groups.
    expect(frame).toContain('turn ');
    expect(frame).toContain('ctx ');
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

describe('<StatusBar> token counter pulse (#246)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers an extra re-render for the ↑ counter when prompt tokens increase (pulse on), then again when it decays (pulse off)', async () => {
    // The pulse mechanism fires two state transitions per increment:
    //   1. setUpPulse(true)  — on the poll tick (500 ms)
    //   2. setUpPulse(false) — on the decay timeout (+ 250 ms)
    // Each state transition forces a new frame, so frames.length must grow
    // by at least 2 compared to idle (no new frames when nothing changes).
    const agent = stubAgent(0.55);
    const { frames } = render(createElement(StatusBar, { agent }));

    const framesBeforePoll = frames.length;

    // Increase prompt tokens — the poll will see this at 500 ms.
    (agent.spinnerStats as { turnPromptTokens: number }).turnPromptTokens = 5000;

    // Advance to 500 ms → poll fires, snapshot changes, setUpPulse(true) + force() called.
    await vi.advanceTimersByTimeAsync(500);
    const framesAfterPoll = frames.length;

    // At least one new frame from the poll re-render (pulse on + counter value update).
    expect(framesAfterPoll).toBeGreaterThan(framesBeforePoll);

    // Advance another 250 ms → decay timeout fires, setUpPulse(false) called.
    await vi.advanceTimersByTimeAsync(250);
    const framesAfterDecay = frames.length;

    // At least one more frame from the decay re-render.
    expect(framesAfterDecay).toBeGreaterThan(framesAfterPoll);

    // The displayed token count must reflect the new value in the final frame.
    // formatTokenCount(5000) = "5.0k"
    expect(stripAnsi(frames[framesAfterDecay - 1] ?? '')).toMatch(/5\.0k↑/);
  });

  it('triggers an extra re-render for the ↓ counter when completion tokens increase (pulse on), then again when it decays (pulse off)', async () => {
    const agent = stubAgent(0.55);
    const { frames } = render(createElement(StatusBar, { agent }));

    const framesBeforePoll = frames.length;

    // Increase completion tokens — the poll will see this at 500 ms.
    (agent.spinnerStats as { turnCompletionTokens: number }).turnCompletionTokens = 3000;

    await vi.advanceTimersByTimeAsync(500);
    const framesAfterPoll = frames.length;

    expect(framesAfterPoll).toBeGreaterThan(framesBeforePoll);

    await vi.advanceTimersByTimeAsync(250);
    const framesAfterDecay = frames.length;

    expect(framesAfterDecay).toBeGreaterThan(framesAfterPoll);

    // formatTokenCount(3000) = "3.0k"
    expect(stripAnsi(frames[framesAfterDecay - 1] ?? '')).toMatch(/3\.0k↓/);
  });

  it('does NOT trigger a ↓ pulse when only prompt tokens increase', async () => {
    // When turnCompletionTokens stays constant, only the ↑ pulse fires.
    // We verify this by confirming that the decay timer for ↓ never fires an
    // extra frame after the ↑ decay is already done.
    const agent = stubAgent(0.55);
    const { frames } = render(createElement(StatusBar, { agent }));

    // Only increase prompt tokens; completion tokens stay at 567.
    (agent.spinnerStats as { turnPromptTokens: number }).turnPromptTokens = 5000;

    // Advance well past both the poll (500 ms) and the decay (250 ms).
    await vi.advanceTimersByTimeAsync(500);
    const framesAtPoll = frames.length;
    await vi.advanceTimersByTimeAsync(250);
    const framesAfterUpDecay = frames.length;

    // ↑ pulse should have fired (at least one new frame).
    expect(framesAfterUpDecay).toBeGreaterThan(framesAtPoll);

    // Now advance a further 500 ms with no token changes — no new frames
    // should appear, because the ↓ pulse never fired and there's nothing else
    // to re-render.
    await vi.advanceTimersByTimeAsync(500);
    const framesAfterIdle = frames.length;
    expect(framesAfterIdle).toBe(framesAfterUpDecay);

    // The ↓ value must still be the original 567 throughout.
    expect(stripAnsi(frames[framesAfterIdle - 1] ?? '')).toMatch(/567↓/);
  });
});
