import { vi } from 'vitest';
import type { StrategyContext } from '../types.js';
import type { BernardConfig } from '../../../config.js';

/**
 * Shared strategy-test fixtures, in the shape of `src/ui/__tests__/_keys.ts`
 * and `src/policy/test-helpers.ts`.
 *
 * `react.test.ts` and `plan-reconcile.test.ts` exercise the same `enforcePlan`
 * code path from either side of the ReAct/Normal split, so a drift between two
 * copies of these fixtures would silently give the two suites different inputs
 * for shared behaviour — and `StrategyContext` gains fields often enough that
 * the copies would drift.
 */

/** A turn that finished cleanly and called no tools. */
export const baseResult = {
  finishReason: 'stop',
  steps: [],
  response: { messages: [] },
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
} as any;

/**
 * A turn that invoked at least one tool. Missing-plan enforcement only fires
 * for these — the trivial-turn escape hatch skips tool-free turns.
 */
export const toolUseResult = {
  ...baseResult,
  steps: [{ toolCalls: [{ toolName: 'shell' }] }],
} as any;

/** Minimal `StrategyContext` with a spy `iterate`. Defaults to a ReAct turn. */
export function makeCtx(
  overrides: Partial<StrategyContext> & { config?: Partial<BernardConfig> } = {},
): StrategyContext & { iterate: ReturnType<typeof vi.fn> } {
  const { config: configOverride, ...rest } = overrides;
  return {
    config: { coordinatorMode: 'on', maxSteps: 10, ...configOverride } as BernardConfig,
    userInput: 'do stuff',
    iterate: vi.fn(async () => baseResult),
    ...rest,
  } as any;
}
