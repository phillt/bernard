import { SpecialistStore } from './specialists.js';
import { CandidateStore, type SpecialistCandidate } from './specialist-candidates.js';
import { printInfo, printWarning } from './output.js';
import { debugLog } from './logger.js';

/** Promote a pending candidate to a full specialist, updating status and logging. */
export function promoteCandidate(
  candidate: Pick<
    SpecialistCandidate,
    'id' | 'draftId' | 'name' | 'description' | 'systemPrompt' | 'guidelines' | 'confidence'
  >,
  specialistStore: SpecialistStore,
  candidateStore: CandidateStore,
  threshold: number,
): void {
  specialistStore.create(
    candidate.draftId,
    candidate.name,
    candidate.description,
    candidate.systemPrompt,
    candidate.guidelines,
  );
  candidateStore.updateStatus(candidate.id, 'accepted');
  debugLog('repl:auto-create', {
    candidate: candidate.name,
    confidence: candidate.confidence,
    threshold,
  });
  printInfo(
    `Specialist auto-created: "${candidate.name}" (confidence: ${Math.round(candidate.confidence * 100)}%). Use /specialists to view.`,
  );
}

/** Re-evaluate all pending candidates and auto-create those meeting the threshold. */
export function promotePendingCandidates(
  candidateStore: CandidateStore,
  specialistStore: SpecialistStore,
  threshold: number,
): void {
  const pending = candidateStore.listPending();
  for (const c of pending) {
    if (c.confidence >= threshold) {
      try {
        promoteCandidate(c, specialistStore, candidateStore, threshold);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        debugLog('repl:auto-create', {
          action: 're-evaluate-failed',
          candidate: c.name,
          confidence: c.confidence,
          error: errorMessage,
        });
        printWarning(`Failed to auto-create specialist "${c.name}": ${errorMessage}`);
      }
    }
  }
}

export interface BootstrapResult {
  pending: SpecialistCandidate[];
  contextBlock: string | null;
}

/**
 * Reconcile and optionally auto-promote pending specialist candidates at session start.
 * Returns the remaining pending candidates (post-promotion) and a system-prompt context
 * block, or `null` when there's nothing pending.
 */
export function bootstrapPendingCandidates(
  candidateStore: CandidateStore,
  specialistStore: SpecialistStore,
  opts: { autoCreateSpecialists: boolean; autoCreateThreshold: number },
): BootstrapResult {
  candidateStore.pruneOld();
  candidateStore.reconcileSaved(specialistStore.list());
  if (opts.autoCreateSpecialists) {
    promotePendingCandidates(candidateStore, specialistStore, opts.autoCreateThreshold);
  }
  const pending = candidateStore.listPending();
  if (pending.length === 0) {
    return { pending, contextBlock: null };
  }
  const contextBlock = `## Specialist Suggestions\n\nBernard detected patterns in previous sessions that might benefit from saved specialists. Mention these when relevant.\n\n${pending.map((c) => `- "${c.name}" (${c.draftId}): ${c.description}`).join('\n')}`;
  return { pending, contextBlock };
}
