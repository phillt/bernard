import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCorrectionAgent, extractOutcome } from './correction.js';
import type { RunCorrectionDeps } from './correction.js';
import type { CorrectionWork } from './correction-queue.js';
import type { QueueItem } from './work-queue.js';
import type { AgentContext } from './framework/context.js';
import { makeTestContext } from './__tests__/agent-context.js';

vi.mock('./logger.js', () => ({ debugLog: vi.fn() }));
vi.mock('./output.js', () => ({ printInfo: vi.fn() }));
// Do NOT mock structured-output.js or zod — let real parsing happen for extractOutcome tests
// Do NOT mock tool-wrapper-run.js — we'll inject mock via deps.toolWrapperRun

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockDeps = RunCorrectionDeps & {
  specialistStore: {
    get: ReturnType<typeof vi.fn>;
    appendExamples: ReturnType<typeof vi.fn>;
  };
  correctionStore: {
    pending: ReturnType<typeof vi.fn>;
    claim: ReturnType<typeof vi.fn>;
    done: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
};

function createMockDeps(overrides?: Partial<RunCorrectionDeps>): MockDeps {
  const specialistStore = {
    get: vi.fn(),
    // Returns a truthy "updated specialist" so gateCommit treats appendExamples as success.
    appendExamples: vi.fn(() => ({ id: 'shell-wrapper' })),
  };
  // A queue double rather than a store one. The three methods the drain uses
  // are the whole interface: how many are waiting, the oldest batch, and which
  // way each one ended.
  const claimed: Array<QueueItem<CorrectionWork>> = [];
  const correctionStore = {
    pending: vi.fn(() => claimed.length),
    claim: vi.fn((limit = Number.POSITIVE_INFINITY) => claimed.slice(0, limit)),
    done: vi.fn(),
    retry: vi.fn(),
    _seed: (items: Array<QueueItem<CorrectionWork>>) => claimed.splice(0, claimed.length, ...items),
  };
  // Over the shared base (#318): four of the six stores here were `{} as any`,
  // and the `mcp` bag omitted two fields `AgentContextMCP` requires.
  const ctx: AgentContext = makeTestContext({
    stores: { specialists: specialistStore, correction: correctionStore } as never,
  });
  return {
    ctx,
    ...overrides,
    specialistStore,
    correctionStore,
  };
}

function createCandidate(id: string): QueueItem<CorrectionWork> {
  return {
    id,
    enqueuedAt: new Date().toISOString(),
    attempts: 1,
    payload: {
      specialistId: 'shell-wrapper',
      input: 'test input',
      attemptedCall: 'shell {"command":"bad"}',
      error: 'command not found',
    },
  };
}

const VALID_SPECIALIST = { id: 'correction-agent', kind: 'meta', name: 'Correction Agent' };

/**
 * Correction-agent result the orchestrator should accept and commit:
 *  - validated:true + applied:true
 *  - proposedGoodCall.specialistId matches the candidate (shell-wrapper)
 *  - validatedResult is a captured ok-envelope (no re-execution needed)
 *  - both proposedGoodExample and proposedBadExample present
 */
const APPLIED_OK_PAYLOAD = JSON.stringify({
  status: 'ok',
  result: {
    validated: true,
    applied: true,
    proposedGoodCall: { specialistId: 'shell-wrapper', input: 'do the thing' },
    validatedResult: '{"status":"ok","result":"ran"}',
    proposedGoodExample: { input: 'in', call: 'shell {"command":"ok"}' },
    proposedBadExample: {
      input: 'in',
      call: 'shell {"command":"bad"}',
      error: 'boom',
      fix: 'use this',
    },
  },
});

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

  it('returns {0,0,0} when the queue is empty', async () => {
    deps.correctionStore._seed([]);
    const result = await runCorrectionAgent(deps);
    expect(result).toEqual({ processed: 0, applied: 0, skipped: 0 });
  });

  it('asks the queue how much is waiting before claiming anything', async () => {
    deps.correctionStore._seed([]);
    const result = await runCorrectionAgent(deps);
    expect(deps.correctionStore.pending).toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, applied: 0, skipped: 0 });
  });

  it('skips all candidates when correction specialist is not found', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(undefined);
    const candidates = [createCandidate('a'), createCandidate('b'), createCandidate('c')];
    deps.correctionStore._seed(candidates);
    const result = await runCorrectionAgent(deps);
    expect(result).toEqual({ processed: 0, applied: 0, skipped: 3 });
  });

  it('acknowledges nothing when the correction specialist is missing', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(undefined);
    deps.correctionStore._seed([createCandidate('a')]);
    await runCorrectionAgent(deps);
    expect(deps.correctionStore.done).not.toHaveBeenCalled();
    expect(deps.correctionStore.retry).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // claiming
  // -------------------------------------------------------------------------

  it('claims its own batch rather than being handed one', async () => {
    // The caller used to prefetch `listPending()` and pass it in, to avoid a
    // second full readdir-and-parse of every row ever written. The queue does not
    // have that cost, so the drain owns its own batch and there is one fewer way
    // for the caller and the store to disagree about what is pending.
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    deps.toolWrapperRun = { execute: vi.fn().mockResolvedValue(APPLIED_OK_PAYLOAD) };

    deps.correctionStore._seed([createCandidate('x')]);

    await runCorrectionAgent(deps);

    expect(deps.correctionStore.claim).toHaveBeenCalled();
  });

  it('claims OLDEST-first, with the per-run limit', async () => {
    // The predecessor read every row, sorted DESCENDING by `createdAt` and took
    // the first five — so with six pending the oldest never ran again, and was
    // re-read and re-parsed on every session forever.
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    deps.toolWrapperRun = { execute: vi.fn().mockResolvedValue(APPLIED_OK_PAYLOAD) };
    deps.correctionStore._seed(Array.from({ length: 7 }, (_, i) => createCandidate(`c${i}`)));
    const result = await runCorrectionAgent(deps);
    expect(deps.correctionStore.claim).toHaveBeenCalledWith(5);
    // …and the two it could not take are reported, not silently dropped.
    expect(result.processed).toBe(5);
    expect(result.skipped).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Batch slicing (MAX_CANDIDATES_PER_RUN = 5)
  // -------------------------------------------------------------------------

  it('processes at most 5 candidates (MAX_CANDIDATES_PER_RUN) when given 7', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockResolvedValue(APPLIED_OK_PAYLOAD);
    deps.toolWrapperRun = { execute: mockExecute };

    const candidates = Array.from({ length: 7 }, (_, i) => createCandidate(`c${i}`));
    deps.correctionStore._seed(candidates);
    const result = await runCorrectionAgent(deps);

    expect(result.processed).toBe(5);
    expect(result.skipped).toBe(2);
    // Orchestrator no longer re-executes — agent runs once per candidate.
    expect(mockExecute).toHaveBeenCalledTimes(5);
  });

  it('processes all candidates when count is below the batch limit', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockResolvedValue(APPLIED_OK_PAYLOAD);
    deps.toolWrapperRun = { execute: mockExecute };

    const candidates = [createCandidate('a'), createCandidate('b'), createCandidate('c')];
    deps.correctionStore._seed(candidates);
    const result = await runCorrectionAgent(deps);

    expect(result.processed).toBe(3);
    expect(result.skipped).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Outcome: applied
  // -------------------------------------------------------------------------

  it('acknowledges the item when the example pair is committed', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const payload = JSON.stringify({
      status: 'ok',
      result: {
        validated: true,
        applied: true,
        notes: 'fixed',
        proposedGoodCall: { specialistId: 'shell-wrapper', input: 'good' },
        validatedResult: '{"status":"ok","result":"ran"}',
        proposedGoodExample: { input: 'in', call: 'shell ok' },
        proposedBadExample: { input: 'in', call: 'shell bad', error: 'e', fix: 'f' },
      },
    });
    const mockExecute = vi.fn().mockResolvedValue(payload);
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-applied');
    deps.correctionStore._seed([candidate]);
    const result = await runCorrectionAgent(deps);

    expect(result.applied).toBe(1);
    expect(deps.specialistStore.appendExamples).toHaveBeenCalledWith(
      'shell-wrapper',
      expect.objectContaining({ input: 'in', call: 'shell ok' }),
      expect.objectContaining({ error: 'e', fix: 'f' }),
    );
    expect(deps.correctionStore.done).toHaveBeenCalledWith('id-applied');
  });

  it('retries when applied:true but proposedGoodCall is missing', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi
      .fn()
      .mockResolvedValue('{"status":"ok","result":{"validated":true,"applied":true}}');
    deps.toolWrapperRun = { execute: mockExecute };

    deps.correctionStore._seed([createCandidate('id-noreval')]);
    const result = await runCorrectionAgent(deps);

    expect(result.applied).toBe(0);
    // RETRIED, not written off: the first cut recorded this as `invalid` and
    // never looked again.
    expect(deps.correctionStore.retry).toHaveBeenCalledWith('id-noreval', expect.any(String));
  });

  it('retries when the captured validatedResult.status is "error"', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const payload = JSON.stringify({
      status: 'ok',
      result: {
        validated: true,
        applied: true,
        proposedGoodCall: { specialistId: 'shell-wrapper', input: 'good' },
        // Agent honestly captured a failing envelope — orchestrator rejects.
        validatedResult: '{"status":"error","error":"still broken"}',
        proposedGoodExample: { input: 'in', call: 'shell ok' },
      },
    });
    const mockExecute = vi.fn().mockResolvedValue(payload);
    deps.toolWrapperRun = { execute: mockExecute };

    deps.correctionStore._seed([createCandidate('id-revalfail')]);
    const result = await runCorrectionAgent(deps);

    expect(result.applied).toBe(0);
    expect(deps.specialistStore.appendExamples).not.toHaveBeenCalled();
    // RETRIED, not written off: the first cut recorded this as `invalid` and
    // never looked again.
    expect(deps.correctionStore.retry).toHaveBeenCalledWith('id-revalfail', expect.any(String));
  });

  it('increments applied counter correctly', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockResolvedValue(APPLIED_OK_PAYLOAD);
    deps.toolWrapperRun = { execute: mockExecute };

    deps.correctionStore._seed([createCandidate('a'), createCandidate('b')]);
    const result = await runCorrectionAgent(deps);

    expect(result.applied).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Outcome: rejected (validated but not applied)
  // -------------------------------------------------------------------------

  it('acknowledges a DECLINE, which is a decision rather than a failure', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi
      .fn()
      .mockResolvedValue('{"status":"ok","result":{"validated":true,"applied":false}}');
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-rejected');
    deps.correctionStore._seed([candidate]);
    const result = await runCorrectionAgent(deps);

    expect(result.applied).toBe(0);
    // A DECISION, not a failure: the agent validated and declined, so asking
    // again would put the same question to the same model.
    expect(deps.correctionStore.done).toHaveBeenCalledWith('id-rejected');
  });

  it('acknowledges a decline that carried notes', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi
      .fn()
      .mockResolvedValue(
        '{"status":"ok","result":{"validated":true,"applied":false,"notes":"No changes needed"}}',
      );
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-rejected-notes');
    deps.correctionStore._seed([candidate]);
    await runCorrectionAgent(deps);

    expect(deps.correctionStore.done).toHaveBeenCalledWith('id-rejected-notes');
  });

  // -------------------------------------------------------------------------
  // Outcome: invalid (wrapper returned error status)
  // -------------------------------------------------------------------------

  it('retries when the wrapper returns status "error"', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockResolvedValue('{"status":"error","result":"failed"}');
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-invalid');
    deps.correctionStore._seed([candidate]);
    const result = await runCorrectionAgent(deps);

    expect(result.applied).toBe(0);
    expect(deps.correctionStore.retry).toHaveBeenCalledWith('id-invalid', expect.any(String));
  });

  it('retries when the output cannot be parsed at all', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockResolvedValue('completely unparseable output');
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-unparseable');
    deps.correctionStore._seed([candidate]);
    await runCorrectionAgent(deps);

    expect(deps.correctionStore.retry).toHaveBeenCalledWith('id-unparseable', expect.any(String));
  });

  // -------------------------------------------------------------------------
  // Outcome: execute throws
  // -------------------------------------------------------------------------

  it('marks candidate as "invalid" when toolWrapperRun.execute throws an Error', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockRejectedValue(new Error('network timeout'));
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-throws');
    deps.correctionStore._seed([candidate]);
    const result = await runCorrectionAgent(deps);

    expect(result.applied).toBe(0);
    expect(deps.correctionStore.retry).toHaveBeenCalledWith('id-throws', expect.any(String));
  });

  it('marks candidate as "invalid" when toolWrapperRun.execute throws a non-Error', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi.fn().mockRejectedValue('string error');
    deps.toolWrapperRun = { execute: mockExecute };

    const candidate = createCandidate('id-throws-string');
    deps.correctionStore._seed([candidate]);
    await runCorrectionAgent(deps);

    expect(deps.correctionStore.retry).toHaveBeenCalledWith('id-throws-string', expect.any(String));
  });

  it('continues processing remaining candidates after one throws', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const mockExecute = vi
      .fn()
      .mockRejectedValueOnce(new Error('first fails'))
      // Second candidate: agent succeeds with a captured ok-envelope
      .mockResolvedValueOnce(APPLIED_OK_PAYLOAD);
    deps.toolWrapperRun = { execute: mockExecute };

    const candidates = [createCandidate('a'), createCandidate('b')];
    deps.correctionStore._seed(candidates);
    const result = await runCorrectionAgent(deps);

    expect(result.processed).toBe(2);
    expect(result.applied).toBe(1);
    // Both ended: one committed, and the thrown one went BACK on the queue
    // rather than being written off as `invalid` — the fix this change is for.
    expect(deps.correctionStore.done).toHaveBeenCalledTimes(1);
    expect(deps.correctionStore.retry).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Multiple candidates — mixed outcomes
  // -------------------------------------------------------------------------

  it('processes 3 candidates with mixed outcomes and ends each correctly', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const c1Payload = JSON.stringify({
      status: 'ok',
      result: {
        validated: true,
        applied: true,
        notes: 'applied-note',
        proposedGoodCall: { specialistId: 'shell-wrapper', input: 'good' },
        validatedResult: '{"status":"ok","result":"ran"}',
        proposedGoodExample: { input: 'in', call: 'shell ok' },
        proposedBadExample: { input: 'in', call: 'shell bad', error: 'e', fix: 'f' },
      },
    });
    const mockExecute = vi
      .fn()
      .mockResolvedValueOnce(c1Payload)
      .mockResolvedValueOnce('{"status":"ok","result":{"validated":true,"applied":false}}')
      .mockResolvedValueOnce('{"status":"error","result":"bad"}');
    deps.toolWrapperRun = { execute: mockExecute };

    const candidates = [createCandidate('c1'), createCandidate('c2'), createCandidate('c3')];
    deps.correctionStore._seed(candidates);
    const result = await runCorrectionAgent(deps);

    expect(result.processed).toBe(3);
    expect(result.applied).toBe(1);

    // One of each ending, which is the point of the case: committed and
    // declined are both DONE, and only the failed look comes back.
    expect(deps.correctionStore.done).toHaveBeenCalledWith('c1');
    expect(deps.correctionStore.done).toHaveBeenCalledWith('c2');
    expect(deps.correctionStore.retry).toHaveBeenCalledWith('c3', expect.any(String));
  });

  // -------------------------------------------------------------------------
  // toolWrapperRun injection — injected mock is used, factory is NOT called
  // -------------------------------------------------------------------------

  it('uses the injected toolWrapperRun.execute instead of the factory', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const injectedExecute = vi.fn().mockResolvedValue(APPLIED_OK_PAYLOAD);
    deps.toolWrapperRun = { execute: injectedExecute };

    deps.correctionStore._seed([createCandidate('inj')]);

    await runCorrectionAgent(deps);

    // Agent runs once per candidate; orchestrator does NOT re-execute.
    expect(injectedExecute).toHaveBeenCalledTimes(1);
  });

  it('calls toolWrapperRun.execute with the correction-agent specialistId', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const injectedExecute = vi.fn().mockResolvedValue(APPLIED_OK_PAYLOAD);
    deps.toolWrapperRun = { execute: injectedExecute };

    deps.correctionStore._seed([createCandidate('chk')]);

    await runCorrectionAgent(deps);

    const [args] = injectedExecute.mock.calls[0];
    expect(args.specialistId).toBe('correction-agent');
  });

  it('passes a toolCallId containing the candidate id to execute', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const injectedExecute = vi.fn().mockResolvedValue(APPLIED_OK_PAYLOAD);
    deps.toolWrapperRun = { execute: injectedExecute };

    deps.correctionStore._seed([createCandidate('my-id')]);

    await runCorrectionAgent(deps);

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
        validatedResult: { status: 'ok', result: 'ran' },
        proposedGoodExample: { input: 'in', call: 'shell ok' },
        proposedBadExample: { input: 'in', call: 'shell bad', error: 'e', fix: 'f' },
      },
    };
    const injectedExecute = vi.fn().mockResolvedValue(objResult);
    deps.toolWrapperRun = { execute: injectedExecute };

    const candidate = createCandidate('obj-return');
    deps.correctionStore._seed([candidate]);
    const result = await runCorrectionAgent(deps);

    // Should parse correctly from the stringified object
    expect(result.applied).toBe(1);
    expect(deps.correctionStore.done).toHaveBeenCalledWith('obj-return');
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

    deps.correctionStore._seed([createCandidate('p1'), createCandidate('p2')]);
    const result = await runCorrectionAgent(deps);

    expect(result).toMatchObject({ processed: 2, applied: 0, skipped: 0 });
  });

  it('skipped equals total minus batch when list exceeds MAX_CANDIDATES_PER_RUN', async () => {
    vi.mocked(deps.specialistStore.get).mockReturnValue(VALID_SPECIALIST as any);
    const injectedExecute = vi
      .fn()
      .mockResolvedValue('{"status":"ok","result":{"validated":false,"applied":false}}');
    deps.toolWrapperRun = { execute: injectedExecute };

    const candidates = Array.from({ length: 6 }, (_, i) => createCandidate(`s${i}`));
    deps.correctionStore._seed(candidates);
    const result = await runCorrectionAgent(deps);

    expect(result.processed).toBe(5);
    expect(result.skipped).toBe(1);
    expect(result.processed + result.skipped).toBe(6);
  });
});
