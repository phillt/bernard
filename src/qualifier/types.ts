import type { BernardConfig } from '../config.js';
import type { PolicyDecision } from '../policy/types.js';

/** Strategy IDs the qualifier can pick. Mirrors `PolicyDecision['strategyId']`. */
export type StrategyId = NonNullable<PolicyDecision['strategyId']>;

/**
 * Per-turn input to the Qualifier. Pure data — `userText` is the raw user
 * message; `config` is the resolved runtime config (only consulted for
 * fallbacks / overrides today); `context` carries optional signals from the
 * surrounding turn that future routers may use (tool count, attachments,
 * conversation length). Keep it forward-compatible: new fields can be added
 * without breaking the contract.
 */
export interface QualificationInput {
  userText: string;
  config: BernardConfig;
  context?: {
    hasPlanTool?: boolean;
    hasToolCalls?: boolean;
    turnIndex?: number;
  };
}

/**
 * Result of one qualification call. `strategyId` is the chosen strategy;
 * `reason` is a kebab-case code naming the signal(s) that drove the choice
 * (used by `debugLog('policy:decide', …)` for telemetry / later tuning);
 * `signals` is the raw feature map a future learned router can train on.
 */
export interface QualificationResult {
  strategyId: StrategyId;
  reason: string;
  signals?: Record<string, boolean | number | string>;
}

/** Per-turn classifier. Implementations must be pure over {@link QualificationInput}. */
export interface Qualifier {
  qualify(input: QualificationInput): QualificationResult;
}
