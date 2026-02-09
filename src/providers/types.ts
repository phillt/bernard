export type ProviderName = 'anthropic' | 'openai' | 'xai';

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
}
