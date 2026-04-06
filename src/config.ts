import * as dotenv from 'dotenv';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { PREFS_PATH, KEYS_PATH, ENV_PATH, LEGACY_DIR } from './paths.js';

/** Resolved runtime configuration for a Bernard session. */
export interface BernardConfig {
  /** Active LLM provider identifier (e.g. "anthropic", "openai", "xai"). */
  provider: string;
  /** Model name passed to the provider SDK. */
  model: string;
  /** Maximum tokens the model may generate per response. */
  maxTokens: number;
  /** Timeout in milliseconds for shell tool commands. */
  shellTimeout: number;
  /** Context window size override for compression (0 = auto-detect from model). */
  tokenWindow: number;
  /** Whether RAG memory retrieval is active. */
  ragEnabled: boolean;
  /** Color theme name for terminal output. */
  theme: string;
  /** Maximum number of sequential LLM calls (steps) per agent loop. */
  maxSteps: number;
  /** Whether critic mode (planning + verification) is active. */
  criticMode: boolean;
  /** Whether to auto-create specialists above the confidence threshold. */
  autoCreateSpecialists: boolean;
  /** Confidence threshold for auto-creating specialists (0-1). */
  autoCreateThreshold: number;
  /** Anthropic API key, if available. */
  anthropicApiKey?: string;
  /** OpenAI API key, if available. */
  openaiApiKey?: string;
  /** xAI API key, if available. */
  xaiApiKey?: string;
}

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_SHELL_TIMEOUT = 30000;
const DEFAULT_TOKEN_WINDOW = 0;
const DEFAULT_MAX_STEPS = 25;
const DEFAULT_AUTO_CREATE_SPECIALISTS = false;
const DEFAULT_AUTO_CREATE_THRESHOLD = 0.8;

/**
 * Normalizes a threshold value to the 0-1 range.
 * Accepts both 0-1 (fractional) and >1-100 (percentage) inputs.
 * Values >1 are divided by 100. Result is clamped to [0, 1].
 */
export function normalizeThreshold(value: number): number {
  const normalized = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, normalized));
}

/** Maps each provider name to the environment variable that holds its API key. */
export const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
};

/**
 * Registry of user-configurable numeric options.
 *
 * Each entry maps a CLI option name (e.g. "max-tokens") to its config key,
 * default value, human-readable description, and corresponding env var.
 */
export const OPTIONS_REGISTRY: Record<
  string,
  {
    configKey: 'maxTokens' | 'shellTimeout' | 'tokenWindow' | 'maxSteps';
    default: number;
    description: string;
    envVar: string;
  }
> = {
  'max-tokens': {
    configKey: 'maxTokens',
    default: DEFAULT_MAX_TOKENS,
    description: 'Maximum tokens per AI response (controls response length)',
    envVar: 'BERNARD_MAX_TOKENS',
  },
  'shell-timeout': {
    configKey: 'shellTimeout',
    default: DEFAULT_SHELL_TIMEOUT,
    description: 'Shell command timeout in milliseconds (how long commands can run)',
    envVar: 'BERNARD_SHELL_TIMEOUT',
  },
  'token-window': {
    configKey: 'tokenWindow',
    default: DEFAULT_TOKEN_WINDOW,
    description: 'Context window size for compression (0 = auto-detect from model)',
    envVar: 'BERNARD_TOKEN_WINDOW',
  },
  'max-steps': {
    configKey: 'maxSteps',
    default: DEFAULT_MAX_STEPS,
    description: 'Maximum agent loop iterations per request (controls tool call chain length)',
    envVar: 'BERNARD_MAX_STEPS',
  },
};

/**
 * Persists user preferences to the config directory.
 *
 * Preserves the existing `autoUpdate` and `criticMode` flags when the caller omits them.
 */
export function savePreferences(prefs: {
  provider: string;
  model: string;
  maxTokens?: number;
  shellTimeout?: number;
  tokenWindow?: number;
  maxSteps?: number;
  theme?: string;
  autoUpdate?: boolean;
  criticMode?: boolean;
  autoCreateSpecialists?: boolean;
  autoCreateThreshold?: number;
}): void {
  const dir = path.dirname(PREFS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data: Record<string, unknown> = { provider: prefs.provider, model: prefs.model };
  if (prefs.maxTokens !== undefined) data.maxTokens = prefs.maxTokens;
  if (prefs.shellTimeout !== undefined) data.shellTimeout = prefs.shellTimeout;
  if (prefs.tokenWindow !== undefined) data.tokenWindow = prefs.tokenWindow;
  if (prefs.maxSteps !== undefined) data.maxSteps = prefs.maxSteps;
  if (prefs.theme !== undefined) data.theme = prefs.theme;
  if (prefs.criticMode !== undefined) data.criticMode = prefs.criticMode;
  if (prefs.autoCreateSpecialists !== undefined)
    data.autoCreateSpecialists = prefs.autoCreateSpecialists;
  if (prefs.autoCreateThreshold !== undefined) data.autoCreateThreshold = prefs.autoCreateThreshold;

  // Preserve autoUpdate, criticMode, and auto-create settings from existing prefs when callers don't pass them
  let existing: Record<string, unknown> | undefined;
  try {
    existing = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf-8'));
  } catch {
    /* ignore */
  }

  if (prefs.autoUpdate !== undefined) {
    data.autoUpdate = prefs.autoUpdate;
  } else if (existing && typeof existing.autoUpdate === 'boolean') {
    data.autoUpdate = existing.autoUpdate;
  }
  if (prefs.criticMode === undefined && existing && typeof existing.criticMode === 'boolean') {
    data.criticMode = existing.criticMode;
  }

  // Preserve numeric options from existing prefs when callers don't pass them.
  // Use 'in' to distinguish "key absent" (preserve) from "key explicitly set to undefined" (reset).
  if (!('maxSteps' in prefs) && existing && typeof existing.maxSteps === 'number') {
    data.maxSteps = existing.maxSteps;
  }
  if (!('maxTokens' in prefs) && existing && typeof existing.maxTokens === 'number') {
    data.maxTokens = existing.maxTokens;
  }
  if (!('shellTimeout' in prefs) && existing && typeof existing.shellTimeout === 'number') {
    data.shellTimeout = existing.shellTimeout;
  }
  if (!('tokenWindow' in prefs) && existing && typeof existing.tokenWindow === 'number') {
    data.tokenWindow = existing.tokenWindow;
  }
  if (
    prefs.autoCreateSpecialists === undefined &&
    existing &&
    typeof existing.autoCreateSpecialists === 'boolean'
  ) {
    data.autoCreateSpecialists = existing.autoCreateSpecialists;
  }
  if (
    prefs.autoCreateThreshold === undefined &&
    existing &&
    typeof existing.autoCreateThreshold === 'number'
  ) {
    data.autoCreateThreshold = existing.autoCreateThreshold;
  }
  fs.writeFileSync(PREFS_PATH, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Reads stored preferences from the config directory.
 *
 * @returns Partial preferences object; missing fields are `undefined`.
 */
export function loadPreferences(): {
  provider?: string;
  model?: string;
  maxTokens?: number;
  shellTimeout?: number;
  tokenWindow?: number;
  maxSteps?: number;
  theme?: string;
  autoUpdate?: boolean;
  criticMode?: boolean;
  autoCreateSpecialists?: boolean;
  autoCreateThreshold?: number;
} {
  try {
    const data = fs.readFileSync(PREFS_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      maxTokens: typeof parsed.maxTokens === 'number' ? parsed.maxTokens : undefined,
      shellTimeout: typeof parsed.shellTimeout === 'number' ? parsed.shellTimeout : undefined,
      tokenWindow: typeof parsed.tokenWindow === 'number' ? parsed.tokenWindow : undefined,
      maxSteps: typeof parsed.maxSteps === 'number' ? parsed.maxSteps : undefined,
      theme: typeof parsed.theme === 'string' ? parsed.theme : undefined,
      autoUpdate: typeof parsed.autoUpdate === 'boolean' ? parsed.autoUpdate : undefined,
      criticMode: typeof parsed.criticMode === 'boolean' ? parsed.criticMode : undefined,
      autoCreateSpecialists:
        typeof parsed.autoCreateSpecialists === 'boolean'
          ? parsed.autoCreateSpecialists
          : undefined,
      autoCreateThreshold:
        typeof parsed.autoCreateThreshold === 'number' ? parsed.autoCreateThreshold : undefined,
    };
  } catch {
    return {};
  }
}

function loadStoredKeys(): Record<string, string> {
  try {
    const data = fs.readFileSync(KEYS_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Stores an API key for the given provider in the config directory (mode 0600).
 *
 * @throws {Error} If `provider` is not a recognised provider name.
 */
export function saveProviderKey(provider: string, key: string): void {
  if (!PROVIDER_ENV_VARS[provider]) {
    throw new Error(
      `Unknown provider "${provider}". Supported: ${Object.keys(PROVIDER_ENV_VARS).join(', ')}`,
    );
  }
  const dir = path.dirname(KEYS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const existing = loadStoredKeys();
  existing[provider] = key;
  fs.writeFileSync(KEYS_PATH, JSON.stringify(existing, null, 2) + '\n');
  fs.chmodSync(KEYS_PATH, 0o600);
}

/**
 * Removes the stored API key for the given provider.
 *
 * Deletes `keys.json` entirely when no keys remain.
 *
 * @throws {Error} If `provider` is unrecognised or has no stored key.
 */
export function removeProviderKey(provider: string): void {
  if (!PROVIDER_ENV_VARS[provider]) {
    throw new Error(
      `Unknown provider "${provider}". Supported: ${Object.keys(PROVIDER_ENV_VARS).join(', ')}`,
    );
  }
  const existing = loadStoredKeys();
  if (!existing[provider]) {
    throw new Error(`No stored API key found for "${provider}".`);
  }
  delete existing[provider];
  if (Object.keys(existing).length === 0) {
    if (fs.existsSync(KEYS_PATH)) {
      fs.unlinkSync(KEYS_PATH);
    }
  } else {
    fs.writeFileSync(KEYS_PATH, JSON.stringify(existing, null, 2) + '\n');
    fs.chmodSync(KEYS_PATH, 0o600);
  }
}

/**
 * Sets a numeric option (e.g. "max-tokens") and persists it to preferences.
 *
 * @throws {Error} If `name` is not in {@link OPTIONS_REGISTRY}.
 */
export function saveOption(name: string, value: number): void {
  const entry = OPTIONS_REGISTRY[name];
  if (!entry) {
    throw new Error(
      `Unknown option "${name}". Valid options: ${Object.keys(OPTIONS_REGISTRY).join(', ')}`,
    );
  }
  const prefs = loadPreferences();
  (prefs as Record<string, unknown>)[entry.configKey] = value;
  savePreferences({
    provider: prefs.provider || 'anthropic',
    model: prefs.model || getDefaultModel(prefs.provider || 'anthropic'),
    maxTokens: prefs.maxTokens,
    shellTimeout: prefs.shellTimeout,
    tokenWindow: prefs.tokenWindow,
    maxSteps: prefs.maxSteps,
    theme: prefs.theme,
  });
}

/**
 * Resets a single numeric option back to its default by removing it from preferences.
 *
 * @throws {Error} If `name` is not in {@link OPTIONS_REGISTRY}.
 */
export function resetOption(name: string): void {
  const entry = OPTIONS_REGISTRY[name];
  if (!entry) {
    throw new Error(
      `Unknown option "${name}". Valid options: ${Object.keys(OPTIONS_REGISTRY).join(', ')}`,
    );
  }
  const prefs = loadPreferences();
  delete (prefs as Record<string, unknown>)[entry.configKey];
  savePreferences({
    provider: prefs.provider || 'anthropic',
    model: prefs.model || getDefaultModel(prefs.provider || 'anthropic'),
    maxTokens: prefs.maxTokens,
    shellTimeout: prefs.shellTimeout,
    tokenWindow: prefs.tokenWindow,
    maxSteps: prefs.maxSteps,
    theme: prefs.theme,
  });
}

/** Resets all numeric options to their defaults by removing them from preferences. */
export function resetAllOptions(): void {
  const prefs = loadPreferences();
  savePreferences({
    provider: prefs.provider || 'anthropic',
    model: prefs.model || getDefaultModel(prefs.provider || 'anthropic'),
    maxTokens: undefined,
    shellTimeout: undefined,
    tokenWindow: undefined,
    maxSteps: undefined,
    theme: prefs.theme,
  });
}

/**
 * Returns the API key availability status for every known provider.
 *
 * Checks both stored keys and environment variables.
 */
export function getProviderKeyStatus(): Array<{ provider: string; hasKey: boolean }> {
  const cwdEnv = path.join(process.cwd(), '.env');
  const homeEnv = ENV_PATH;
  const legacyEnv = path.join(LEGACY_DIR, '.env');
  if (fs.existsSync(cwdEnv)) {
    dotenv.config({ path: cwdEnv });
  } else if (fs.existsSync(homeEnv)) {
    dotenv.config({ path: homeEnv });
  } else if (fs.existsSync(legacyEnv)) {
    dotenv.config({ path: legacyEnv });
  }

  const storedKeys = loadStoredKeys();

  return Object.entries(PROVIDER_ENV_VARS).map(([provider, envVar]) => ({
    provider,
    hasKey: !!(storedKeys[provider] || process.env[envVar]),
  }));
}

/** Known model identifiers for each provider, ordered by preference (first = default). */
export const PROVIDER_MODELS: Record<string, string[]> = {
  anthropic: [
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-6',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-20250514',
    'claude-sonnet-4-20250514',
  ],
  openai: [
    'gpt-5.2',
    'gpt-5.2-chat-latest',
    'o3',
    'o3-mini',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
  ],
  xai: [
    'grok-4-fast-non-reasoning',
    'grok-4-fast-reasoning',
    'grok-4-1-fast-non-reasoning',
    'grok-4-1-fast-reasoning',
    'grok-4-0709',
    'grok-code-fast-1',
    'grok-3',
    'grok-3-mini',
  ],
};

/** Returns the first (preferred) model for a provider, falling back to Anthropic's default. */
export function getDefaultModel(provider: string): string {
  return PROVIDER_MODELS[provider]?.[0] ?? PROVIDER_MODELS[DEFAULT_PROVIDER][0];
}

/** Returns the API key for the given provider from config, or undefined if not set. */
export function getProviderApiKey(config: BernardConfig, provider: string): string | undefined {
  const keyMap: Record<string, string | undefined> = {
    anthropic: config.anthropicApiKey,
    openai: config.openaiApiKey,
    xai: config.xaiApiKey,
  };
  return Object.hasOwn(keyMap, provider) ? keyMap[provider] : undefined;
}

/** Returns provider names that have an API key present in the given config. */
export function getAvailableProviders(config: BernardConfig): string[] {
  return Object.keys(PROVIDER_MODELS).filter((p) => !!getProviderApiKey(config, p));
}

/** Returns true if the given provider name is a known provider in PROVIDER_MODELS. */
export function isValidProvider(provider: string): boolean {
  return Object.hasOwn(PROVIDER_MODELS, provider);
}

/** Returns true if the given config has an API key for the specified provider. */
export function hasProviderKey(config: BernardConfig, provider: string): boolean {
  return !!getProviderApiKey(config, provider);
}

/**
 * Builds a fully-resolved {@link BernardConfig} by merging (in priority order):
 * CLI overrides, saved preferences, environment variables, and built-in defaults.
 *
 * Also loads `.env` files and stored API keys into `process.env`.
 *
 * @param overrides - Optional CLI-supplied provider/model that take highest priority.
 * @throws {Error} If the selected provider has no API key configured.
 */
export function loadConfig(overrides?: { provider?: string; model?: string }): BernardConfig {
  // Load .env from cwd first, then XDG config dir, then legacy ~/.bernard/
  const cwdEnv = path.join(process.cwd(), '.env');
  const legacyEnv = path.join(LEGACY_DIR, '.env');

  if (fs.existsSync(cwdEnv)) {
    dotenv.config({ path: cwdEnv });
  } else if (fs.existsSync(ENV_PATH)) {
    dotenv.config({ path: ENV_PATH });
  } else if (fs.existsSync(legacyEnv)) {
    dotenv.config({ path: legacyEnv });
  }

  // Stored keys override .env — user explicitly ran `add-key`
  const storedKeys = loadStoredKeys();
  for (const [provider, key] of Object.entries(storedKeys)) {
    const envVar = PROVIDER_ENV_VARS[provider];
    if (envVar && key) process.env[envVar] = key;
  }

  const prefs = loadPreferences();
  const explicitProvider = overrides?.provider || prefs.provider || process.env.BERNARD_PROVIDER;
  let provider = explicitProvider || DEFAULT_PROVIDER;
  let model =
    overrides?.model || prefs.model || process.env.BERNARD_MODEL || getDefaultModel(provider);

  // When provider was not explicitly chosen and the default has no key,
  // auto-detect the first provider that does have a key available.
  if (!explicitProvider) {
    const keyMap: Record<string, string | undefined> = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      xai: process.env.XAI_API_KEY,
    };
    if (!keyMap[provider]) {
      const available = Object.keys(PROVIDER_ENV_VARS).find((p) => !!keyMap[p]);
      if (available) {
        provider = available;
        if (!overrides?.model && !prefs.model && !process.env.BERNARD_MODEL) {
          model = getDefaultModel(provider);
        }
      }
    }
  }
  const maxTokens =
    prefs.maxTokens ?? (parseInt(process.env.BERNARD_MAX_TOKENS || '', 10) || DEFAULT_MAX_TOKENS);
  const shellTimeout =
    prefs.shellTimeout ??
    (parseInt(process.env.BERNARD_SHELL_TIMEOUT || '', 10) || DEFAULT_SHELL_TIMEOUT);
  const tokenWindow =
    prefs.tokenWindow ??
    (parseInt(process.env.BERNARD_TOKEN_WINDOW || '', 10) || DEFAULT_TOKEN_WINDOW);
  const rawMaxSteps =
    prefs.maxSteps ?? (parseInt(process.env.BERNARD_MAX_STEPS || '', 10) || DEFAULT_MAX_STEPS);
  const maxSteps =
    Number.isFinite(rawMaxSteps) && rawMaxSteps >= 1 ? Math.floor(rawMaxSteps) : DEFAULT_MAX_STEPS;

  const ragEnabled = process.env.BERNARD_RAG_ENABLED !== 'false';
  const theme = prefs.theme || 'bernard';
  const criticMode =
    prefs.criticMode ??
    (process.env.BERNARD_CRITIC_MODE === 'true' || process.env.BERNARD_CRITIC_MODE === '1');

  const autoCreateSpecialists =
    prefs.autoCreateSpecialists ??
    (process.env.BERNARD_AUTO_CREATE_SPECIALISTS === 'true' ||
    process.env.BERNARD_AUTO_CREATE_SPECIALISTS === '1'
      ? true
      : DEFAULT_AUTO_CREATE_SPECIALISTS);

  const envAutoCreateThreshold = parseFloat(process.env.BERNARD_AUTO_CREATE_THRESHOLD ?? '');
  const autoCreateThreshold = normalizeThreshold(
    prefs.autoCreateThreshold ??
    (Number.isFinite(envAutoCreateThreshold)
      ? envAutoCreateThreshold
      : DEFAULT_AUTO_CREATE_THRESHOLD),
  );

  const config: BernardConfig = {
    provider,
    model,
    maxTokens,
    shellTimeout,
    tokenWindow,
    maxSteps,
    ragEnabled,
    theme,
    criticMode,
    autoCreateSpecialists,
    autoCreateThreshold,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    xaiApiKey: process.env.XAI_API_KEY,
  };

  validateConfig(config);
  return config;
}

function validateConfig(config: BernardConfig): void {
  const key = getProviderApiKey(config, config.provider);
  if (!key) {
    const envVar = PROVIDER_ENV_VARS[config.provider];
    throw new Error(
      `No API key found for provider "${config.provider}". ` +
        `Run: bernard add-key ${config.provider} <your-api-key>\n` +
        `Or set ${envVar} in your .env file or environment.`,
    );
  }
}
