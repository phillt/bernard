import { debugLog } from '../logger.js';
import { cachingPolicy } from './caching.js';
import { citationsPolicy } from './citations.js';
import { concisePolicy } from './concise.js';
import { modelPolicy } from './model.js';
import { scratchPolicy } from './scratch.js';
import { strategyPolicy } from './strategy.js';
import { toolModePolicy } from './tool-mode.js';
import type { PolicyDecision, PolicyEngine, PolicyInput, PolicyResult } from './types.js';

/**
 * Composes every sub-policy in a fixed order, builds a {@link PolicyDecision}
 * plus a parallel reason map, and logs one entry per call when
 * `BERNARD_DEBUG` is on.
 *
 * Sub-policies are pure functions over {@link PolicyInput}. Adding a new
 * heuristic is: create `src/policy/<name>.ts` that exports a `SubPolicy<…>`,
 * import + invoke it here, write `<name>.test.ts`. The engine itself stays
 * trivial — that's the point.
 */
export class DefaultPolicyEngine implements PolicyEngine {
  decide(input: PolicyInput): PolicyResult {
    const strategy = strategyPolicy(input);
    const models = modelPolicy(input);
    const concise = concisePolicy(input);
    const scratch = scratchPolicy(input);
    const caching = cachingPolicy(input);
    const citations = citationsPolicy(input);
    const toolMode = toolModePolicy(input);

    const decision: PolicyDecision = {
      strategyId: strategy.id,
      models: models.models,
      concise: {
        enabled: concise.enabled,
        maxLines: concise.maxLines,
        maxBullets: concise.maxBullets,
      },
      scratch: {
        resetAll: scratch.resetAll,
        resetPlanOnly: scratch.resetPlanOnly,
        deletePlanKey: scratch.deletePlanKey,
        reason: scratch.reason,
      },
      caching: { enabled: caching.enabled },
      citations: { requireForFactualClaims: citations.requireForFactualClaims },
      toolMode: {
        mode: toolMode.mode,
        requireConfirmForWrite: toolMode.requireConfirmForWrite,
      },
    };

    const reasons: Record<string, string> = {
      strategy: strategy.reason,
      models: models.reason,
      concise: concise.reason,
      scratch: scratch.reason,
      caching: caching.reason,
      citations: citations.reason,
      toolMode: toolMode.reason,
    };

    debugLog('policy:decide', { decision, reasons });

    return { decision, reasons };
  }
}
