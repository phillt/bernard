import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CoreMessage } from 'ai';
import { persistAgentState } from '../save.js';
import type { Agent } from '../../agent.js';
import type { HistoryStore } from '../../history.js';
import type { ProvenanceHistoryStore } from '../../provenance-history.js';
import type { TurnProvenance } from '../../provenance.js';

function makeAgent(history: CoreMessage[], turns: TurnProvenance[]): Agent {
  return {
    getHistory: () => history,
    getTurnProvenance: () => turns,
  } as unknown as Agent;
}

describe('persistAgentState', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('writes history and provenance to their stores', () => {
    const history: CoreMessage[] = [{ role: 'user', content: 'hi' }];
    const turns: TurnProvenance[] = [];
    const historyStore = { save: vi.fn() } as unknown as HistoryStore;
    const provenanceHistoryStore = {
      save: vi.fn(),
    } as unknown as ProvenanceHistoryStore;

    persistAgentState({
      agent: makeAgent(history, turns),
      historyStore,
      provenanceHistoryStore,
    });

    expect(historyStore.save).toHaveBeenCalledWith(history);
    expect(provenanceHistoryStore.save).toHaveBeenCalledWith(turns);
  });

  it('swallows a history-save failure and still tries provenance', () => {
    const historyStore = {
      save: vi.fn(() => {
        throw new Error('disk full');
      }),
    } as unknown as HistoryStore;
    const provenanceHistoryStore = {
      save: vi.fn(),
    } as unknown as ProvenanceHistoryStore;

    expect(() =>
      persistAgentState({
        agent: makeAgent([], []),
        historyStore,
        provenanceHistoryStore,
      }),
    ).not.toThrow();
    expect(provenanceHistoryStore.save).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('swallows a provenance-save failure', () => {
    const historyStore = { save: vi.fn() } as unknown as HistoryStore;
    const provenanceHistoryStore = {
      save: vi.fn(() => {
        throw new Error('disk full');
      }),
    } as unknown as ProvenanceHistoryStore;

    expect(() =>
      persistAgentState({
        agent: makeAgent([], []),
        historyStore,
        provenanceHistoryStore,
      }),
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
  });
});
