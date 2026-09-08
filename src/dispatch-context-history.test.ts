import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearDispatchContexts,
  getDispatchContexts,
  recordDispatchContext,
  setDispatchContexts,
  type DispatchContextRecord,
} from './dispatch-context-history.js';

function row(over: Partial<DispatchContextRecord> = {}): DispatchContextRecord {
  return {
    dispatchId: 'aabbccdd',
    definitionId: 'sub',
    telemetrySite: 'specialist',
    timestamp: 1,
    sections: { persistent_memory: 100 },
    ...over,
  };
}

beforeEach(() => clearDispatchContexts());

describe('the dispatch-context recorder', () => {
  it('keeps records newest-last, matching the two per-turn stores', () => {
    recordDispatchContext(row({ dispatchId: 'first' }));
    recordDispatchContext(row({ dispatchId: 'second' }));
    expect(getDispatchContexts().map((r) => r.dispatchId)).toEqual(['first', 'second']);
  });

  it('is bounded, because a fan-out turn records far faster than a per-turn store', () => {
    // `withSlot` allows four concurrent dispatches and each MCP delegation adds
    // another, and every LLM call within a dispatch records — so this grows
    // much faster than the two stores it sits beside, whose `save` is uncapped
    // and pretty-printed.
    for (let i = 0; i < 500; i++) recordDispatchContext(row({ dispatchId: `d${i}` }));
    const kept = getDispatchContexts();
    expect(kept.length).toBe(200);
    // The oldest go, not the newest — a bound that dropped new records would
    // make the viewer useless exactly when a session got interesting.
    expect(kept[kept.length - 1].dispatchId).toBe('d499');
  });

  it('returns a copy, so a caller cannot mutate the recorder', () => {
    recordDispatchContext(row());
    getDispatchContexts().length = 0;
    expect(getDispatchContexts()).toHaveLength(1);
  });

  it('bounds what a resumed session seeds, not just what it records', () => {
    setDispatchContexts(Array.from({ length: 500 }, (_, i) => row({ dispatchId: `r${i}` })));
    expect(getDispatchContexts()).toHaveLength(200);
  });
});
