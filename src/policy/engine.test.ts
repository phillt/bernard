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
    const { decision } = engine.decide(makePolicyInput({ config: { reactMode: true } }));

    expect(decision.strategyId).toBe('react');
    expect(Object.keys(decision.models ?? {}).sort()).toEqual([...MODEL_COMPONENTS].sort());
    expect(decision.concise?.enabled).toBe(false);
    expect(decision.scratch).toEqual({
      resetAll: false,
      resetPlanOnly: true,
      reason: 'per-turn-default',
    });
    expect(decision.caching?.enabled).toBe(false);
    expect(decision.citations?.requireForFactualClaims).toBe(true);
    expect(decision.toolMode).toEqual({ mode: 'write', requireConfirmForWrite: true });
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
    expect(logger.debugLog).toHaveBeenCalledTimes(1);
    const [label, payload] = vi.mocked(logger.debugLog).mock.calls[0];
    expect(label).toBe('policy:decide');
    expect(payload).toHaveProperty('decision');
    expect(payload).toHaveProperty('reasons');
  });

  it('reacts to config.reactMode changes between calls', () => {
    const engine = new DefaultPolicyEngine();
    const off = engine.decide(makePolicyInput({ config: { reactMode: false } }));
    const on = engine.decide(makePolicyInput({ config: { reactMode: true } }));
    expect(off.decision.strategyId).toBe('normal');
    expect(off.reasons.strategy).toBe('react-mode-disabled');
    expect(on.decision.strategyId).toBe('react');
    expect(on.reasons.strategy).toBe('react-mode-flag');
  });
});
