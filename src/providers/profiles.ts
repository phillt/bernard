/**
 * Model-specific prompt optimization profiles.
 *
 * Each provider + model family has a {@link ModelProfile} that adjusts how a user
 * message is wrapped and what short advisory block is appended to the system
 * prompt. Profiles are resolved once per turn and applied deterministically —
 * no extra LLM call. Cache-safe: the system-prompt suffix depends only on the
 * selected model, not on the user's input, so the KV-cache prefix stays stable
 * across a session with a fixed model.
 */

import { findModelMetaByName } from './catalog.js';

/** Static per-model settings applied at the agent-loop boundary. */
export interface ModelProfile {
  /** Stable identifier — useful in logs and tests. */
  readonly family: string;
  /** Wraps the raw user input. Applied before the timestamp prefix is added. */
  wrapUserMessage(message: string): string;
  /** Short advisory block appended to the system prompt. Empty string = no-op. */
  readonly systemSuffix: string;
  /**
   * Short per-family style hint injected into the prompt-rewriter's system
   * prompt (see src/prompt-rewriter.ts). Tells the rewriter what structural
   * formatting this downstream model responds best to.
   */
  readonly rewriterHint: string;
}

const ANTHROPIC_SUFFIX = `## Model Notes
This model responds best to XML-structured input. User-authored text is wrapped in a \`<user_request>\` tag to make the primary instruction explicit. Treat the tag contents as the authoritative request; also attend to other content supplied with the same user turn (attached images, system-inserted context notices) as relevant context. Text outside the tag is not a new standalone instruction from the user.`;

const OPENAI_REASONING_SUFFIX = `Formatting re-enabled

## Model Notes
This model reasons internally. Do not narrate chain-of-thought ("think step by step", "explain your reasoning before acting") — state conclusions and take actions directly. Prefer zero-shot; keep instructions terse.`;

const OPENAI_STANDARD_SUFFIX = `## Model Notes
- Persistence: keep working until the user's request is fully resolved before yielding.
- Tool-calling: if you are unsure about file content or codebase structure, call a tool to read it — do not guess.
- Planning: plan before each function call and reflect on the outcome of the previous call before the next.`;

// Shared agentic-behavior guidance for xAI Grok models. Unlike OpenAI (which
// ships an explicit persistence doctrine) xAI publishes none, and Grok defaults
// to terse output that stops early — pausing to ask the user for data it could
// fetch itself, and giving up on the first tool failure. These clauses (adapted
// from OpenAI's GPT-5 persistence guidance and xAI community write-ups) are
// injected for BOTH Grok families so the behavior does not depend on whether a
// given model resolves as reasoning vs. standard. Kept terse — Grok follows
// terse, imperative instructions best.
const XAI_AGENTIC_NOTES = `- Autonomy: keep working until the request is fully resolved before yielding the turn. When something is ambiguous, choose the most reasonable assumption, act on it, and note the assumption afterward rather than pausing to ask.
- Act, don't announce: if you say you will use a tool or specialist, call it in the same turn. Never end a turn having only described an intended action ("checking X first", "routing this through Y") — perform the action instead of narrating it, then report the result.
- Gather before asking: obtain information yourself before asking the user for it — read it with a tool, search memory, or use context already provided. Only ask the user when no available tool can supply it and the task genuinely cannot proceed.
- Recover from failures: if a tool fails, try an alternative tool or approach before giving up. Do not surface a raw tool error as a reason to stop or to hand the work back to the user.
- Always deliver: never end a turn with only internal reasoning. When the work is complete, write the final answer to the user as plain text. When you need input from the user, request it with the \`ask_user\` tool — not as a plain-text question.`;

const XAI_REASONING_SUFFIX = `## Model Notes
This model reasons internally. Do not narrate chain-of-thought ("think step by step", "explain your reasoning before acting") — state conclusions and take actions directly. Keep instructions terse.
${XAI_AGENTIC_NOTES}`;

const XAI_STANDARD_SUFFIX = `## Model Notes
${XAI_AGENTIC_NOTES}`;

const ANTHROPIC_REWRITER_HINT =
  'Use natural prose framed with XML-style tags (<task>, <context>, <constraints>) when the request has distinct parts. Keep the original voice; do not over-structure short conversational requests.';

const OPENAI_REASONING_REWRITER_HINT =
  'Keep the rewrite terse. Drop filler ("please", "could you"). One or two short paragraphs or a tight bullet list is ideal. No chain-of-thought prompts.';

const OPENAI_STANDARD_REWRITER_HINT =
  'Prefer explicit "Task:", "Constraints:", and "Output:" sections when the request has multiple parts. Keep very short requests in natural prose.';

const XAI_REASONING_REWRITER_HINT =
  'Terse and direct. Strip conversational padding. State the goal in one or two sentences; add a short numbered list only when multiple distinct steps are implied.';

const XAI_STANDARD_REWRITER_HINT =
  'Direct, explicit, minimal verbosity. A short "Task: … / Requirements: …" shape works well for compound requests.';

const DEFAULT_REWRITER_HINT =
  'Keep the rewrite close to the original phrasing. Only add structure when the original has multiple distinct parts.';

const DEFAULT_PROFILE: ModelProfile = {
  family: 'default',
  wrapUserMessage: (msg) => msg,
  systemSuffix: '',
  rewriterHint: DEFAULT_REWRITER_HINT,
};

const ANTHROPIC_PROFILE: ModelProfile = {
  family: 'anthropic-claude',
  wrapUserMessage: (msg) => `<user_request>\n${msg}\n</user_request>`,
  systemSuffix: ANTHROPIC_SUFFIX,
  rewriterHint: ANTHROPIC_REWRITER_HINT,
};

const OPENAI_REASONING_PROFILE: ModelProfile = {
  family: 'openai-reasoning',
  wrapUserMessage: (msg) => msg,
  systemSuffix: OPENAI_REASONING_SUFFIX,
  rewriterHint: OPENAI_REASONING_REWRITER_HINT,
};

const OPENAI_STANDARD_PROFILE: ModelProfile = {
  family: 'openai-standard',
  wrapUserMessage: (msg) => `# Request\n${msg}`,
  systemSuffix: OPENAI_STANDARD_SUFFIX,
  rewriterHint: OPENAI_STANDARD_REWRITER_HINT,
};

const XAI_REASONING_PROFILE: ModelProfile = {
  family: 'xai-grok-reasoning',
  wrapUserMessage: (msg) => msg,
  systemSuffix: XAI_REASONING_SUFFIX,
  rewriterHint: XAI_REASONING_REWRITER_HINT,
};

const XAI_STANDARD_PROFILE: ModelProfile = {
  family: 'xai-grok-standard',
  wrapUserMessage: (msg) => `# Request\n${msg}`,
  systemSuffix: XAI_STANDARD_SUFFIX,
  rewriterHint: XAI_STANDARD_REWRITER_HINT,
};

/**
 * Resolves the {@link ModelProfile} for a provider + model pair.
 *
 * Matching is first-match-wins and pattern-based so new models in an existing
 * family pick up the right profile automatically. Unknown combinations fall
 * back to a conservative passthrough profile.
 *
 * For custom providers (user-defined endpoints that wrap an installed AI-SDK)
 * pass the wrapped SDK family via `sdk` so the model picks up family-specific
 * prompt tuning regardless of the registered provider name.
 */
export function getModelProfile(
  provider: string,
  model: string,
  sdk?: 'anthropic' | 'openai' | 'xai',
): ModelProfile {
  const m = model.toLowerCase();
  const family = sdk ?? provider;

  // Catalog-first reasoning detection: when the gateway tags a model as
  // `reasoning` it overrides the family heuristics below. The catalog lookup
  // is name-only (no provider) because custom providers may have a name
  // mismatch but still wrap an SDK whose underlying model id is in the
  // catalog (e.g. an OpenRouter proxy of `gpt-5.2`).
  const meta = findModelMetaByName(model);
  const catalogReasoning = meta?.tags.includes('reasoning') ?? null;

  if (family === 'anthropic') {
    return ANTHROPIC_PROFILE;
  }

  if (family === 'openai') {
    if (catalogReasoning === true) return OPENAI_REASONING_PROFILE;
    if (catalogReasoning === false) return OPENAI_STANDARD_PROFILE;
    // o-series reasoning models: o1, o3, o3-mini, o4-mini, …
    if (/^o\d/.test(m)) return OPENAI_REASONING_PROFILE;
    return OPENAI_STANDARD_PROFILE;
  }

  if (family === 'xai') {
    if (catalogReasoning === true) return XAI_REASONING_PROFILE;
    if (catalogReasoning === false) return XAI_STANDARD_PROFILE;
    // Explicit non-reasoning variants take precedence over the generic grok-4 rule.
    if (m.includes('non-reasoning')) return XAI_STANDARD_PROFILE;
    if (m.includes('reasoning')) return XAI_REASONING_PROFILE;
    // Grok 4.x is a reasoning family by default unless tagged otherwise.
    if (/^grok-4(\b|[-.])/.test(m)) return XAI_REASONING_PROFILE;
    return XAI_STANDARD_PROFILE;
  }

  return DEFAULT_PROFILE;
}

/**
 * Returns `true` when the model accepts a `temperature` parameter, `false`
 * when it is a reasoning model that rejects temperature (e.g. claude-opus-4-8,
 * OpenAI o-series, xAI grok-4 reasoning variants).
 *
 * Detection is catalog-first: models tagged `reasoning` in the vendored or
 * disk-cached catalog return `false`. For catalog misses, provider-specific
 * pattern matching fires **only when `provider` is explicit** — this prevents
 * false-positives for custom-provider models whose names match (e.g. a local
 * model called `o1-uncensored` on a custom Ollama endpoint).
 *
 * **Fail-open**: unknown / custom-provider models return `true` so callers
 * still send temperature for models we don't recognise (safe default for
 * non-reasoning models that require it).
 *
 * Callers should spread the result rather than passing `undefined`:
 *   `...(modelSupportsTemperature(model, provider) ? { temperature: 0 } : {})`
 *
 * @param model    The model id as passed to the AI SDK.
 * @param provider Provider name (e.g. `'anthropic'`, `'openai'`, `'xai'`).
 *                 Required for accurate catalog-miss fallback matching.
 */
export function modelSupportsTemperature(model: string, provider?: string): boolean {
  // Catalog-first: if the model is in the catalog and tagged reasoning, it
  // does not support temperature. The catalog converts dots to dashes for
  // anthropic (claude-opus-4.8 → claude-opus-4-8) before indexing.
  const meta = findModelMetaByName(model);
  if (meta !== null) {
    return !meta.tags.includes('reasoning');
  }

  // Catalog miss — fall back to cheap pattern matching for well-known families.
  // Only apply provider-specific patterns when the provider is explicit, so we
  // never false-flag a custom-provider model whose name happens to match.
  const m = model.toLowerCase();
  const family = provider?.toLowerCase();

  // OpenAI o-series reasoning models: o1, o3, o3-mini, o4-mini, …
  if (family === 'openai') {
    if (/^o\d/.test(m)) return false;
  }

  // xAI grok-4 models with explicit reasoning suffix.
  if (family === 'xai') {
    if (m.includes('non-reasoning')) return true; // explicit override
    if (m.includes('reasoning')) return false;
    // Grok 4.x is a reasoning family by default.
    if (/^grok-4(\b|[-.])/.test(m)) return false;
  }

  // Unknown / custom provider — fail open (assume temperature is supported).
  return true;
}

/**
 * Returns `{ temperature: 0 }` when the model accepts the parameter, or `{}`
 * when it is a reasoning model that rejects it.
 *
 * Convenience wrapper around {@link modelSupportsTemperature} — eliminates the
 * ternary spread that every call site would otherwise repeat:
 *
 *   ```ts
 *   // before
 *   ...(modelSupportsTemperature(site.model.modelId, site.provider) ? { temperature: 0 } : {})
 *   // after
 *   ...temperatureParam(site.model.modelId, site.provider)
 *   ```
 */
export function temperatureParam(
  model: string,
  provider?: string,
): { temperature: number } | Record<string, never> {
  return modelSupportsTemperature(model, provider) ? { temperature: 0 } : {};
}

// References for maintainers updating the suffix constants:
//   https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
//   https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide
//   https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide
//   https://developers.openai.com/api/docs/guides/reasoning-best-practices
//   https://docs.x.ai/docs/guides/chat
