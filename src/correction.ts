import type { BernardConfig } from './config.js';
import type { MemoryStore } from './memory.js';
import type { RAGStore } from './rag.js';
import type { RoutineStore } from './routines.js';
import type { ToolOptions } from './tools/types.js';
import type { CandidateStoreReader } from './specialist-candidates.js';
import { SpecialistStore } from './specialists.js';
import { CorrectionCandidateStore, type CorrectionCandidate } from './correction-candidates.js';
import { createToolWrapperRunTool } from './tools/tool-wrapper-run.js';
import { parseStructuredOutput, WrapperResultSchema } from './structured-output.js';
import { z } from 'zod';
import { debugLog } from './logger.js';
import { printInfo } from './output.js';

/** ID of the bundled correction-agent specialist. */
const CORRECTION_SPECIALIST_ID = 'correction-agent';

/** Max candidates processed per session close. Keeps shutdown fast. */
const MAX_CANDIDATES_PER_RUN = 5;

const CorrectionOutcomeSchema = z.object({
  /** Whether the correction-agent was able to derive a corrected call AND validate it. */
  validated: z.boolean(),
  /** Set when examples were actually appended to the target specialist. */
  applied: z.boolean(),
  /** Short explanation for logging. */
  notes: z.string().optional(),
});
type CorrectionOutcome = z.infer<typeof CorrectionOutcomeSchema>;

export interface RunCorrectionDeps {
  config: BernardConfig;
  toolOptions: ToolOptions;
  memoryStore: MemoryStore;
  specialistStore: SpecialistStore;
  correctionStore: CorrectionCandidateStore;
  ragStore?: RAGStore;
  routineStore?: RoutineStore;
  candidateStore?: CandidateStoreReader;
  mcpTools?: Record<string, any>;
  /** Optional pre-built tool for testing. Falls back to createToolWrapperRunTool(...) when absent. */
  toolWrapperRun?: { execute: (args: any, opts: any) => Promise<any> };
}

/**
 * Runs the correction-agent meta-specialist over any pending correction
 * candidates. Called at REPL shutdown when `BERNARD_CORRECTION_ENABLED` is
 * truthy and the bundled `correction-agent` specialist exists.
 *
 * The correction-agent receives one candidate at a time and is instructed
 * (via its system prompt + bundled examples) to:
 *   1. Propose a corrected tool call (proposedGood) and label the failed one
 *      (proposedBad).
 *   2. Validate by re-running the proposed good call via `tool_wrapper_run`
 *      against the target specialist.
 *   3. If validation succeeds, append examples to the target specialist via
 *      the `specialist` tool.
 *   4. Return a JSON object `{status, result: {validated, applied, notes?}}`.
 *
 * This orchestrator then updates the candidate's status based on the outcome.
 * It never mutates a specialist directly — the validation-before-commit rule
 * lives inside the correction-agent itself.
 */
export async function runCorrectionAgent(
  deps: RunCorrectionDeps,
  prefetchedPending?: CorrectionCandidate[],
): Promise<{
  processed: number;
  applied: number;
  skipped: number;
}> {
  const pending = prefetchedPending ?? deps.correctionStore.listPending();
  if (pending.length === 0) return { processed: 0, applied: 0, skipped: 0 };

  const correctionSpecialist = deps.specialistStore.get(CORRECTION_SPECIALIST_ID);
  if (!correctionSpecialist) {
    debugLog('correction:skip', `No specialist named "${CORRECTION_SPECIALIST_ID}" — skipping.`);
    return { processed: 0, applied: 0, skipped: pending.length };
  }

  const batch = pending.slice(0, MAX_CANDIDATES_PER_RUN);
  const toolWrapperRun =
    deps.toolWrapperRun ??
    createToolWrapperRunTool(
      deps.config,
      deps.toolOptions,
      deps.memoryStore,
      deps.specialistStore,
      deps.correctionStore,
      deps.mcpTools,
      deps.ragStore,
      deps.routineStore,
      deps.candidateStore,
    );

  let applied = 0;
  let processed = 0;
  const skipped = pending.length - batch.length;

  printInfo(
    `Running correction agent over ${batch.length} pending candidate${batch.length === 1 ? '' : 's'}...`,
  );

  for (const candidate of batch) {
    processed++;
    const input = formatCandidatePrompt(candidate);
    try {
      const raw = await toolWrapperRun.execute(
        {
          specialistId: CORRECTION_SPECIALIST_ID,
          input,
          context: null,
          provider: null,
          model: null,
        },
        { toolCallId: `correction-${candidate.id}`, messages: [] },
      );
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const outcome = extractOutcome(text);
      if (outcome && outcome.applied) {
        applied++;
        deps.correctionStore.update(candidate.id, {
          status: 'applied',
          validated: true,
          notes: outcome.notes,
        });
      } else if (outcome && outcome.validated) {
        deps.correctionStore.update(candidate.id, {
          status: 'rejected',
          validated: true,
          notes: outcome.notes ?? 'Validated but not applied (agent declined commit).',
        });
      } else {
        deps.correctionStore.update(candidate.id, {
          status: 'invalid',
          validated: false,
          notes: outcome?.notes ?? 'Correction agent could not validate a fix.',
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog('correction:error', { candidateId: candidate.id, message });
      deps.correctionStore.update(candidate.id, {
        status: 'invalid',
        validated: false,
        notes: `Correction agent errored: ${message}`,
      });
    }
  }

  if (applied > 0) {
    printInfo(`Correction agent updated ${applied} specialist${applied === 1 ? '' : 's'}.`);
  }
  return { processed, applied, skipped };
}

function formatCandidatePrompt(candidate: CorrectionCandidate): string {
  return [
    `Candidate ID: ${candidate.id}`,
    `Target specialist: ${candidate.specialistId}`,
    `Original request: ${candidate.input}`,
    `Attempted call: ${candidate.attemptedCall}`,
    `Error observed: ${candidate.error}`,
    '',
    'Diagnose the failure, propose a corrected tool call (proposedGood) and record the bad one (proposedBad), validate the fix by running tool_wrapper_run against the target specialist, and — only if validation returns status: "ok" — append the good/bad pair to the target specialist via the specialist tool (action: "update"). Report the final outcome.',
  ].join('\n');
}

export function extractOutcome(text: string): CorrectionOutcome | undefined {
  // The correction-agent returns the WrapperResult shape; its .result field is what we care about.
  const wrapper = parseStructuredOutput(text, WrapperResultSchema);
  if (wrapper && wrapper.status === 'ok') {
    const inner = CorrectionOutcomeSchema.safeParse(wrapper.result);
    if (inner.success) return inner.data;
    // Accept a minimal shape too
    if (wrapper.result && typeof wrapper.result === 'object') {
      const obj = wrapper.result as Record<string, unknown>;
      if (typeof obj.applied === 'boolean' || typeof obj.validated === 'boolean') {
        return {
          validated: Boolean(obj.validated),
          applied: Boolean(obj.applied),
          notes: typeof obj.notes === 'string' ? obj.notes : undefined,
        };
      }
    }
  }
  // Fallback — scan the text for a bare outcome object.
  return parseStructuredOutput(text, CorrectionOutcomeSchema);
}
