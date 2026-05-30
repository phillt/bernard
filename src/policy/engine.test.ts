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
      ['caching', 'citations', 'concise', 'models', 'scratch', 'strategy', 'toolMode'].sort(),
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
