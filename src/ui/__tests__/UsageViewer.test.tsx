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
});
