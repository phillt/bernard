import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { UsageViewer } from '../overlays/UsageViewer.js';
import type { Agent } from '../../agent.js';
import type { SpinnerStats, TurnUsageEntry } from '../../output.js';

function agentWithLedger(entries: TurnUsageEntry[] | null): Agent {
  const spinnerStats: SpinnerStats | null = entries
    ? {
        startTime: 0,
        turnPromptTokens: 0,
        turnCompletionTokens: 0,
        latestPromptTokens: 0,
        turnCacheReadTokens: 0,
        turnCacheWriteTokens: 0,
        model: 'claude-opus-4-8',
        turnLedger: new Map(entries.map((e) => [`${e.bucket}|${e.provider}|${e.modelName}|${e.site}`, e])),
        sessionCostUsd: 0,
      }
    : null;
  return { spinnerStats } as unknown as Agent;
}

function entry(over: Partial<TurnUsageEntry> & Pick<TurnUsageEntry, 'bucket' | 'provider' | 'modelName' | 'site'>): TurnUsageEntry {
  return { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1, ...over };
}

describe('<UsageViewer>', () => {
  it('renders the tab, a per-tier row, and a TOTAL row', () => {
    const agent = agentWithLedger([
      entry({ bucket: 'premium', provider: 'anthropic', modelName: 'claude-opus-4-8', site: 'main', promptTokens: 12000, completionTokens: 3000, calls: 4 }),
    ]);
    const { lastFrame } = render(createElement(UsageViewer, { agent }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Usage & Cost'); // tab strip
    expect(frame).toContain('premium');
    expect(frame).toContain('claude-opus-4-8');
    expect(frame).toContain('TOTAL');
  });

  it('shows an empty-state message when no usage was recorded', () => {
    const { lastFrame } = render(createElement(UsageViewer, { agent: agentWithLedger(null) }));
    expect(lastFrame() ?? '').toContain('No usage recorded yet');
  });

  it('always shows all tiers (incl. dimmed premium) with a mode note when tierModels is given', () => {
    // optimize-tokens turn: only mid + cheap billed tokens — premium had none.
    const agent = agentWithLedger([
      entry({ bucket: 'mid', provider: 'xai', modelName: 'grok-4.3', site: 'main', promptTokens: 761000, completionTokens: 516, calls: 8 }),
      entry({ bucket: 'cheap', provider: 'xai', modelName: 'grok-4.20', site: 'rewriter', promptTokens: 302000, completionTokens: 937, calls: 7 }),
    ]);
    const tierModels = {
      premium: { provider: 'xai', model: 'grok-4.3' },
      mid: { provider: 'xai', model: 'grok-4.3' },
      cheap: { provider: 'xai', model: 'grok-4.20' },
    };
    const { lastFrame } = render(
      createElement(UsageViewer, { agent, tierModels, modelMode: 'optimize-tokens' }),
    );
    const frame = lastFrame() ?? '';
    // The high-end tier is now visible even though it had no calls this turn.
    expect(frame).toContain('premium');
    expect(frame).toContain('mid');
    expect(frame).toContain('cheap');
    // Footer note explains the absence: premium is structurally unused here.
    expect(frame).toContain('optimize-tokens');
    expect(frame).toMatch(/premium is not used in this mode/);
  });

  it('omits zero-fill (legacy behavior) when no tierModels is provided', () => {
    const agent = agentWithLedger([
      entry({ bucket: 'mid', provider: 'xai', modelName: 'grok-4.3', site: 'main', promptTokens: 1000, completionTokens: 100, calls: 2 }),
    ]);
    const { lastFrame } = render(createElement(UsageViewer, { agent }));
    expect(lastFrame() ?? '').not.toContain('premium');
  });
});
