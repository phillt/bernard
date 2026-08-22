/** The three AI-SDK packages we ship; custom providers must wrap one of these. */
export type SupportedSdk = 'anthropic' | 'openai' | 'xai';

/** Built-in provider identifiers — fall back to the official endpoints. */
export const BUILTIN_PROVIDERS = ['anthropic', 'openai', 'xai'] as const;
export type BuiltinProvider = (typeof BUILTIN_PROVIDERS)[number];

/**
 * Model-catalog `owned_by` prefixes that name a built-in provider under a
 * different label. Private on purpose: {@link resolveGatewayOwner} is the only
 * supported way to resolve an owner, and a second exported entry point is
 * exactly the bypass this table exists to close.
 */
const GATEWAY_OWNER_ALIASES: Record<string, BuiltinProvider> = {
  // The Vercel AI Gateway renamed xAI's owner prefix from `xai` to `spacexai`.
  spacexai: 'xai',
};

/**
 * Resolves a catalog owner prefix to a built-in provider id, or `null` when the
 * owner is not one of ours. Accepts both the canonical name and any alias, so an
 * older vendored snapshot (which still uses `xai/`) keeps parsing.
 *
 * Without the alias hop an upstream rename drops every model of that provider at
 * parse time, which silently costs us both context windows and pricing — the
 * model falls back to `DEFAULT_CONTEXT_WINDOW` and prices as `null`. Mapping
 * back to our own id keeps config, lineups, keys, and SDK wiring on `xai`.
 */
export function resolveGatewayOwner(owner: string): BuiltinProvider | null {
  if (BUILTIN_PROVIDERS.includes(owner as BuiltinProvider)) return owner as BuiltinProvider;
  return GATEWAY_OWNER_ALIASES[owner] ?? null;
}

/**
 * Provider identifier — `'anthropic' | 'openai' | 'xai'` for built-ins, or any
 * user-chosen name registered as a custom provider. The literal union documents
 * intent; runtime values are plain strings.
 */
export type ProviderName = BuiltinProvider | (string & {});

/** Provider and model pair used to instantiate an AI SDK `LanguageModel`. */
export interface ProviderConfig {
  /** Which LLM provider to use. */
  provider: ProviderName;
  /** Model identifier passed to the provider SDK (e.g. "claude-sonnet-4-5-20250929"). */
  model: string;
}
