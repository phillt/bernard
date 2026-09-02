import { generateText } from 'ai';
import { getModelForConfig, getProviderOptionsForConfig } from './providers/index.js';
import { classifyError } from './error-taxonomy.js';
import type { ToolErrorType } from './framework/tools/types.js';
import { ALL_ROLE_IDS, type RoleId } from './model-roles.js';
import { LINEUP_TIERS, type Lineup, type LineupTier } from './lineups.js';
import type { BernardConfig } from './config.js';
import { debugLog } from './logger.js';
import { temperatureParam } from './providers/profiles.js';
import { mapWithConcurrency } from './concurrency.js';

/**
 * @module model-validate
 *
 * Live model validation. The model catalog (`src/providers/catalog.ts`) tells
 * us which models *exist in the world*; it cannot tell us whether a given
 * `(provider, model)` is actually callable with *this* user's API key on *this*
 * endpoint. The only authoritative answer is an empirical probe: fire a tiny
 * throwaway completion and classify the outcome.
 *
 * This catches the failure modes that silently broke lineups (#264 follow-up):
 *   - `not_found`   — the model name is wrong, or the account has no access
 *                     ("The requested model 'gpt-5-chat' does not exist").
 *   - `auth`        — the API key is missing/invalid for this provider.
 *   - `rate_limit`  — the account is out of quota (HTTP 429).
 *
 * What a probe CANNOT catch: a model that responds fine to "ping" but is too
 * weak to follow instructions on a real task (e.g. a model that loops on tool
 * calls without ever answering). Callers should surface that limitation.
 */

/** Wall-clock cap for a single probe before we abort it. */
const PROBE_TIMEOUT_MS = 15_000;
/** Default fan-out when probing many distinct models for one lineup. */
const PROBE_CONCURRENCY = 4;

export interface ModelProbeResult {
  provider: string;
  model: string;
  ok: boolean;
  /** Failure taxonomy category (undefined when `ok`). */
  category?: ToolErrorType;
  /** Trimmed provider error message (undefined when `ok`). */
  message?: string;
  latencyMs: number;
}

export interface ValidateModelOptions {
  /** Abort the probe early (chained under an internal timeout controller). */
  abortSignal?: AbortSignal;
  /** Override the per-probe timeout. */
  timeoutMs?: number;
}

/** Pull an HTTP status / errno / message out of a thrown AI SDK (or network) error. */
function extractError(err: unknown): { httpStatus?: number; errno?: string; message: string } {
  const e = err as {
    message?: unknown;
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    errno?: unknown;
  };
  const message = typeof e?.message === 'string' && e.message ? e.message : String(err);
  let httpStatus: number | undefined;
  if (typeof e?.statusCode === 'number') httpStatus = e.statusCode;
  else if (typeof e?.status === 'number') httpStatus = e.status;
  let errno: string | undefined;
  if (typeof e?.code === 'string') errno = e.code;
  else if (typeof e?.errno === 'string') errno = e.errno;
  return { httpStatus, errno, message };
}

/**
 * Refine the taxonomy category for the model-validation context. Providers
 * report "model does not exist" with inconsistent HTTP codes (400 *or* 404), so
 * `classifyError` (which keys off status) may land on `invalid_args` for a 400.
 * A message-level signal corrects that to `not_found` so the user sees the real
 * cause ("this model name is wrong / inaccessible") rather than a generic
 * argument error.
 */
const NOT_FOUND_RE =
  /does not exist|model_not_found|no such model|not found|unknown model|invalid model|model.*not.*available/i;

function refineCategory(category: ToolErrorType, message: string): ToolErrorType {
  // Never downgrade an auth/quota signal — those are more actionable than not_found.
  if (category === 'auth' || category === 'rate_limit' || category === 'permission')
    return category;
  if (NOT_FOUND_RE.test(message)) return 'not_found';
  return category;
}

/**
 * Live-probe a single `(provider, model)` with the user's configured key. Sends
 * a 1-token "ping" and reports whether it succeeded. Never throws — every
 * failure path resolves to `{ ok: false, category, message }`.
 */
export async function validateModel(
  config: BernardConfig,
  provider: string,
  model: string,
  opts: ValidateModelOptions = {},
): Promise<ModelProbeResult> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) ctrl.abort();
    else opts.abortSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    await generateText({
      model: getModelForConfig(config, provider, model),
      providerOptions: getProviderOptionsForConfig(config, provider),
      messages: [{ role: 'user', content: 'ping' }],
      maxSteps: 1,
      // OpenAI's responses endpoint rejects max_output_tokens < 16; keep the
      // probe at that floor so a too-small cap can't masquerade as a failure.
      maxTokens: 16,
      // Reasoning models (e.g. claude-opus-4-8, o-series) reject temperature
      // with a 400. Omit the field entirely for those models.
      ...temperatureParam(model, provider),
      abortSignal: ctrl.signal,
    });
    const latencyMs = Date.now() - t0;
    debugLog('model-validate:probe', { provider, model, ok: true, latencyMs });
    return { provider, model, ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const { httpStatus, errno, message } = extractError(err);
    const aborted = ctrl.signal.aborted && !opts.abortSignal?.aborted;
    const cls = classifyError({ message, httpStatus, errno });
    const category = aborted ? 'timeout' : refineCategory(cls.category, message);
    debugLog('model-validate:probe', {
      provider,
      model,
      ok: false,
      category,
      httpStatus,
      latencyMs,
    });
    return { provider, model, ok: false, category, message: message.slice(0, 300), latencyMs };
  } finally {
    clearTimeout(timer);
    if (opts.abortSignal) opts.abortSignal.removeEventListener('abort', onParentAbort);
  }
}

/** A distinct `(provider, model)` pair and the role×tier slots that reference it. */
export interface LineupSlotRef {
  role: RoleId;
  tier: LineupTier;
}

export interface LineupModelResult extends ModelProbeResult {
  /** Which role×tier cells in the lineup use this pair (for "fix this slot" hints). */
  slots: LineupSlotRef[];
}

export interface LineupValidation {
  lineupId: string;
  lineupName: string;
  results: LineupModelResult[];
  ok: boolean;
  /** Count of distinct failing pairs. */
  failures: number;
}

/** Collapse a lineup's 18 slots into the distinct `(provider, model)` pairs it references. */
function distinctPairs(
  lineup: Lineup,
): Map<string, { provider: string; model: string; slots: LineupSlotRef[] }> {
  const map = new Map<string, { provider: string; model: string; slots: LineupSlotRef[] }>();
  for (const role of ALL_ROLE_IDS) {
    for (const tier of LINEUP_TIERS) {
      const slot = lineup.roles[role]?.[tier];
      if (!slot) continue;
      const key = `${slot.provider}/${slot.model}`;
      const entry = map.get(key) ?? { provider: slot.provider, model: slot.model, slots: [] };
      entry.slots.push({ role, tier });
      map.set(key, entry);
    }
  }
  return map;
}

/**
 * Validate every distinct model in a lineup. Probes are deduped (a lineup that
 * uses one model in all 18 slots costs exactly one probe) and run with bounded
 * concurrency. Fails open: a probe that throws unexpectedly is reported as a
 * failure result, never rejects the whole call.
 */
export async function validateLineup(
  config: BernardConfig,
  lineup: Lineup,
  opts: ValidateModelOptions & { concurrency?: number } = {},
): Promise<LineupValidation> {
  const pairs = [...distinctPairs(lineup).values()];
  const probed = await mapWithConcurrency(
    pairs,
    opts.concurrency ?? PROBE_CONCURRENCY,
    async (p) => {
      const r = await validateModel(config, p.provider, p.model, opts);
      return { ...r, slots: p.slots } as LineupModelResult;
    },
  );
  const failures = probed.filter((r) => !r.ok).length;
  return {
    lineupId: lineup.id,
    lineupName: lineup.name,
    results: probed,
    ok: failures === 0,
    failures,
  };
}

/** One-line summary per probed model, e.g. `✓ openai/gpt-5.5` / `✗ xai/grok-build-0.1 — not_found`. */
export function formatProbeLine(r: ModelProbeResult): string {
  if (r.ok) return `✓ ${r.provider}/${r.model} (${r.latencyMs}ms)`;
  const detail = r.message ? `: ${r.message.split('\n')[0]!.slice(0, 120)}` : '';
  return `✗ ${r.provider}/${r.model} — ${r.category ?? 'error'}${detail}`;
}

/** Human-readable report for a whole lineup validation (CLI + agent tool share this). */
export function formatLineupValidation(v: LineupValidation): string {
  const header = v.ok
    ? `✓ Lineup "${v.lineupName}" (${v.lineupId}): all ${v.results.length} model(s) reachable.`
    : `✗ Lineup "${v.lineupName}" (${v.lineupId}): ${v.failures} of ${v.results.length} model(s) failed.`;
  const lines = v.results.map((r) => {
    const base = formatProbeLine(r);
    if (r.ok) return `  ${base}`;
    const where = r.slots.map((s) => `${s.role}/${s.tier}`).join(', ');
    return `  ${base}\n      used by: ${where}`;
  });
  return [header, ...lines].join('\n');
}
