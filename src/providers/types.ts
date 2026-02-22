/** Supported LLM provider identifiers. */
export type ProviderName = 'anthropic' | 'openai' | 'xai';

/** Provider and model pair used to instantiate an AI SDK `LanguageModel`. */
export interface ProviderConfig {
  /** Which LLM provider to use. */
  provider: ProviderName;
  /** Model identifier passed to the provider SDK (e.g. "claude-sonnet-4-5-20250929"). */
  model: string;
}
