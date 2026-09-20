import type { CoreMessage } from 'ai';

/**
 * The cache-token fields `@ai-sdk/anthropic` writes under its own namespace.
 *
 * Declared with REQUIRED fields because that is the contract the provider
 * actually honours — both keys are always present on a successful call, `null`
 * when there was no cache hit. {@link CacheMetadata} relaxes them for transport
 * only; see the note there for why it must.
 */
export interface AnthropicCacheTokens {
  /** Cache-write tokens, DISJOINT from `usage.promptTokens`. */
  cacheCreationInputTokens: number | null;
  /** Cache-read tokens, DISJOINT from `usage.promptTokens`. */
  cacheReadInputTokens: number | null;
}

/**
 * The cache-token field `@ai-sdk/openai-compatible` writes — the path taken by
 * `@ai-sdk/openai`, `@ai-sdk/xai` and every custom provider wrapping them.
 *
 * Written only when the response carried `prompt_tokens_details.cached_tokens`,
 * so the namespace can exist with this key absent; the key is required here
 * because when it IS written, this is its name.
 */
export interface OpenAICompatibleCacheTokens {
  /** Cache-read tokens, a SUBSET of `usage.promptTokens`. */
  cachedPromptTokens: number | null;
}

/**
 * Per-step provider metadata carrying prompt-cache token counts (#269), keyed by
 * the AI SDK's provider namespace — `anthropic`, `openai`, `xai`, or a custom
 * provider's own name, since each SDK writes under its own key.
 *
 * The two shapes above are NOT interchangeable — they disagree about whether
 * cached tokens are already counted in `usage.promptTokens`. Normalize with
 * `normalizeUsage` (`./token-stats.js`) rather than reading these directly.
 *
 * ## Why the fields are optional here, and why that is not fixable in the type
 *
 * The obvious hardening is to drop the `?` so a renamed field fails to compile,
 * the way the sibling `usage` parameter already does. **Measured, it does not
 * work**: the AI SDK types provider metadata as
 * `Record<string, Record<string, JSONValue>>` — it names none of these keys —
 * and TypeScript will not let a string index signature satisfy a required
 * property. Making them required takes the SDK's own `StepResult` out of
 * assignability, so `onStepFinish` stops type-checking against BOTH
 * `generateText` and `streamText` (`runner.ts`), plus the four direct
 * `normalizeUsage` call sites. The errors are false: the fields really are
 * there at runtime.
 *
 * So the type cannot be the guard here, and optional fields are worse than they
 * look — TypeScript does not even compare an index signature against an
 * OPTIONAL target property, so a hand-built payload of the wrong shape passes
 * silently. That is precisely why
 * `src/framework/hooks/__tests__/cache-metadata.contract.test.ts` exists, must
 * NOT `vi.mock('ai')`, and asserts the emitted KEY SET rather than only the
 * numbers: a renamed field has to fail by naming the new key, not by reporting
 * a zero. {@link ANTHROPIC_CACHE_KEYS} / {@link OPENAI_COMPATIBLE_CACHE_KEYS}
 * are what the test asserts against, so the reader and the assertion cannot
 * drift apart.
 */
export interface CacheMetadata {
  [namespace: string]:
    | (Partial<AnthropicCacheTokens> & Partial<OpenAICompatibleCacheTokens>)
    | undefined;
}

/** Every key {@link AnthropicCacheTokens} declares, for the contract test. */
export const ANTHROPIC_CACHE_KEYS = [
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
] as const satisfies readonly (keyof AnthropicCacheTokens)[];

/** Every key {@link OpenAICompatibleCacheTokens} declares, for the contract test. */
export const OPENAI_COMPATIBLE_CACHE_KEYS = [
  'cachedPromptTokens',
] as const satisfies readonly (keyof OpenAICompatibleCacheTokens)[];

// `satisfies` above catches a key in the array that the interface does not
// declare; these catch the other direction — a field added to the interface and
// left out of the array. Both halves are needed, and they live in PRODUCTION
// code rather than a test because `tsconfig.json` excludes test files from the
// program, so a `@ts-expect-error` in one is compiled by nothing (#509).
type _AnthropicKeysCovered =
  Exclude<keyof AnthropicCacheTokens, (typeof ANTHROPIC_CACHE_KEYS)[number]> extends never
    ? true
    : never;
type _OpenAIKeysCovered =
  Exclude<
    keyof OpenAICompatibleCacheTokens,
    (typeof OPENAI_COMPATIBLE_CACHE_KEYS)[number]
  > extends never
    ? true
    : never;
const _anthropicKeysCovered: _AnthropicKeysCovered = true;
const _openAIKeysCovered: _OpenAIKeysCovered = true;
void _anthropicKeysCovered;
void _openAIKeysCovered;

/**
 * Payload passed to `onStepFinish` by the AI SDK after each generation step.
 *
 * This is the structural subset our hooks use; the underlying AI-SDK type
 * carries additional fields we don't depend on.
 */
export interface StepFinishPayload {
  text: string;
  toolCalls: { toolName: string; toolCallId: string; args: unknown }[];
  toolResults: { toolName: string; toolCallId: string; result: unknown }[];
  usage?: { promptTokens: number; completionTokens: number };
  finishReason?: string;
  /**
   * Per-step provider metadata, keyed by the AI SDK's provider namespace.
   * Optional because hooks are also exercised with hand-built payloads in tests.
   * See {@link CacheMetadata} for the per-provider cache-token shapes.
   */
  providerMetadata?: CacheMetadata;
  /**
   * The AI SDK's `StepResult.response` — `messages` is a CUMULATIVE snapshot
   * of every response message generated so far in this call (verified for
   * both `generateText` and `streamText` in ai@4.1). Optional because hooks
   * are also exercised with hand-built payloads in tests.
   */
  response?: { messages?: CoreMessage[] };
}

/**
 * Composable observer hook for a {@link runAgent} run. Each hook may inspect a
 * completed step and trigger side effects (printing, token tracking, log
 * accumulation). Hooks are invoked in declaration order; an error from one
 * hook propagates and aborts later hooks for that step.
 *
 * Hooks are deliberately observe-only — they cannot rewrite tool calls or
 * abort the run. Behavior-replacing slots like `experimental_repairToolCall`
 * and `experimental_prepareStep` are top-level `AgentSpec` fields, since the
 * AI SDK only accepts one value for each.
 */
export interface AgentHook {
  onStepFinish?(step: StepFinishPayload): void | Promise<void>;
}
