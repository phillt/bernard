import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCorrectionAgent, extractOutcome } from './correction.js';
import type { RunCorrectionDeps } from './correction.js';
import type { CorrectionCandidate } from './correction-candidates.js';
import type { AgentContext } from './framework/context.js';

vi.mock('./logger.js', () => ({ debugLog: vi.fn() }));
vi.mock('./output.js', () => ({ printInfo: vi.fn() }));
// Do NOT mock structured-output.js or zod — let real parsing happen for extractOutcome tests
// Do NOT mock tool-wrapper-run.js — we'll inject mock via deps.toolWrapperRun

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockDeps = RunCorrectionDeps & {
  specialistStore: { get: ReturnType<typeof vi.fn> };
  correctionStore: { listPending: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
};

function createMockDeps(overrides?: Partial<RunCorrectionDeps>): MockDeps {
  const specialistStore = { get: vi.fn() };
  const correctionStore = {
    listPending: vi.fn(() => [] as CorrectionCandidate[]),
    update: vi.fn(),
  };
  const ctx: AgentContext = {
    config: {} as any,
    toolOptions: {} as any,
    stores: {
      memory: {} as any,
      specialists: specialistStore as any,
      correction: correctionStore as any,
      routines: {} as any,
      candidates: {} as any,
      toolProfiles: {} as any,
    },
    mcp: { tools: {}, serverNames: [] },
  };
  return {
    ctx,
    ...overrides,
    specialistStore,
    correctionStore,
  };
}

function createCandidate(id: string): CorrectionCandidate {
  return {
    id,
    specialistId: 'shell-wrapper',
    input: 'test input',
    attemptedCall: 'shell {"command":"bad"}',
    error: 'command not found',
    createdAt: new Date().toISOString(),
    validated: false,
    status: 'pending' as const,
  };
}

const VALID_SPECIALIST = { id: 'correction-agent', kind: 'meta', name: 'Correction Agent' };

/**
 * Correction-agent result that includes a proposedGoodCall so the
 * orchestrator's re-validation pass can run. Pair with a mockResolvedValue
 * (not mockResolvedValueOnce) so the same payload services both the agent
 * call AND the re-validation call.
 */
const APPLIED_OK_WITH_REVAL =
  '{"status":"ok","result":{"validated":true,"applied":true,"proposedGoodCall":{"specialistId":"shell-wrapper","input":"do the thing"}}}';

// ---------------------------------------------------------------------------
// extractOutcome
// ---------------------------------------------------------------------------

describe('extractOutcome', () => {
  it('parses a valid WrapperResult wrapping a full CorrectionOutcome', () => {
    const text = '{"status":"ok","result":{"validated":true,"applied":true,"notes":"Fixed it"}}';
    const outcome = extractOutcome(text);
    expect(outcome).toEqual({ validated: true, applied: true, notes: 'Fixed it' });
  });

  it('parses via duck-type path when result has applied boolean but missing other schema fields', () => {
    // result has "applied" but no "validated" key — duck-type branch fills in Boolean(undefined) = false
    const text = '{"status":"ok","result":{"applied":true}}';
    const outcome = extractOutcome(text);
    expect(outcome).toBeDefined();
    expect(outcome!.applied).toBe(true);
    // validated coerced from absent value
    expect(typeof outcome!.validated).toBe('boolean');
  });

  it('returns undefined when wrapper status is "error"', () => {
    const text = '{"status":"error","result":{"validated":true,"applied":true}}';
    const outcome = extractOutcome(text);
    expect(outcome).toBeUndefined();
  });

  it('parses a bare CorrectionOutcome (no WrapperResult wrapper) via fallback', () => {
    const text = '{"validated":false,"applied":false}';
    const outcome = extractOutcome(text);
    expect(outcome).toEqual({ validated: false, applied: false });
  });

  it('parses a CorrectionOutcome embedded in surrounding prose', () => {
    const text = 'Here is the result: {"validated":true,"applied":false,"notes":"skipped"} done';
    const outcome = extractOutcome(text);
    expect(outcome).toBeDefined();
    expect(outcome!.validated).toBe(true);
    expect(outcome!.applied).toBe(false);
    expect(outcome!.notes).toBe('skipped');
  });

  it('returns undefined for completely invalid text', () => {
    expect(extractOutcome('no json here')).toBeUndefined();
  });

  it('returns undefined when wrapper result is a plain string (not an outcome object)', () => {
    // Inner parse fails, fallback also fails because the only JSON block is the wrapper
    // which itself does not satisfy CorrectionOutcomeSchema (no validated/applied keys).
    const text = '{"status":"ok","result":"just a string"}';
    const outcome = extractOutcome(text);
    expect(outcome).toBeUndefined();
  });

  it('parses notes as optional — outcome without notes is valid', () => {
    const text = '{"status":"ok","result":{"validated":true,"applied":true}}';
    const outcome = extractOutcome(text);
    expect(outcome).toBeDefined();
    expect(outcome!.validated).toBe(true);
    expect(outcome!.applied).toBe(true);
    expect(outcome!.notes).toBeUndefined();
  });

  it('preserves notes string from the nested result', () => {
    const text = JSON.stringify({
      status: 'ok',
      result: { validated: true, applied: false, notes: 'Not enough confidence' },
    });
    const outcome = extractOutcome(text);
    expect(outcome!.notes).toBe('Not enough confidence');
  });
});

// ---------------------------------------------------------------------------
// runCorrectionAgent
// ---------------------------------------------------------------------------

describe('runCorrectionAgent', () => {
  let deps: MockDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
  });

  // -------------------------------------------------------------------------
  // Early-exit / preconditions
  // -------------------------------------------------------------------------

  it('returns {0,0,0} when prefetchedPending is empty', async () => {
    const result = await runCorrectionAgent(deps, []);
    expect(result).toEqual({ processed: 0, applied: 0, skipped: 0 });
  });

  it('returns {0,0,0} when store.listPending returns empty and no prefetch given', async () => {
    vi.mocked(deps.correctionStore.listPending).mockReturnValue([]);
    const result = await runCorrectionAgent(deps);
    expect(result).toEqual({ processed: 0, applied: 0, skipped: 0 });
  });

  it('skips all candidates when correction specialist is not found', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(undefined);
    const candidates = [createCandidate('a'), createCandidate('b'), createCandidate('c')];
    const result = await runCorrectionAgent(deps, candidates);
    expect(result).toEqual({ processed: 0, applied: 0, skipped: 3 });
  });

  it('does not call correctionStore.update when correction specialist is missing', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(undefined);
    await runCorrectionAgent(deps, [createCandidate('a')]);
    expect(deps.correctionStore.update).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // prefetchedPending vs store.listPending
  // -------------------------------------------------------------------------

  it('uses prefetchedPending instead of calling store.listPending', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockResolvedValue(APPLIED_OK_WITH_REVAL);
    deps.toolWrapperRun = { execute: mockExecute };

    await runCorrectionAgent(deps, [createCandidate('x')]);

    expect(deps.correctionStore.listPending).not.toHaveBeenCalled();
  });

  it('calls store.listPending when prefetchedPending is not provided', async () => {
    vi.mocked(deps.correctionStore.listPending).mockReturnValue([]);
    await runCorrectionAgent(deps);
    expect(deps.correctionStore.listPending).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Batch slicing (MAX_CANDIDATES_PER_RUN = 5)
  // -------------------------------------------------------------------------

  it('processes at most 5 candidates (MAX_CANDIDATES_PER_RUN) when given 7', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockResolvedValue(APPLIED_OK_WITH_REVAL);
    deps.toolWrapperRun = { execute: mockExecute };

    const candidates = Array.from({ length: 7 }, (_, i) => createCandidate(`c${i}`));
    const result = await runCorrectionAgent(deps, candidates);

    expect(result.processed).toBe(5);
    expect(result.skipped).toBe(2);
    // 5 agent calls + 5 re-validation calls = 10
    expect(mockExecute).toHaveBeenCalledTimes(10);
  });

  it('processes all candidates when count is below the batch limit', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockResolvedValue(APPLIED_OK_WITH_REVAL);
    deps.toolWrapperRun = { execute: mockExecute };

    const candidates = [createCandidate('a'), createCandidate('b'), createCandidate('c')];
    const result = await runCorrectionAgent(deps, candidates);

    expect(result.processed).toBe(3);
    expect(result.skipped).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Outcome: applied
  // -------------------------------------------------------------------------

  it('marks candidate as "applied" when outcome has applied:true and re-validation succeeds', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi
      .fn()
      .mockResolvedValue(
        '{"status":"ok","result":{"validated":true,"applied":true,"notes":"fixed","proposedGoodCall":{"specialistId":"shell-wrapper","input":"good"}}}',
      );
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-applied');
    const result = await runCorrectionAgent(deps, [candidate]);

    expect(result.applied).toBe(1);
    expect(deps.correctionStore.update).toHaveBeenCalledWith('id-applied', {
      status: 'applied',
      validated: true,
      notes: 'fixed',
    });
  });

  it('marks candidate as "invalid" when applied:true but proposedGoodCall is missing', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi
      .fn()
      .mockResolvedValue('{"status":"ok","result":{"validated":true,"applied":true}}');
    deps.toolWrapperRun = { execute: mockExecute };

    const result = await runCorrectionAgent(deps, [createCandidate('id-noreval')]);

    expect(result.applied).toBe(0);
    expect(deps.correctionStore.update).toHaveBeenCalledWith(
      'id-noreval',
      expect.objectContaining({
        status: 'invalid',
        validated: false,
        notes: expect.stringContaining('no proposedGoodCall'),
      }),
    );
  });

  it('marks candidate as "invalid" when applied:true but re-validation re-run returns error', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi
      .fn()
      // First call: agent claims applied:true with a proposedGoodCall
      .mockResolvedValueOnce(
        '{"status":"ok","result":{"validated":true,"applied":true,"proposedGoodCall":{"specialistId":"shell-wrapper","input":"good"}}}',
      )
      // Re-validation call: actually fails
      .mockResolvedValueOnce('{"status":"error","error":"still broken"}');
    deps.toolWrapperRun = { execute: mockExecute };

    const result = await runCorrectionAgent(deps, [createCandidate('id-revalfail')]);

    expect(result.applied).toBe(0);
    expect(deps.correctionStore.update).toHaveBeenCalledWith(
      'id-revalfail',
      expect.objectContaining({
        status: 'invalid',
        validated: false,
        notes: expect.stringContaining('re-validation failed'),
      }),
    );
  });

  it('increments applied counter correctly', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockResolvedValue(APPLIED_OK_WITH_REVAL);
    deps.toolWrapperRun = { execute: mockExecute };

    const result = await runCorrectionAgent(deps, [createCandidate('a'), createCandidate('b')]);

    expect(result.applied).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Outcome: rejected (validated but not applied)
  // -------------------------------------------------------------------------

  it('marks candidate as "rejected" when outcome has validated:true but applied:false', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi
      .fn()
      .mockResolvedValue('{"status":"ok","result":{"validated":true,"applied":false}}');
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-rejected');
    const result = await runCorrectionAgent(deps, [candidate]);

    expect(result.applied).toBe(0);
    expect(deps.correctionStore.update).toHaveBeenCalledWith('id-rejected', {
      status: 'rejected',
      validated: true,
      notes: 'Validated but not applied (agent declined commit).',
    });
  });

  it('uses provided notes in rejected update when present', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi
      .fn()
      .mockResolvedValue(
        '{"status":"ok","result":{"validated":true,"applied":false,"notes":"No changes needed"}}',
      );
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-rejected-notes');
    await runCorrectionAgent(deps, [candidate]);

    expect(deps.correctionStore.update).toHaveBeenCalledWith('id-rejected-notes', {
      status: 'rejected',
      validated: true,
      notes: 'No changes needed',
    });
  });

  // -------------------------------------------------------------------------
  // Outcome: invalid (wrapper returned error status)
  // -------------------------------------------------------------------------

  it('marks candidate as "invalid" when wrapper returns status "error"', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockResolvedValue('{"status":"error","result":"failed"}');
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-invalid');
    const result = await runCorrectionAgent(deps, [candidate]);

    expect(result.applied).toBe(0);
    expect(deps.correctionStore.update).toHaveBeenCalledWith('id-invalid', {
      status: 'invalid',
      validated: false,
      notes: 'Correction agent could not validate a fix.',
    });
  });

  it('marks candidate as "invalid" when output cannot be parsed at all', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockResolvedValue('completely unparseable output');
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-unparseable');
    await runCorrectionAgent(deps, [candidate]);

    expect(deps.correctionStore.update).toHaveBeenCalledWith('id-unparseable', {
      status: 'invalid',
      validated: false,
      notes: 'Correction agent could not validate a fix.',
    });
  });

  // -------------------------------------------------------------------------
  // Outcome: execute throws
  // -------------------------------------------------------------------------

  it('marks candidate as "invalid" when toolWrapperRun.execute throws an Error', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockRejectedValue(new Error('network timeout'));
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-throws');
    const result = await runCorrectionAgent(deps, [candidate]);

    expect(result.applied).toBe(0);
    expect(deps.correctionStore.update).toHaveBeenCalledWith('id-throws', {
      status: 'invalid',
      validated: false,
      notes: 'Correction agent errored: network timeout',
    });
  });

  it('marks candidate as "invalid" when toolWrapperRun.execute throws a non-Error', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockRejectedValue('string error');
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-throws-string');
    await runCorrectionAgent(deps, [candidate]);

    expect(deps.correctionStore.update).toHaveBeenCalledWith('id-throws-string', {
      status: 'invalid',
      validated: false,
      notes: 'Correction agent errored: string error',
    });
  });

  it('continues processing remaining candidates after one throws', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi
      .fn()
      .mockRejectedValueOnce(new Error('first fails'))
      // Second candidate: agent succeeds + re-validation succeeds
      .mockResolvedValueOnce(APPLIED_OK_WITH_REVAL)
      .mockResolvedValueOnce(APPLIED_OK_WITH_REVAL);
    deps.toolWrapperRun = { execute: mockExecute };

    const candidates = [createCandidate('a'), createCandidate('b')];
    const result = await runCorrectionAgent(deps, candidates);

    expect(result.processed).toBe(2);
    expect(result.applied).toBe(1);
    expect(deps.correctionStore.update).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Multiple candidates — mixed outcomes
  // -------------------------------------------------------------------------

  it('processes 3 candidates with mixed outcomes and updates each correctly', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi
      .fn()
      .mockResolvedValueOnce(
        '{"status":"ok","result":{"validated":true,"applied":true,"notes":"applied-note","proposedGoodCall":{"specialistId":"shell-wrapper","input":"good"}}}',
      )
      // c1 re-validation succeeds
      .mockResolvedValueOnce('{"status":"ok","result":"reval-ok"}')
      .mockResolvedValueOnce('{"status":"ok","result":{"validated":true,"applied":false}}')
      .mockResolvedValueOnce('{"status":"error","result":"bad"}');
    deps.toolWrapperRun = { execute: mockExecute };

    const candidates = [createCandidate('c1'), createCandidate('c2'), createCandidate('c3')];
    const result = await runCorrectionAgent(deps, candidates);

    expect(result.processed).toBe(3);
    expect(result.applied).toBe(1);

    expect(deps.correctionStore.update).toHaveBeenCalledWith('c1', {
      status: 'applied',
      validated: true,
      notes: 'applied-note',
    });
    expect(deps.correctionStore.update).toHaveBeenCalledWith('c2', {
      status: 'rejected',
      validated: true,
      notes: 'Validated but not applied (agent declined commit).',
    });
    expect(deps.correctionStore.update).toHaveBeenCalledWith('c3', {
      status: 'invalid',
      validated: false,
      notes: 'Correction agent could not validate a fix.',
    });
  });

  // -------------------------------------------------------------------------
  // toolWrapperRun injection — injected mock is used, factory is NOT called
  // -------------------------------------------------------------------------

  it('uses the injected toolWrapperRun.execute instead of the factory', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const injectedExecute = vi.fn().mockResolvedValue(APPLIED_OK_WITH_REVAL);
    deps.toolWrapperRun = { execute: injectedExecute };

    await runCorrectionAgent(deps, [createCandidate('inj')]);

    // 1 agent call + 1 re-validation call
    expect(injectedExecute).toHaveBeenCalledTimes(2);
  });

  it('calls toolWrapperRun.execute with the correction-agent specialistId', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const injectedExecute = vi.fn().mockResolvedValue(APPLIED_OK_WITH_REVAL);
    deps.toolWrapperRun = { execute: injectedExecute };

    await runCorrectionAgent(deps, [createCandidate('chk')]);

    const [args] = injectedExecute.mock.calls[0];
    expect(args.specialistId).toBe('correction-agent');
  });

  it('passes a toolCallId containing the candidate id to execute', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const injectedExecute = vi.fn().mockResolvedValue(APPLIED_OK_WITH_REVAL);
    deps.toolWrapperRun = { execute: injectedExecute };

    await runCorrectionAgent(deps, [createCandidate('my-id')]);

    const [, opts] = injectedExecute.mock.calls[0];
    expect(opts.toolCallId).toContain('my-id');
  });

  // -------------------------------------------------------------------------
  // JSON object return value handling
  // -------------------------------------------------------------------------

  it('handles execute returning a plain object (not a string) by JSON.stringify-ing it', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    // Return an object instead of a JSON string
    const objResult = {
      status: 'ok',
      result: {
        validated: true,
        applied: true,
        proposedGoodCall: { specialistId: 'shell-wrapper', input: 'good' },
      },
    };
    const injectedExecute = vi.fn().mockResolvedValue(objResult);
    deps.toolWrapperRun = { execute: injectedExecute };

    const candidate = createCandidate('obj-return');
    const result = await runCorrectionAgent(deps, [candidate]);

    // Should parse correctly from the stringified object
    expect(result.applied).toBe(1);
    expect(deps.correctionStore.update).toHaveBeenCalledWith('obj-return', {
      status: 'applied',
      validated: true,
      notes: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Return value shape
  // -------------------------------------------------------------------------

  it('returns correct processed count matching batch size', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const injectedExecute = vi
      .fn()
      .mockResolvedValue('{"status":"ok","result":{"validated":true,"applied":false}}');
    deps.toolWrapperRun = { execute: injectedExecute };

    const result = await runCorrectionAgent(deps, [createCandidate('p1'), createCandidate('p2')]);

    expect(result).toMatchObject({ processed: 2, applied: 0, skipped: 0 });
  });

  it('skipped equals total minus batch when list exceeds MAX_CANDIDATES_PER_RUN', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const injectedExecute = vi
      .fn()
      .mockResolvedValue('{"status":"ok","result":{"validated":false,"applied":false}}');
    deps.toolWrapperRun = { execute: injectedExecute };

    const candidates = Array.from({ length: 6 }, (_, i) => createCandidate(`s${i}`));
    const result = await runCorrectionAgent(deps, candidates);

    expect(result.processed).toBe(5);
    expect(result.skipped).toBe(1);
    expect(result.processed + result.skipped).toBe(6);
  });
});
