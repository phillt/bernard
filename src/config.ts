import * as dotenv from 'dotenv';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

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
  /** Whether RAG memory retrieval is active. */
  ragEnabled: boolean;
  /** Color theme name for terminal output. */
  theme: string;
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
const PREFS_PATH = path.join(os.homedir(), '.bernard', 'preferences.json');
const KEYS_PATH = path.join(os.homedir(), '.bernard', 'keys.json');

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
    configKey: 'maxTokens' | 'shellTimeout';
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
};

/**
 * Persists user preferences to `~/.bernard/preferences.json`.
 *
 * Preserves the existing `autoUpdate` flag when the caller omits it.
 */
export function savePreferences(prefs: {
  provider: string;
  model: string;
  maxTokens?: number;
  shellTimeout?: number;
  theme?: string;
  autoUpdate?: boolean;
}): void {
  const dir = path.dirname(PREFS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data: Record<string, unknown> = { provider: prefs.provider, model: prefs.model };
  if (prefs.maxTokens !== undefined) data.maxTokens = prefs.maxTokens;
  if (prefs.shellTimeout !== undefined) data.shellTimeout = prefs.shellTimeout;
  if (prefs.theme !== undefined) data.theme = prefs.theme;
  if (prefs.autoUpdate !== undefined) {
    data.autoUpdate = prefs.autoUpdate;
  } else {
    // Preserve autoUpdate from existing prefs when callers don't pass it
    try {
      const existing = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf-8'));
      if (typeof existing.autoUpdate === 'boolean') data.autoUpdate = existing.autoUpdate;
    } catch {
      /* ignore */
    }
  }
  fs.writeFileSync(PREFS_PATH, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Reads stored preferences from `~/.bernard/preferences.json`.
 *
 * @returns Partial preferences object; missing fields are `undefined`.
 */
export function loadPreferences(): {
  provider?: string;
  model?: string;
  maxTokens?: number;
  shellTimeout?: number;
  theme?: string;
  autoUpdate?: boolean;
} {
  try {
    const data = fs.readFileSync(PREFS_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      maxTokens: typeof parsed.maxTokens === 'number' ? parsed.maxTokens : undefined,
      shellTimeout: typeof parsed.shellTimeout === 'number' ? parsed.shellTimeout : undefined,
      theme: typeof parsed.theme === 'string' ? parsed.theme : undefined,
      autoUpdate: typeof parsed.autoUpdate === 'boolean' ? parsed.autoUpdate : undefined,
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
 * Stores an API key for the given provider in `~/.bernard/keys.json` (mode 0600).
 *
 * @throws If `provider` is not a recognised provider name.
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
 * @throws If `provider` is unrecognised or has no stored key.
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
 * @throws If `name` is not in {@link OPTIONS_REGISTRY}.
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
    theme: prefs.theme,
  });
}

/**
 * Resets a single numeric option back to its default by removing it from preferences.
 *
 * @throws If `name` is not in {@link OPTIONS_REGISTRY}.
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
    theme: prefs.theme,
  });
}

/** Resets all numeric options to their defaults by removing them from preferences. */
export function resetAllOptions(): void {
  const prefs = loadPreferences();
  delete (prefs as Record<string, unknown>).maxTokens;
  delete (prefs as Record<string, unknown>).shellTimeout;
  savePreferences({
    provider: prefs.provider || 'anthropic',
    model: prefs.model || getDefaultModel(prefs.provider || 'anthropic'),
    theme: prefs.theme,
  });
}

/**
 * Returns the API key availability status for every known provider.
 *
 * Checks both stored keys (`~/.bernard/keys.json`) and environment variables.
 */
export function getProviderKeyStatus(): Array<{ provider: string; hasKey: boolean }> {
  const cwdEnv = path.join(process.cwd(), '.env');
  const homeEnv = path.join(os.homedir(), '.bernard', '.env');
  if (fs.existsSync(cwdEnv)) {
    dotenv.config({ path: cwdEnv });
  } else if (fs.existsSync(homeEnv)) {
    dotenv.config({ path: homeEnv });
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

/** Returns provider names that have an API key present in the given config. */
export function getAvailableProviders(config: BernardConfig): string[] {
  const keyMap: Record<string, string | undefined> = {
    anthropic: config.anthropicApiKey,
    openai: config.openaiApiKey,
    xai: config.xaiApiKey,
  };
  return Object.keys(PROVIDER_MODELS).filter((p) => !!keyMap[p]);
}

/**
 * Builds a fully-resolved {@link BernardConfig} by merging (in priority order):
 * CLI overrides, saved preferences, environment variables, and built-in defaults.
 *
 * Also loads `.env` files and stored API keys into `process.env`.
 *
 * @param overrides - Optional CLI-supplied provider/model that take highest priority.
 * @throws If the selected provider has no API key configured.
 */
export function loadConfig(overrides?: { provider?: string; model?: string }): BernardConfig {
  // Load .env from cwd first, then fallback to ~/.bernard/.env
  const cwdEnv = path.join(process.cwd(), '.env');
  const homeEnv = path.join(os.homedir(), '.bernard', '.env');

  if (fs.existsSync(cwdEnv)) {
    dotenv.config({ path: cwdEnv });
  } else if (fs.existsSync(homeEnv)) {
    dotenv.config({ path: homeEnv });
  }

  // Stored keys override .env — user explicitly ran `add-key`
  const storedKeys = loadStoredKeys();
  for (const [provider, key] of Object.entries(storedKeys)) {
    const envVar = PROVIDER_ENV_VARS[provider];
    if (envVar && key) process.env[envVar] = key;
  }

  const prefs = loadPreferences();
  const provider =
    overrides?.provider || prefs.provider || process.env.BERNARD_PROVIDER || DEFAULT_PROVIDER;
  const model =
    overrides?.model || prefs.model || process.env.BERNARD_MODEL || getDefaultModel(provider);
  const maxTokens =
    prefs.maxTokens ?? (parseInt(process.env.BERNARD_MAX_TOKENS || '', 10) || DEFAULT_MAX_TOKENS);
  const shellTimeout =
    prefs.shellTimeout ??
    (parseInt(process.env.BERNARD_SHELL_TIMEOUT || '', 10) || DEFAULT_SHELL_TIMEOUT);

  const ragEnabled = process.env.BERNARD_RAG_ENABLED !== 'false';
  const theme = prefs.theme || 'bernard';

  const config: BernardConfig = {
    provider,
    model,
    maxTokens,
    shellTimeout,
    ragEnabled,
    theme,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    xaiApiKey: process.env.XAI_API_KEY,
  };

  validateConfig(config);
  return config;
}

function validateConfig(config: BernardConfig): void {
  const keyMap: Record<string, string | undefined> = {
    anthropic: config.anthropicApiKey,
    openai: config.openaiApiKey,
    xai: config.xaiApiKey,
  };

  const key = keyMap[config.provider];
  if (!key) {
    const envVar = PROVIDER_ENV_VARS[config.provider];
    throw new Error(
      `No API key found for provider "${config.provider}". ` +
        `Run: bernard add-key ${config.provider} <your-api-key>\n` +
        `Or set ${envVar} in your .env file or environment.`,
    );
  }
}
