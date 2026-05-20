/** The three AI-SDK packages we ship; custom providers must wrap one of these. */
export type SupportedSdk = 'anthropic' | 'openai' | 'xai';

/** Built-in provider identifiers — fall back to the official endpoints. */
export const BUILTIN_PROVIDERS = ['anthropic', 'openai', 'xai'] as const;
export type BuiltinProvider = (typeof BUILTIN_PROVIDERS)[number];

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
