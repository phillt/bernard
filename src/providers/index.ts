import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { openai, createOpenAI } from '@ai-sdk/openai';
import { xai, createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';
import type { SupportedSdk } from './types.js';
import type { BernardConfig } from '../config.js';
import { getProviderApiKey } from '../config.js';

export { getModelProfile } from './profiles.js';
export type { ModelProfile } from './profiles.js';
export type { SupportedSdk } from './types.js';

/** Custom-provider params for `getModel()` — set when the active provider is user-defined. */
export interface CustomProviderInvocation {
  /** Which installed AI-SDK to wrap. */
  sdk: SupportedSdk;
  /** Endpoint base URL, e.g. `http://localhost:11434/v1`. */
  baseURL: string;
  /** API key (some local servers accept any non-empty token). */
  apiKey: string;
}

/**
 * Return an AI SDK `LanguageModel` instance for the given provider and model name.
 *
 * For built-in providers (`anthropic`, `openai`, `xai`) the module-level singletons
 * are used, which read API keys from environment variables. For custom providers
 * the matching `createXxx({ baseURL, apiKey })` factory is invoked instead.
 *
 * @param provider - Provider identifier (built-in or custom registry name).
 * @param model - Provider-specific model identifier.
 * @param custom - When set, build the model via the SDK factory with these options.
 * @returns A ready-to-use `LanguageModel` backed by the requested provider.
 * @throws {Error} If the provider string is not recognized and no `custom` info is supplied.
 */
export function getModel(
  provider: string,
  model: string,
  custom?: CustomProviderInvocation,
): LanguageModel {
  if (custom) {
    switch (custom.sdk) {
      case 'openai': {
        const factory = createOpenAI({ baseURL: custom.baseURL, apiKey: custom.apiKey });
        return factory.responses(model);
      }
      case 'anthropic':
        return createAnthropic({ baseURL: custom.baseURL, apiKey: custom.apiKey })(model);
      case 'xai':
        return createXai({ baseURL: custom.baseURL, apiKey: custom.apiKey })(model);
    }
  }
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
 * Resolves a `LanguageModel` for the given `provider`/`model`, automatically
 * routing through the custom-provider registry when `provider` is user-defined.
 *
 * This is the call-site helper — every place in the codebase that used to call
 * `getModel(provider, model)` should now call `getModelForConfig(config, provider, model)`
 * so custom providers transparently take effect.
 */
export function getModelForConfig(
  config: BernardConfig,
  provider: string,
  model: string,
): LanguageModel {
  const custom = config.customProviders?.[provider];
  if (custom) {
    const apiKey = getProviderApiKey(config, provider) ?? '';
    return getModel(provider, model, {
      sdk: custom.sdk,
      baseURL: custom.baseURL,
      apiKey,
    });
  }
  return getModel(provider, model);
}

// Disable OpenAI strict-schemas: MCP tools commonly emit JSON Schema features
// (`oneOf` partial-constraint branches, untyped `items: {}`, etc.) that strict
// mode rejects at preflight, killing the user's turn.
const OPENAI_PROVIDER_OPTIONS = Object.freeze({
  openai: Object.freeze({ strictSchemas: false as const }),
});

/**
 * Returns provider-specific generation options for the AI SDK.
 *
 * The optional `sdk` argument lets callers pass the underlying SDK family
 * of a custom provider (its factory is OpenAI-shaped even if the name is e.g.
 * "ollama") so the OpenAI strictSchemas escape hatch is also applied there.
 */
export function getProviderOptions(
  provider: string,
  sdk?: SupportedSdk,
): { openai: { strictSchemas: false } } | undefined {
  const effective = sdk ?? provider;
  return effective === 'openai' ? OPENAI_PROVIDER_OPTIONS : undefined;
}

/**
 * Helper for the common case of resolving provider options from a `BernardConfig`
 * by `provider` name — consults the custom-provider registry to pick the right
 * SDK family.
 */
export function getProviderOptionsForConfig(
  config: BernardConfig,
  provider: string,
): { openai: { strictSchemas: false } } | undefined {
  const custom = config.customProviders?.[provider];
  return getProviderOptions(provider, custom?.sdk);
}
