import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';
import type { SupportedSdk } from './types.js';
import type { BernardConfig } from '../config.js';
import { getProviderApiKey } from '../config.js';
import { stallGuardedFetch } from './stall-guard.js';

export { getModelProfile } from './profiles.js';
export type { ModelProfile } from './profiles.js';
export type { SupportedSdk } from './types.js';

/**
 * Time-to-first-byte guard applied to every LLM completion (#302).
 *
 * Built once and shared by every client — safe because the wrapper resolves
 * both its budget and the underlying `fetch` per request, so nothing is frozen
 * at module load and the memoized custom-factory cache key stays valid.
 */
const guardedFetch = stallGuardedFetch();

// Built-in clients are constructed HERE rather than using each SDK's exported
// default instance, because only the factory form accepts a `fetch`. Key
// resolution is unchanged: `createX()` reads the same env var the default
// instance does.
//
// `compatibility: 'strict'` is not incidental — it is what `@ai-sdk/openai`'s
// own default `openai` export passes, and dropping it would silently change
// request shaping. Anthropic and xAI construct their defaults with no options.
const anthropic = createAnthropic({ fetch: guardedFetch });
const openai = createOpenAI({ compatibility: 'strict', fetch: guardedFetch });
const xai = createXai({ fetch: guardedFetch });

/** Custom-provider params for `getModel()` — set when the active provider is user-defined. */
export interface CustomProviderInvocation {
  /** Which installed AI-SDK to wrap. */
  sdk: SupportedSdk;
  /** Endpoint base URL, e.g. `http://localhost:11434/v1`. */
  baseURL: string;
  /** API key (some local servers accept any non-empty token). */
  apiKey: string;
}

// Memoize SDK factories so repeated `getModel` calls for the same custom
// provider don't reconstruct the factory on every agent turn / sub-agent
// dispatch. Built-in providers already use module-level singletons.
type CustomFactory = ReturnType<typeof createOpenAI | typeof createAnthropic | typeof createXai>;
const customFactoryCache = new Map<string, CustomFactory>();

function getCustomFactory(custom: CustomProviderInvocation): CustomFactory {
  const cacheKey = `${custom.sdk}|${custom.baseURL}|${custom.apiKey}`;
  const cached = customFactoryCache.get(cacheKey);
  if (cached) return cached;
  // Custom providers get the same guard — a self-hosted endpoint is at least
  // as likely to stall as a vendor one.
  const opts = { baseURL: custom.baseURL, apiKey: custom.apiKey, fetch: guardedFetch };
  const factory =
    custom.sdk === 'openai'
      ? createOpenAI(opts)
      : custom.sdk === 'anthropic'
        ? createAnthropic(opts)
        : createXai(opts);
  customFactoryCache.set(cacheKey, factory);
  return factory;
}

/**
 * Return an AI SDK `LanguageModel` instance for the given provider and model name.
 *
 * For built-in providers (`anthropic`, `openai`, `xai`) the module-level singletons
 * are used, which read API keys from environment variables. For custom providers
 * the matching `createXxx({ baseURL, apiKey })` factory is invoked instead (cached
 * by `(sdk, baseURL, apiKey)` so repeated calls are cheap).
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
    const factory = getCustomFactory(custom);
    if (custom.sdk === 'openai')
      return (factory as ReturnType<typeof createOpenAI>).responses(model);
    return (factory as ReturnType<typeof createAnthropic> | ReturnType<typeof createXai>)(model);
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
  // Built-in providers map 1:1 to SDK names; route through the factory path
  // when the user has supplied a session-scoped base-URL override so the
  // request actually hits the new endpoint instead of the vendor default.
  if (config.providerBaseUrl && isBuiltinSdk(provider)) {
    const apiKey = getProviderApiKey(config, provider) ?? '';
    return getModel(provider, model, {
      sdk: provider,
      baseURL: config.providerBaseUrl,
      apiKey,
    });
  }
  return getModel(provider, model);
}

function isBuiltinSdk(provider: string): provider is SupportedSdk {
  return provider === 'anthropic' || provider === 'openai' || provider === 'xai';
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
