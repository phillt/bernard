import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { xai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';

/**
 * Return an AI SDK `LanguageModel` instance for the given provider and model name.
 * @param provider - One of `"anthropic"`, `"openai"`, or `"xai"`.
 * @param model - Provider-specific model identifier (e.g. `"claude-sonnet-4-20250514"`).
 * @returns A ready-to-use `LanguageModel` backed by the requested provider.
 * @throws {Error} If the provider string is not recognized.
 */
export function getModel(provider: string, model: string): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return anthropic(model);
    case 'openai':
      return openai(model);
    case 'xai':
      return xai(model);
    default:
      throw new Error(`Unknown provider: ${provider}. Supported: anthropic, openai, xai`);
  }
}
