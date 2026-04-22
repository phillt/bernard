import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpecialistCandidate } from './specialist-candidates.js';

const mockPrintInfo = vi.fn();
const mockPrintWarning = vi.fn();

vi.mock('./output.js', () => ({
  printInfo: (...args: unknown[]) => mockPrintInfo(...args),
  printWarning: (...args: unknown[]) => mockPrintWarning(...args),
}));

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
}));

const {
  bootstrapPendingCandidates,
  promotePendingCandidates,
  promoteCandidate,
} = await import('./candidate-bootstrap.js');

function makeCandidate(overrides: Partial<SpecialistCandidate> = {}): SpecialistCandidate {
  return {
    id: 'cand-1',
    draftId: 'demo',
    name: 'Demo',
    description: 'demo description',
    systemPrompt: 'You are demo',
    guidelines: [],
    confidence: 0.9,
    reasoning: 'detected',
    detectedAt: '2024-01-15T00:00:00.000Z',
    source: 'exit',
    acknowledged: false,
    status: 'pending',
    ...overrides,
  };
}

function makeStores(initialPending: SpecialistCandidate[]) {
  let pending = [...initialPending];
  const candidateStore = {
    pruneOld: vi.fn(),
    reconcileSaved: vi.fn(),
    listPending: vi.fn(() => pending),
    updateStatus: vi.fn((id: string, status: string) => {
      if (status === 'accepted') pending = pending.filter((c) => c.id !== id);
      return true;
    }),
  };
  const specialistStore = {
    list: vi.fn(() => []),
    create: vi.fn(),
  };
  return { candidateStore, specialistStore };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bootstrapPendingCandidates', () => {
  it('returns empty result when no candidates are pending', () => {
    const { candidateStore, specialistStore } = makeStores([]);

    const result = bootstrapPendingCandidates(candidateStore as any, specialistStore as any, {
      autoCreateSpecialists: true,
      autoCreateThreshold: 0.8,
    });

    expect(result.pending).toEqual([]);
    expect(result.contextBlock).toBeNull();
    expect(candidateStore.pruneOld).toHaveBeenCalled();
    expect(candidateStore.reconcileSaved).toHaveBeenCalledWith([]);
    expect(specialistStore.create).not.toHaveBeenCalled();
  });

  it('skips promotion when autoCreateSpecialists is off and returns all pending', () => {
    const candidate = makeCandidate({ confidence: 0.958 });
    const { candidateStore, specialistStore } = makeStores([candidate]);

    const result = bootstrapPendingCandidates(candidateStore as any, specialistStore as any, {
      autoCreateSpecialists: false,
      autoCreateThreshold: 0.8,
    });

    expect(specialistStore.create).not.toHaveBeenCalled();
    expect(candidateStore.updateStatus).not.toHaveBeenCalled();
    expect(result.pending).toEqual([candidate]);
    expect(result.contextBlock).toContain('## Specialist Suggestions');
    expect(result.contextBlock).toContain(`"${candidate.name}"`);
  });

  it('promotes above-threshold candidates and leaves below-threshold in pending', () => {
    const above = makeCandidate({
      id: 'cand-above',
      draftId: 'above',
      name: 'Above',
      description: 'above threshold',
      confidence: 0.95,
    });
    const below = makeCandidate({
      id: 'cand-below',
      draftId: 'below',
      name: 'Below',
      description: 'below threshold',
      confidence: 0.5,
    });
    const { candidateStore, specialistStore } = makeStores([above, below]);

    const result = bootstrapPendingCandidates(candidateStore as any, specialistStore as any, {
      autoCreateSpecialists: true,
      autoCreateThreshold: 0.8,
    });

    expect(specialistStore.create).toHaveBeenCalledTimes(1);
    expect(specialistStore.create).toHaveBeenCalledWith(
      'above',
      'Above',
      'above threshold',
      'You are demo',
      [],
    );
    expect(candidateStore.updateStatus).toHaveBeenCalledWith('cand-above', 'accepted');
    expect(result.pending).toEqual([below]);
    expect(result.contextBlock).toContain('"Below"');
    expect(result.contextBlock).not.toContain('"Above"');
    expect(mockPrintInfo).toHaveBeenCalledWith(expect.stringContaining('Specialist auto-created: "Above"'));
  });

  it('warns and keeps the candidate pending when promoteCandidate throws', () => {
    const candidate = makeCandidate({ id: 'cand-fail', name: 'Failing', confidence: 0.99 });
    const { candidateStore, specialistStore } = makeStores([candidate]);
    specialistStore.create.mockImplementation(() => {
      throw new Error('disk full');
    });

    const result = bootstrapPendingCandidates(candidateStore as any, specialistStore as any, {
      autoCreateSpecialists: true,
      autoCreateThreshold: 0.8,
    });

    expect(mockPrintWarning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to auto-create specialist "Failing"'),
    );
    expect(mockPrintWarning).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect(candidateStore.updateStatus).not.toHaveBeenCalled();
    expect(result.pending).toEqual([candidate]);
    expect(result.contextBlock).toContain('"Failing"');
  });
});

describe('promotePendingCandidates', () => {
  it('promotes only candidates at or above the threshold', () => {
    const at = makeCandidate({ id: 'at', draftId: 'at', name: 'At', confidence: 0.8 });
    const below = makeCandidate({ id: 'below', draftId: 'below', name: 'Below', confidence: 0.79 });
    const { candidateStore, specialistStore } = makeStores([at, below]);

    promotePendingCandidates(candidateStore as any, specialistStore as any, 0.8);

    expect(specialistStore.create).toHaveBeenCalledTimes(1);
    expect(specialistStore.create).toHaveBeenCalledWith('at', 'At', expect.anything(), expect.anything(), expect.anything());
    expect(candidateStore.updateStatus).toHaveBeenCalledWith('at', 'accepted');
    expect(candidateStore.updateStatus).not.toHaveBeenCalledWith('below', 'accepted');
  });
});

describe('promoteCandidate', () => {
  it('creates a specialist, marks the candidate accepted, and prints an info line', () => {
    const candidate = makeCandidate({
      id: 'cand-x',
      draftId: 'demo-wrapper',
      name: 'Demo Wrapper',
      description: 'wraps demo',
      systemPrompt: 'Do demo things',
      guidelines: ['be concise'],
      confidence: 0.9,
    });
    const { candidateStore, specialistStore } = makeStores([candidate]);

    promoteCandidate(candidate, specialistStore as any, candidateStore as any, 0.8);

    expect(specialistStore.create).toHaveBeenCalledWith(
      'demo-wrapper',
      'Demo Wrapper',
      'wraps demo',
      'Do demo things',
      ['be concise'],
    );
    expect(candidateStore.updateStatus).toHaveBeenCalledWith('cand-x', 'accepted');
    expect(mockPrintInfo).toHaveBeenCalledWith(
      expect.stringContaining('Specialist auto-created: "Demo Wrapper" (confidence: 90%)'),
    );
  });
});
