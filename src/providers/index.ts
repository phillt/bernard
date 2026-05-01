import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { xai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';

export { getModelProfile } from './profiles.js';
export type { ModelProfile } from './profiles.js';

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
      return openai.responses(model);
    case 'xai':
      return xai(model);
    default:
      throw new Error(`Unknown provider: ${provider}. Supported: anthropic, openai, xai`);
  }
}

/**
 * Per-call provider options forwarded to `generateText`. We disable OpenAI's
 * strict-schemas mode because MCP tools commonly emit JSON Schema features
 * (`oneOf` partial-constraint branches, untyped `items: {}`, etc.) that strict
 * mode rejects at preflight, killing the user's turn. Tool calls become
 * advisory rather than enforced — minor reliability cost, large UX win.
 */
export function getProviderOptions(
  provider: string,
): { openai: { strictSchemas: false } } | undefined {
  if (provider === 'openai') return { openai: { strictSchemas: false } };
  return undefined;
}
