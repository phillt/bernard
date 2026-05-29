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

const ProposedExampleSchema = z.object({
  input: z.string(),
  call: z.string(),
  note: z.string().optional(),
});
const ProposedBadExampleSchema = ProposedExampleSchema.extend({
  error: z.string(),
  fix: z.string(),
});

const CorrectionOutcomeSchema = z.object({
  /** Whether the correction-agent was able to derive a corrected call AND validate it. */
  validated: z.boolean(),
  /**
   * Historical field — when present, the agent self-reported a commit. The
   * orchestrator now owns specialist mutation, so this is logged for
   * diagnostics only. The actual `status: 'applied'` decision is gated on
   * `validatedResult` and the orchestrator's own commit succeeding.
   */
  applied: z.boolean().optional(),
  /** Short explanation for logging. */
  notes: z.string().optional(),
  /**
   * The proposed-good call. Captured for orchestrator audit and (when the
   * target tool is read-only) optional re-execution. The call MUST target the
   * same specialist as the candidate — cross-specialist proposals are
   * rejected as invalid.
   */
  proposedGoodCall: z
    .object({
      specialistId: z.string(),
      input: z.string(),
    })
    .optional(),
  /**
   * The full {status, result, error?} envelope the agent observed when it ran
   * `proposedGoodCall` via `tool_wrapper_run`. The orchestrator verifies
   * `validatedResult.status === 'ok'` instead of re-executing, so write tools
   * (shell, file_edit_lines, MCP writes) don't suffer duplicate side-effects.
   * Accepted as either a structured object or a JSON-encoded string.
   */
  validatedResult: z.union([z.string(), z.record(z.unknown())]).optional(),
  /** Pair the orchestrator should append on success. */
  proposedGoodExample: ProposedExampleSchema.optional(),
  proposedBadExample: ProposedBadExampleSchema.optional(),
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
 * The agent's job is now *advisory only* — it proposes a corrected tool call,
 * validates it once via `tool_wrapper_run`, captures the observed envelope,
 * and returns the pair (good/bad example) it thinks should be appended. It
 * does NOT call `specialist update` itself.
 *
 * This orchestrator is the sole gate:
 *   1. Verifies `proposedGoodCall.specialistId === candidate.specialistId`
 *      (cross-specialist proposals are rejected).
 *   2. Reads `validatedResult` — the envelope the agent observed when it ran
 *      the proposed call — and accepts only when `status === 'ok'`.
 *   3. Commits the good/bad example pair via `specialistStore.appendExamples`.
 *
 * Verifying the captured envelope (rather than re-executing) is intentional:
 * the agent's validation step already ran the proposed call once; a second
 * orchestrator run would double-execute any side-effects (shell, file edits,
 * MCP writes). The shape-check trades one risk (orchestrator-verifiable
 * fabrication) for another (duplicate side-effects) and we pick the former.
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

      if (!outcome) {
        correctionStore.update(candidate.id, {
          status: 'invalid',
          validated: false,
          notes: 'Correction agent could not validate a fix.',
        });
        continue;
      }

      const gate = gateCommit(outcome, candidate);
      if (gate.ok) {
        const committed = deps.ctx.stores.specialists.appendExamples(
          candidate.specialistId,
          gate.good,
          gate.bad,
        );
        if (committed) {
          applied++;
          correctionStore.update(candidate.id, {
            status: 'applied',
            validated: true,
            proposedGood: gate.good?.call,
            proposedBad: gate.bad?.call,
            notes: outcome.notes,
          });
        } else {
          correctionStore.update(candidate.id, {
            status: 'invalid',
            validated: false,
            notes: `Target specialist "${candidate.specialistId}" not found at commit time.`,
          });
        }
      } else if (gate.rejected) {
        correctionStore.update(candidate.id, {
          status: 'rejected',
          validated: true,
          notes: outcome.notes ?? 'Validated but not applied (agent declined commit).',
        });
      } else {
        correctionStore.update(candidate.id, {
          status: 'invalid',
          validated: false,
          notes: outcome.notes
            ? `${outcome.notes} (${gate.reason})`
            : `Correction agent could not validate a fix: ${gate.reason}.`,
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

type GateResult =
  | {
      ok: true;
      good?: { input: string; call: string; note?: string };
      bad?: { input: string; call: string; note?: string; error: string; fix: string };
    }
  | { ok: false; rejected: true; reason: string }
  | { ok: false; rejected: false; reason: string };

/**
 * Decides whether to commit the agent's proposed examples and what the gate
 * result is. The agent already ran `proposedGoodCall` once and captured its
 * envelope in `validatedResult`; we verify that captured shape here instead
 * of re-executing so write tools don't double-fire.
 *
 * The pair is only committed when ALL of the following hold:
 *   - `proposedGoodCall` is present
 *   - `proposedGoodCall.specialistId` matches `candidate.specialistId`
 *   - `validatedResult` parses as `{status: 'ok', ...}`
 *   - At least one of `proposedGoodExample` / `proposedBadExample` is present
 *
 * `validated:true, applied:false` from the agent → `rejected` (no commit, but
 * candidate marked validated). Anything else → `invalid`.
 */
function gateCommit(outcome: CorrectionOutcome, candidate: CorrectionCandidate): GateResult {
  if (!outcome.proposedGoodCall) {
    if (outcome.validated && outcome.applied === false) {
      return { ok: false, rejected: true, reason: 'agent declined commit' };
    }
    return {
      ok: false,
      rejected: false,
      reason: 'no proposedGoodCall returned by correction agent',
    };
  }
  if (outcome.proposedGoodCall.specialistId !== candidate.specialistId) {
    return {
      ok: false,
      rejected: false,
      reason: `proposedGoodCall targets "${outcome.proposedGoodCall.specialistId}" but candidate is for "${candidate.specialistId}"`,
    };
  }

  const envelopeStatus = parseValidatedStatus(outcome.validatedResult);
  if (envelopeStatus !== 'ok') {
    if (outcome.validated && outcome.applied === false) {
      return { ok: false, rejected: true, reason: 'agent declined commit' };
    }
    const detail =
      envelopeStatus === 'missing'
        ? 'validatedResult missing — no observable proof the proposed call succeeded'
        : `validatedResult.status === "${envelopeStatus}" — the proposed call did not succeed`;
    return { ok: false, rejected: false, reason: detail };
  }

  const good = outcome.proposedGoodExample;
  const bad = outcome.proposedBadExample;
  if (!good && !bad) {
    return {
      ok: false,
      rejected: false,
      reason: 'no proposedGoodExample or proposedBadExample to append',
    };
  }
  return { ok: true, good, bad };
}

/**
 * Parses the agent's captured `validatedResult`. The value may arrive as an
 * already-structured object or as a JSON-encoded string (LLMs frequently
 * stringify nested envelopes). Returns the discriminated `status` string,
 * `'parse_failed'` for unrecognized shape, or `'missing'` when absent.
 */
function parseValidatedStatus(
  value: CorrectionOutcome['validatedResult'],
): 'ok' | 'error' | 'parse_failed' | 'missing' {
  if (value === undefined) return 'missing';
  let candidate: unknown = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value);
    } catch {
      return 'parse_failed';
    }
  }
  const parsed = parseStructuredOutput(JSON.stringify(candidate), WrapperResultSchema);
  if (!parsed) return 'parse_failed';
  return parsed.status === 'ok' ? 'ok' : 'error';
}

function formatCandidatePrompt(candidate: CorrectionCandidate): string {
  return [
    `Candidate ID: ${candidate.id}`,
    `Target specialist: ${candidate.specialistId}`,
    `Original request: ${candidate.input}`,
    `Attempted call: ${candidate.attemptedCall}`,
    `Error observed: ${candidate.error}`,
    '',
    'Diagnose the failure and propose a fix. Run `tool_wrapper_run` ONCE with the target specialist to validate your proposed call — capture the full `{status, result, error?}` envelope you observe. Do NOT call `specialist update`; the orchestrator commits the example pair after verifying your captured envelope.',
    '',
    'Return JSON: `{validated: boolean, proposedGoodCall: {specialistId, input}, validatedResult: <captured envelope>, proposedGoodExample: {input, call, note?}, proposedBadExample: {input, call, error, fix, note?}, notes?: string}`.',
    `proposedGoodCall.specialistId MUST equal "${candidate.specialistId}" — cross-specialist proposals are rejected.`,
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
