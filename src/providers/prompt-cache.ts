import type { BernardConfig } from '../config.js';
import type { CoreMessage } from 'ai';

/**
 * Anthropic prompt caching (#269).
 *
 * Provider prompt caching discounts repeated *input* tokens: when a request's
 * leading token prefix is byte-identical to a recent one, Anthropic serves it
 * from its KV cache at ~10% of the input price. The prefix is everything in
 * document order up to (and including) a `cache_control` breakpoint, in the
 * order tools → system → messages.
 *
 * We place at most two breakpoints:
 *   1. The **system** block — caches the system prompt *and* the tool
 *      definitions that precede it (the largest, most stable chunk). Note the
 *      AI SDK can only cache the system when it is sent as a `{role:'system'}`
 *      message with `providerOptions` — a plain `system:` string is never
 *      cached — so we convert it here.
 *   2. The **last stable history message** before the volatile per-turn
 *      `<system_provided_context>` block — caches the conversation so far,
 *      incrementally, as it grows.
 *
 * Markers are scoped to the built-in `anthropic` provider. Custom/local
 * providers (which may not implement the API and aren't billed per token) and
 * non-Anthropic providers ignore them, so we simply don't emit them there.
 */

const EPHEMERAL = { type: 'ephemeral' as const };
const CACHE_PROVIDER_OPTIONS = { anthropic: { cacheControl: EPHEMERAL } } as const;

/**
 * True when Anthropic prompt-cache markers should be emitted: the flag is on and
 * the active provider is the built-in `anthropic`. Custom providers can never be
 * named `anthropic` (it's a reserved name), so the name check is sufficient to
 * exclude local/proxy endpoints.
 */
export function isAnthropicPromptCacheActive(config: BernardConfig, provider: string): boolean {
  return config.promptCache && provider === 'anthropic';
}

/** Identify the volatile per-turn context block so we cache the prefix before it. */
function isContextMessage(m: CoreMessage): boolean {
  return (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.startsWith('<system_provided_context>')
  );
}

/** Return a copy of `msg` with an Anthropic ephemeral cache breakpoint attached. */
function withCacheControl(msg: CoreMessage): CoreMessage {
  const existing = (msg as { providerOptions?: Record<string, unknown> }).providerOptions ?? {};
  return {
    ...msg,
    providerOptions: { ...existing, ...CACHE_PROVIDER_OPTIONS },
  } as CoreMessage;
}

/**
 * Mark cache breakpoints on a finalized (system, messages) pair. Returns a new
 * pair: the system string is moved into a leading cached system message (so the
 * caller must pass the returned `system` — now `undefined` — and `messages`
 * verbatim to the AI SDK; passing both a `system` string and a system message
 * throws). Idempotent-safe to call once per dispatch.
 *
 * Only call when {@link isAnthropicPromptCacheActive} is true.
 */
export function applyAnthropicPromptCache(input: {
  system?: string;
  messages: CoreMessage[];
}): { system?: string; messages: CoreMessage[] } {
  const messages = [...input.messages];

  // (2) Rolling breakpoint: the last stable message before the volatile context
  // block. Everything before the context message is identical turn-to-turn.
  const contextIdx = messages.findIndex(isContextMessage);
  const stableIdx = contextIdx > 0 ? contextIdx - 1 : -1;
  if (stableIdx >= 0) {
    messages[stableIdx] = withCacheControl(messages[stableIdx]);
  }

  // (1) System breakpoint: convert the string system into a cached system
  // message (caches tools + system together). A plain `system:` string can't
  // carry a cache marker, so this conversion is required.
  if (input.system && input.system.length > 0) {
    const systemMessage = withCacheControl({ role: 'system', content: input.system });
    return { system: undefined, messages: [systemMessage, ...messages] };
  }

  return { system: input.system, messages };
}
