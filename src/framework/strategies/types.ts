import type { CoreMessage } from 'ai';
import type { BernardConfig } from '../../config.js';
import type { PlanStore } from '../../plan-store.js';
import type { AgentResult } from '../runner.js';

/**
 * Options passed to a per-iteration {@link IterateFn} call. A strategy uses
 * these to control the spec the caller assembles for one `runAgent` invocation.
 */
export interface IterateOpts {
  /** Extra messages to append after the caller's seed (initial call: `[]`). */
  extra: CoreMessage[];
  /** Appended to the caller's base system prompt for this call. */
  systemSuffix?: string;
  /** Exact `maxSteps` value to use for this call. Overrides the caller's base. */
  maxStepsOverride?: number;
}

/**
 * Caller-side: builds the spec from a base + the strategy's per-call overrides
 * and runs `runAgent`. Sites differ in how they assemble messages — main agent
 * pushes `extra` into mutable history and reads it back; specialist-run
 * rebuilds `[{user}, ...extra]` from scratch each call. Both are valid as long
 * as the impl is consistent across iterations.
 */
export type IterateFn = (opts: IterateOpts) => Promise<AgentResult>;

/**
 * Context handed to a strategy. Carries the per-run scalars a strategy needs
 * plus the `iterate` callback that runs one `runAgent` invocation.
 */
export interface StrategyContext {
  config: BernardConfig;
  userInput: string;
  abortSignal?: AbortSignal;
  /** Prefix for log lines emitted from the strategy (e.g. `[id]` for specialists). */
  prefix?: string;
  /** Plan store used by plan enforcement (ReAct and reconcile alike); same instance the plan tool mutates. */
  planStore?: PlanStore;
  /** Returns true when the most recent iterate result hit `maxSteps`. Called
   *  by ReActStrategy after its initial iterate. Defaults to false. */
  getStepLimitHit?: () => boolean;
  /**
   * The caller's per-call base `maxSteps` before any strategy multiplier. ReAct
   * triples this value (clamped by {@link computeEffectiveMaxSteps}). Defaults
   * to `config.maxSteps` when undefined — used by callers that further reduce
   * the budget (specialist-run halves it). */
  baseMaxSteps?: number;
  iterate: IterateFn;
}

/**
 * A composable post-call wrapper around the iterate callback. Strategies are
 * decorators: each wraps an inner strategy (or {@link NormalStrategy} at the
 * leaf) and may call `inner.run` multiple times with retry messages.
 *
 * Sites typically obtain a strategy via {@link buildStrategy}.
 */
export interface ExecutionStrategy {
  run(ctx: StrategyContext): Promise<AgentResult>;
}
