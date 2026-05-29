import { type CorrectionCandidate } from './correction-candidates.js';
import { createToolWrapperRunTool } from './tools/tool-wrapper-run.js';
import type { AgentContext } from './framework/context.js';
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
  /**
   * The proposed-good call the orchestrator can re-execute to independently
   * verify the agent's `applied: true` claim. Required for orchestrator-side
   * validation; missing values cause the candidate to be marked `invalid`.
   */
  proposedGoodCall: z
    .object({
      specialistId: z.string(),
      input: z.string(),
    })
    .optional(),
});
type CorrectionOutcome = z.infer<typeof CorrectionOutcomeSchema>;

export interface RunCorrectionDeps {
  ctx: AgentContext;
  /** Optional pre-built tool for testing. Falls back to createToolWrapperRunTool(ctx) when absent. */
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
  const correctionStore = deps.ctx.stores.correction;
  const pending = prefetchedPending ?? correctionStore.listPending();
  if (pending.length === 0) return { processed: 0, applied: 0, skipped: 0 };

  const correctionSpecialist = deps.ctx.stores.specialists.get(CORRECTION_SPECIALIST_ID);
  if (!correctionSpecialist) {
    debugLog('correction:skip', `No specialist named "${CORRECTION_SPECIALIST_ID}" — skipping.`);
    return { processed: 0, applied: 0, skipped: pending.length };
  }

  const batch = pending.slice(0, MAX_CANDIDATES_PER_RUN);
  const toolWrapperRun = deps.toolWrapperRun ?? createToolWrapperRunTool(deps.ctx);

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
        },
        { toolCallId: `correction-${candidate.id}`, messages: [] },
      );
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const outcome = extractOutcome(text);
      if (outcome && outcome.applied) {
        // Trust-but-verify: independently re-execute the proposed-good call
        // before accepting `applied: true`. If the agent didn't supply one or
        // the re-run fails, mark `invalid` instead of `applied` — otherwise
        // hallucinated examples sneak into the specialist's playbook.
        const reval = await revalidateProposedCall(
          toolWrapperRun,
          outcome.proposedGoodCall,
          candidate.id,
        );
        if (reval.ok) {
          applied++;
          correctionStore.update(candidate.id, {
            status: 'applied',
            validated: true,
            notes: outcome.notes,
          });
        } else {
          correctionStore.update(candidate.id, {
            status: 'invalid',
            validated: false,
            notes: `Correction agent claimed applied:true but re-validation failed: ${reval.reason}`,
          });
        }
      } else if (outcome && outcome.validated) {
        correctionStore.update(candidate.id, {
          status: 'rejected',
          validated: true,
          notes: outcome.notes ?? 'Validated but not applied (agent declined commit).',
        });
      } else {
        correctionStore.update(candidate.id, {
          status: 'invalid',
          validated: false,
          notes: outcome?.notes ?? 'Correction agent could not validate a fix.',
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog('correction:error', { candidateId: candidate.id, message });
      correctionStore.update(candidate.id, {
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

async function revalidateProposedCall(
  toolWrapperRun: { execute: (args: any, opts: any) => any },
  proposed: CorrectionOutcome['proposedGoodCall'],
  candidateId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!proposed) {
    return { ok: false, reason: 'no proposedGoodCall returned by correction agent' };
  }
  try {
    const raw = await toolWrapperRun.execute(
      { specialistId: proposed.specialistId, input: proposed.input },
      { toolCallId: `correction-reval-${candidateId}`, messages: [] },
    );
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const wrapper = parseStructuredOutput(text, WrapperResultSchema);
    if (wrapper && wrapper.status === 'ok') return { ok: true };
    const err = wrapper && wrapper.status === 'error' ? wrapper.error : 'unparseable result';
    return { ok: false, reason: `re-run returned ${err}`.slice(0, 200) };
  } catch (err) {
    return {
      ok: false,
      reason: `re-run threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    };
  }
}

function formatCandidatePrompt(candidate: CorrectionCandidate): string {
  return [
    `Candidate ID: ${candidate.id}`,
    `Target specialist: ${candidate.specialistId}`,
    `Original request: ${candidate.input}`,
    `Attempted call: ${candidate.attemptedCall}`,
    `Error observed: ${candidate.error}`,
    '',
    'Diagnose the failure, propose a corrected tool call (proposedGood) and record the bad one (proposedBad), validate the fix by running tool_wrapper_run against the target specialist, and — only if validation returns status: "ok" — append the good/bad pair to the target specialist via the specialist tool (action: "update"). Report the final outcome and include `proposedGoodCall: {specialistId, input}` so the orchestrator can re-verify your fix.',
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
