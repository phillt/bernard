import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as logger from '../logger.js';
import { DefaultPolicyEngine } from './engine.js';
import { MODEL_COMPONENTS } from './model.js';
import { makePolicyInput } from './test-helpers.js';

vi.mock('../logger.js', () => ({ debugLog: vi.fn() }));

describe('DefaultPolicyEngine', () => {
  beforeEach(() => {
    vi.mocked(logger.debugLog).mockClear();
  });

  it('populates every PolicyDecision key from its sub-policy', () => {
    const engine = new DefaultPolicyEngine();
    const { decision } = engine.decide(makePolicyInput({ config: { coordinatorMode: 'on' } }));

    expect(decision.strategyId).toBe('react');
    expect(Object.keys(decision.models ?? {}).sort()).toEqual([...MODEL_COMPONENTS].sort());
    // concisePolicy now reads config.conciseMode (default true in test helper).
    expect(decision.concise?.enabled).toBe(true);
    expect(decision.concise?.maxBullets).toBe(6);
    expect(decision.concise?.maxLines).toBe(12);
    // First turn (no previousUserInput) → scratchPolicy clears everything.
    expect(decision.scratch).toEqual({
      resetAll: true,
      resetPlanOnly: true,
      deletePlanKey: true,
      reason: 'first-turn',
    });
    expect(decision.caching?.enabled).toBe(false);
    expect(decision.citations?.requireForFactualClaims).toBe(true);
    expect(decision.evidence?.requireForVerifiedClaims).toBe(true);
    expect(decision.toolMode).toEqual({
      mode: 'read-only',
      requireConfirmForWrite: true,
      confirmThreshold: 'high',
    });
  });

  it('emits a reason code for every sub-policy', () => {
    const engine = new DefaultPolicyEngine();
    const { reasons } = engine.decide(makePolicyInput());
    expect(Object.keys(reasons).sort()).toEqual(
      [
        'caching',
        'citations',
        'concise',
        'evidence',
        'models',
        'scratch',
        'strategy',
        'toolMode',
      ].sort(),
    );
    for (const value of Object.values(reasons)) {
      expect(value).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('logs the decision via debugLog under the "policy:decide" label', () => {
    const engine = new DefaultPolicyEngine();
    engine.decide(makePolicyInput());
    // scratchPolicy also logs `scratch:reset`, so the engine's `policy:decide`
    // is one of multiple calls. Find it explicitly.
    const calls = vi.mocked(logger.debugLog).mock.calls;
    const policyDecideCall = calls.find(([label]) => label === 'policy:decide');
    expect(policyDecideCall).toBeDefined();
    expect(policyDecideCall![1]).toHaveProperty('decision');
    expect(policyDecideCall![1]).toHaveProperty('reasons');
  });

  it('logs the qualifier feature map alongside the decision (#385)', () => {
    // `reason` names the winning branch; `signals` names what was live when it
    // won. Without this a misclassification is only diagnosable by reading the
    // qualifier source and reconstructing its inputs.
    const engine = new DefaultPolicyEngine();
    engine.decide(makePolicyInput({ config: { coordinatorMode: 'auto' } }));
    const calls = vi.mocked(logger.debugLog).mock.calls;
    const payload = calls.find(([label]) => label === 'policy:decide')![1] as {
      signals?: Record<string, Record<string, unknown>>;
    };
    // Keyed by sub-policy name, the same shape as `reasons` — so a future
    // policy exposing signals is attributed rather than merged into one blob.
    expect(payload.signals!.strategy).toMatchObject({
      multiStep: expect.any(Boolean),
      toolKw: expect.any(Boolean),
      bloom: expect.any(String),
    });
    expect(typeof payload.signals!.strategy.tokens).toBe('number');
  });

  it('omits sub-policies that expose no signals', () => {
    // Only the qualifier has a feature map today; the other seven must not
    // appear as empty keys.
    const engine = new DefaultPolicyEngine();
    const result = engine.decide(makePolicyInput({ config: { coordinatorMode: 'auto' } }));
    expect(Object.keys(result.signals)).toEqual(['strategy']);
  });

  it('exposes no signals for the coordinator-mode short-circuits', () => {
    // `on`/`off` never consult the qualifier, so there is nothing to report.
    const engine = new DefaultPolicyEngine();
    expect(engine.decide(makePolicyInput({ config: { coordinatorMode: 'on' } })).signals).toEqual(
      {},
    );
  });

  it('reacts to config.coordinatorMode changes between calls', () => {
    const engine = new DefaultPolicyEngine();
    const off = engine.decide(makePolicyInput({ config: { coordinatorMode: 'off' } }));
    const on = engine.decide(makePolicyInput({ config: { coordinatorMode: 'on' } }));
    expect(off.decision.strategyId).toBe('normal');
    expect(off.reasons.strategy).toBe('coordinator-mode-off');
    expect(on.decision.strategyId).toBe('react');
    expect(on.reasons.strategy).toBe('coordinator-mode-on');
  });
});
