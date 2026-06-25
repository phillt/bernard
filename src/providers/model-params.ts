/**
 * Provider-agnostic generation-parameter adapter (issue #286).
 *
 * Given a `(provider, model)` this module answers two questions behind one
 * uniform surface, so the lineup UI looks identical regardless of provider:
 *
 *  1. **What can I tune?** — `describeModelParams` returns capability-gated
 *     {@link ParamDescriptor}s (id, label, kind, options/min/max, default).
 *  2. **How do I send it?** — `serializeModelParams` splits chosen values into
 *     the two AI-SDK destinations the SDK insists on:
 *       - **top-level** `generateText` params: `temperature`, `topP`,
 *         `maxOutputTokens`;
 *       - **`providerOptions.<sdk>`**: xAI/OpenAI `reasoningEffort`, Anthropic
 *         `thinking: { type: 'enabled', budgetTokens }`.
 *
 * Capability detection is **catalog-first** (consistent with `getModelProfile`):
 * it reuses the catalog `reasoning` tag and `modelSupportsTemperature` rather
 * than inventing a parallel capability map. Family resolution keys off
 * `sdk ?? provider`, so a custom provider that wraps the OpenAI SDK (Ollama,
 * OpenRouter, …) gets the OpenAI param surface even though its registry name
 * isn't `openai` — mirroring `getProviderOptions(provider, custom?.sdk)`.
 */
import type { SupportedSdk } from './types.js';
import { getModelMeta, findModelMetaByName } from './catalog.js';
import { modelSupportsTemperature } from './profiles.js';

export type ParamKind = 'enum' | 'number' | 'range' | 'toggle';

/** The closed set of tunable param ids (issue #286). */
export const PARAM_IDS = [
  'temperature',
  'topP',
  'maxOutputTokens',
  'reasoningEffort',
  'thinkingBudget',
] as const;
export type ParamId = (typeof PARAM_IDS)[number];

export interface ParamDescriptor {
  /** Stable id, also the key in {@link ModelParams}. */
  id: ParamId;
  label: string;
  kind: ParamKind;
  /** For `enum`: the allowed values. */
  options?: string[];
  /** For `number`/`range`: inclusive bounds. */
  min?: number;
  max?: number;
  step?: number;
  /** A sensible default shown in the editor (not auto-applied). */
  default?: string | number | boolean;
}

/**
 * User-chosen values, keyed by {@link ParamId}. Narrowing to the closed id set
 * makes a typo (`temperture`) a compile error and lets the Zod schemas reject
 * unknown keys, rather than silently persisting junk that `validateModelParams`
 * later drops.
 */
export type ModelParams = Partial<Record<ParamId, string | number | boolean>>;

/** Resolve the SDK family that governs the param surface. */
function family(provider: string, sdk?: SupportedSdk): string {
  return (sdk ?? provider).toLowerCase();
}

/**
 * Catalog-first reasoning detection mirroring `getModelProfile`. Returns the
 * catalog tag when present, else applies the same family heuristics so a
 * catalog miss (custom proxy, brand-new model) still classifies correctly.
 */
function isReasoningModel(provider: string, model: string, sdk?: SupportedSdk): boolean {
  const meta = getModelMeta(provider, model) ?? findModelMetaByName(model);
  if (meta) return meta.tags.includes('reasoning');

  const m = model.toLowerCase();
  const fam = family(provider, sdk);
  if (fam === 'openai') return /^o\d/.test(m) || /^gpt-5/.test(m);
  if (fam === 'xai') {
    if (m.includes('non-reasoning')) return false;
    if (m.includes('reasoning')) return true;
    return /^grok-4(\b|[-.])/.test(m);
  }
  if (fam === 'anthropic') return false; // extended thinking is opt-in, not a gate
  return false;
}

/** Best-known max output tokens from the catalog (for the slider/validation cap). */
function maxOutputCap(provider: string, model: string): number | undefined {
  const meta = getModelMeta(provider, model) ?? findModelMetaByName(model);
  return meta?.maxOutputTokens;
}

/**
 * Returns the tunable params this `(provider, model)` actually supports —
 * capability-gated, so reasoning models never expose `temperature`, and only
 * reasoning-capable models expose `reasoningEffort` / `thinkingBudget`.
 * Empty array → the lineup UI skips the params step entirely (unchanged UX).
 */
export function describeModelParams(
  provider: string,
  model: string,
  sdk?: SupportedSdk,
): ParamDescriptor[] {
  const fam = family(provider, sdk);
  const reasoning = isReasoningModel(provider, model, sdk);
  const out: ParamDescriptor[] = [];

  // temperature / top_p — only on models that accept temperature (reasoning
  // models reject it). Gate on `!reasoning` AND `modelSupportsTemperature` so a
  // reasoning model never exposes BOTH temperature and reasoningEffort (which
  // the provider would 400 on); this also keeps the two capability checks from
  // diverging on a catalog-miss model the heuristics classify differently.
  if (!reasoning && modelSupportsTemperature(model, provider)) {
    out.push({ id: 'temperature', label: 'Temperature', kind: 'range', min: 0, max: 2, step: 0.1, default: 0 });
    out.push({ id: 'topP', label: 'Top-p', kind: 'range', min: 0, max: 1, step: 0.05, default: 1 });
  }

  // reasoning_effort — provider-specific option ladders.
  if (reasoning && fam === 'openai') {
    out.push({
      id: 'reasoningEffort',
      label: 'Reasoning effort',
      kind: 'enum',
      options: ['minimal', 'low', 'medium', 'high'],
      default: 'medium',
    });
  } else if (reasoning && fam === 'xai') {
    out.push({
      id: 'reasoningEffort',
      label: 'Reasoning effort',
      kind: 'enum',
      options: ['low', 'high'],
      default: 'low',
    });
  }

  // Anthropic extended-thinking budget (tokens). Opt-in: 0 / unset = disabled.
  if (fam === 'anthropic') {
    out.push({
      id: 'thinkingBudget',
      label: 'Thinking budget (tokens)',
      kind: 'number',
      min: 0,
      max: maxOutputCap(provider, model),
      default: 0,
    });
  }

  // max_output_tokens — universally applicable.
  out.push({
    id: 'maxOutputTokens',
    label: 'Max output tokens',
    kind: 'number',
    min: 1,
    max: maxOutputCap(provider, model),
  });

  return out;
}

/**
 * Drops any value whose id isn't a supported descriptor for this
 * `(provider, model)`. This is the capability gate used at save time and
 * defensively inside {@link serializeModelParams}, so a param the model
 * rejects (e.g. temperature on a reasoning model) never reaches the API.
 */
export function validateModelParams(
  provider: string,
  model: string,
  values: ModelParams,
  sdk?: SupportedSdk,
): ModelParams {
  const allowed = new Set<ParamId>(describeModelParams(provider, model, sdk).map((d) => d.id));
  const out: ModelParams = {};
  for (const [k, v] of Object.entries(values)) {
    if (allowed.has(k as ParamId)) out[k as ParamId] = v;
  }
  return out;
}

/**
 * Splits chosen values into the two AI-SDK destinations. Always validates
 * first, so callers can't smuggle a rejected param through. Returns plain
 * objects ready to merge into `generateText`'s top-level args (`params`) and
 * `providerOptions` respectively.
 */
export function serializeModelParams(
  provider: string,
  model: string,
  values: ModelParams | undefined,
  sdk?: SupportedSdk,
): { params: Record<string, unknown>; providerOptions: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  const providerOptions: Record<string, unknown> = {};
  if (!values) return { params, providerOptions };

  const safe = validateModelParams(provider, model, values, sdk);
  const fam = family(provider, sdk);

  if (typeof safe.temperature === 'number') params.temperature = safe.temperature;
  if (typeof safe.topP === 'number') params.topP = safe.topP;
  // AI SDK v4 names the top-level cap `maxTokens` (not `maxOutputTokens`); emit
  // the SDK key so it actually takes effect. The descriptor keeps the
  // provider-neutral `maxOutputTokens` id for the UI.
  if (typeof safe.maxOutputTokens === 'number') params.maxTokens = safe.maxOutputTokens;

  if (safe.reasoningEffort !== undefined && (fam === 'openai' || fam === 'xai')) {
    providerOptions[fam] = { reasoningEffort: safe.reasoningEffort };
  }

  if (fam === 'anthropic' && typeof safe.thinkingBudget === 'number' && safe.thinkingBudget > 0) {
    providerOptions.anthropic = {
      thinking: { type: 'enabled', budgetTokens: safe.thinkingBudget },
    };
  }

  return { params, providerOptions };
}
