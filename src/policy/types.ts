import type { BernardConfig } from '../config.js';
import type { ConfirmThreshold } from '../risk.js';

/**
 * Per-turn input the Policy Engine sees. Pure data — sub-policies must be
 * deterministic over this shape. New fields are added here as sub-policies
 * grow in sophistication (see issues #167, #169, #170, #171, #173, #175).
 */
export interface PolicyInput {
  userInput: string;
  config: BernardConfig;
  turnIndex?: number;
  /** Raw text of the most recent prior user turn; undefined on the first turn. */
  previousUserInput?: string;
}

/**
 * Verbatim from issue #177. Every field is optional so future sub-policies
 * can extend without forcing call sites to handle every key. Today this PR
 * actively wires only `strategyId` and `scratch`; the rest carry default
 * sub-policy values that mirror current behavior and will be consumed by
 * downstream issues.
 */
export interface PolicyDecision {
  strategyId?: 'normal' | 'react' | 'pac' | 'single-shot';
  models?: Record<string, { provider: string; model: string }>;
  concise?: { enabled: boolean; maxLines?: number; maxBullets?: number };
  scratch?: { resetAll: boolean; resetPlanOnly: boolean; deletePlanKey: boolean; reason: string };
  caching?: { enabled: boolean };
  citations?: { requireForFactualClaims: boolean };
  /**
   * Issue #141: when on, every successful tool call this turn is registered
   * in the per-turn ProvenanceStore as `kind: 'tool-result'` and the SYSTEM
   * prompt instructs the model to attach `[^Sn]` markers to "verified" /
   * "confirmed" / "checked" claims. Mirrors the citations policy in shape;
   * the augment layer reads this flag via `AugmentOptions.evidenceEnabled`.
   */
  evidence?: { requireForVerifiedClaims: boolean };
  toolMode?: {
    mode: 'read-only' | 'write';
    requireConfirmForWrite: boolean;
    /**
     * Risk threshold that drives the unified confirmation gate (issue #144).
     * See {@link ConfirmThreshold}. The augment layer compares each tool
     * call's risk against this value and routes through `confirmAction`
     * when `shouldConfirm` returns true.
     */
    confirmThreshold: ConfirmThreshold;
  };
}

/** Raw feature map a sub-policy used to decide, for telemetry only. */
export type PolicySignals = Record<string, boolean | number | string>;

/**
 * What a sub-policy emits: its own sub-decision shape (the value for one
 * `PolicyDecision` key) plus a free-form `reason` string. Reason codes are
 * stable identifiers (kebab-case), not free prose — they end up in
 * `debugLog` and in the `/policy` REPL command output.
 *
 * `signals` is the optional diagnostic sibling of `reason`: where `reason`
 * names the branch that won, `signals` records what was live when it did. It
 * lives on the base rather than inside a policy's `T` because `T` is defined
 * as the value for one `PolicyDecision` key, and a debug payload is not that —
 * putting it there would make every future policy re-widen its own generic.
 */
export type SubDecision<T> = T & { reason: string; signals?: PolicySignals };

/** Pure per-turn function from input to one sub-decision. */
export type SubPolicy<T> = (input: PolicyInput) => SubDecision<T>;

export interface PolicyResult {
  decision: PolicyDecision;
  /** Map keyed by sub-policy name (e.g. `'strategy'`, `'scratch'`). */
  reasons: Record<string, string>;
  /** Same keying as {@link reasons}; only policies that expose one appear. */
  signals: Record<string, PolicySignals>;
}

export interface PolicyEngine {
  decide(input: PolicyInput): PolicyResult;
}
