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

const XAI_REASONING_SUFFIX = `## Model Notes
This model reasons internally. Do not narrate chain-of-thought ("think step by step", "explain your reasoning before acting") — state conclusions and take actions directly. Keep instructions terse.`;

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
  systemSuffix: '',
  rewriterHint: XAI_STANDARD_REWRITER_HINT,
};

/**
 * Resolves the {@link ModelProfile} for a provider + model pair.
 *
 * Matching is first-match-wins and pattern-based so new models in an existing
 * family pick up the right profile automatically. Unknown combinations fall
 * back to a conservative passthrough profile.
 */
export function getModelProfile(provider: string, model: string): ModelProfile {
  const m = model.toLowerCase();

  if (provider === 'anthropic') {
    return ANTHROPIC_PROFILE;
  }

  if (provider === 'openai') {
    // o-series reasoning models: o1, o3, o3-mini, o4-mini, …
    if (/^o\d/.test(m)) return OPENAI_REASONING_PROFILE;
    return OPENAI_STANDARD_PROFILE;
  }

  if (provider === 'xai') {
    // Explicit non-reasoning variants take precedence over the generic grok-4 rule.
    if (m.includes('non-reasoning')) return XAI_STANDARD_PROFILE;
    if (m.includes('reasoning')) return XAI_REASONING_PROFILE;
    // Grok 4.x is a reasoning family by default unless tagged otherwise.
    if (/^grok-4(\b|[-.])/.test(m)) return XAI_REASONING_PROFILE;
    return XAI_STANDARD_PROFILE;
  }

  return DEFAULT_PROFILE;
}

// References for maintainers updating the suffix constants:
//   https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
//   https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide
//   https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide
//   https://developers.openai.com/api/docs/guides/reasoning-best-practices
//   https://docs.x.ai/docs/guides/chat
