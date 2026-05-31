import * as dotenv from 'dotenv';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { KEYS_PATH, ENV_PATH, LEGACY_DIR } from './paths.js';
import { loadCustomProviders, validateBaseURL, type CustomProvider } from './custom-providers.js';
import { loadProfiles, saveActiveSettings, type ProfileSettings } from './profiles.js';
import {
  setMaxConcurrentAgents,
  DEFAULT_MAX_CONCURRENT_AGENTS as POOL_DEFAULT_MAX,
  MAX_CONCURRENT_AGENTS_LIMIT,
} from './tools/agent-pool.js';
import { RESPONSE_STYLE_IDS, type ResponseStyle } from './agent-prompt.js';

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
  /**
   * Coordinator (ReAct) mode selector. `'on'` forces every turn through
   * ReAct; `'off'` forces NormalStrategy; `'auto'` delegates to the Qualifier
   * (`src/qualifier/`) which classifies each ask and picks a strategy per
   * turn. The Policy Engine reads this field via `strategyPolicy` (#167).
   */
  coordinatorMode: 'on' | 'off' | 'auto';
  /**
   * Multi-model assignment policy (#170). `'off'` keeps every LLM call site
   * pinned to `provider`/`model` (legacy behavior). `'optimize-tokens'`,
   * `'balanced'`, and `'optimize-performance'` route each site through
   * `resolveSiteModel` in `src/model-policy.ts` to pick a cheap / mid / premium
   * tier of the active provider's model lineup.
   */
  modelMode: 'off' | 'optimize-tokens' | 'balanced' | 'optimize-performance';
  /** Whether sub-agent delegations run through the PAC (Planner → Actor → Critic) pipeline. */
  subagentPac: boolean;
  /** Whether tool-call arguments and full tool result output are shown in the terminal. Tool names and call lines are always shown. */
  toolDetails: boolean;
  /** Whether to auto-create specialists above the confidence threshold. */
  autoCreateSpecialists: boolean;
  /** Confidence threshold for auto-creating specialists (0-1). */
  autoCreateThreshold: number;
  /** Whether the correction agent runs at session close to learn from tool-wrapper failures. */
  correctionEnabled: boolean;
  /** Whether the model-specific prompt rewriter runs as a pre-turn LLM pass. */
  promptRewriter: boolean;
  /**
   * Whether the in-process caching layer (#171) is active. Covers deterministic
   * tool results, select LLM subcalls (rewriter, reference-lookup), and the
   * per-turn RAG search cache. Default `true`; opt out via
   * `BERNARD_CACHE_ENABLED=false`. Not persisted to preferences — environment
   * toggle only.
   */
  cacheEnabled: boolean;
  /**
   * Risk-based confirmation policy (#144). `'off'` never prompts; `'auto'`
   * (default) prompts only for `high`-risk tool calls (destructive shell,
   * external-API mutations); `'strict'` adds `medium` (all local writes
   * and unclassified MCP tools). The Policy Engine maps this to a
   * `confirmThreshold` consumed by the augment layer's pre-call gate.
   */
  confirmMode: 'off' | 'auto' | 'strict';
  /**
   * Global least-privilege tool mode (#179). `'read-only'` (default) blocks any
   * tool whose meta declares `kind: 'write' | 'dangerous'` behind an interactive
   * enable-write prompt; users can allow once or unlock a single tool for the
   * remainder of the session. `'write'` lets every tool run subject only to the
   * `confirmMode` risk gate (#144). The two gates compose orthogonally — toolMode
   * answers "is this allowed to run at all?" and confirmMode answers "do I want
   * to be asked first?".
   */
  toolMode: 'read-only' | 'write';
  /**
   * Whether concise-by-default response shaping is active (#175). When on, the
   * Policy Engine emits `concise.enabled = true` and the main agent's system
   * prompt receives a `## Concise Mode` block instructing the model to keep
   * responses to the smallest sufficient size. Token/latency optimization, not
   * a style preference.
   */
  conciseMode: boolean;
  /**
   * Maximum concurrent sub-agents / tasks / specialists allowed in the shared
   * pool (issue #133). Defaults to 4; users can raise up to
   * `MAX_CONCURRENT_AGENTS_LIMIT` (20) via `BERNARD_MAX_CONCURRENT_AGENTS`,
   * `bernard set-max-concurrent`, or the `/agent-options` REPL menu.
   * `loadConfig` applies the resolved value to the live pool via
   * `setMaxConcurrentAgents`.
   */
  maxConcurrentAgents: number;
  /**
   * User-selected response shape (issue #133). `'default'` injects nothing;
   * the other ids append a matching `## Response Style` block from
   * `RESPONSE_STYLE_PROMPTS` to the main system prompt. Orthogonal to
   * `conciseMode`: concise governs length budget, style governs form.
   */
  responseStyle: ResponseStyle;
  /** Whether the resolver attempts a tool-based lookup before prompting the user for unknown references. */
  referenceLookup: boolean;
  /** Extra tool-name allowlist for the reference-lookup pass (additive over built-in patterns). */
  referenceLookupTools: string[];
  /**
   * Jaccard-similarity threshold (0-1) below which the scratch-lifecycle policy
   * (#169) treats a user turn as a subject change and clears all scratch.
   * Lower = more conservative (only very dissimilar turns clear scratch).
   */
  scratchSubjectThreshold: number;
  /** Anthropic API key, if available. */
  anthropicApiKey?: string;
  /** OpenAI API key, if available. */
  openaiApiKey?: string;
  /** xAI API key, if available. */
  xaiApiKey?: string;
  /**
   * Generic provider -> API key map sourced from `keys.json`. Carries keys
   * for both built-in and custom providers. The named fields above are kept
   * as a backwards-compat read view for the three built-in providers.
   */
  apiKeys?: Record<string, string>;
  /** Loaded snapshot of user-defined custom providers from `custom-providers.json`. */
  customProviders: Record<string, CustomProvider>;
  /**
   * One-shot override for the active built-in provider's endpoint URL.
   * Only set when the user passes `--allow-provider-base-url` together with
   * `--provider-base-url <url>` on the CLI. Never persisted; never read from
   * env or preferences. See `bernard add-provider` for the persistent path.
   */
  providerBaseUrl?: string;
}

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_SHELL_TIMEOUT = 30000;
const DEFAULT_TOKEN_WINDOW = 0;
const DEFAULT_MAX_STEPS = 25;
const DEFAULT_AUTO_CREATE_SPECIALISTS = false;
const DEFAULT_AUTO_CREATE_THRESHOLD = 0.8;
const DEFAULT_COORDINATOR_MODE: 'on' | 'off' | 'auto' = 'auto';
const DEFAULT_CONFIRM_MODE: 'off' | 'auto' | 'strict' = 'auto';
const DEFAULT_TOOL_MODE: 'read-only' | 'write' = 'read-only';
const DEFAULT_MODEL_MODE: 'off' | 'optimize-tokens' | 'balanced' | 'optimize-performance' = 'off';
const DEFAULT_SCRATCH_SUBJECT_THRESHOLD = 0.15;
const DEFAULT_CONCISE_MODE = true;
const DEFAULT_MAX_CONCURRENT_AGENTS = POOL_DEFAULT_MAX;
const DEFAULT_RESPONSE_STYLE: ResponseStyle = 'default';

/** Type guard for `coordinatorMode` string values. */
function isCoordinatorMode(v: unknown): v is 'on' | 'off' | 'auto' {
  return v === 'on' || v === 'off' || v === 'auto';
}

/** Type guard for `confirmMode` string values (#144). */
export function isConfirmMode(v: unknown): v is 'off' | 'auto' | 'strict' {
  return v === 'off' || v === 'auto' || v === 'strict';
}

/** Type guard for `toolMode` string values (#179). */
export function isToolMode(v: unknown): v is 'read-only' | 'write' {
  return v === 'read-only' || v === 'write';
}

/** Type guard for `modelMode` string values (#170). */
export function isModelMode(
  v: unknown,
): v is 'off' | 'optimize-tokens' | 'balanced' | 'optimize-performance' {
  return v === 'off' || v === 'optimize-tokens' || v === 'balanced' || v === 'optimize-performance';
}

/** Type guard for `responseStyle` string values (#133). */
export function isResponseStyle(v: unknown): v is ResponseStyle {
  return typeof v === 'string' && (RESPONSE_STYLE_IDS as ReadonlyArray<string>).includes(v);
}

/**
 * Clamps an arbitrary number to a valid `maxConcurrentAgents` value: integer
 * in `[1, MAX_CONCURRENT_AGENTS_LIMIT]`. Returns the default for non-finite
 * input so we never silently disable parallelism on a malformed env var.
 */
export function normalizeMaxConcurrentAgents(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CONCURRENT_AGENTS;
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  if (floored > MAX_CONCURRENT_AGENTS_LIMIT) return MAX_CONCURRENT_AGENTS_LIMIT;
  return floored;
}

/**
 * Maps a legacy `reactMode` boolean (used by older preferences files and the
 * deprecated `BERNARD_REACT_MODE` env var) onto the tri-state `coordinatorMode`.
 * Explicit booleans become `'on'`/`'off'`; missing values stay `undefined` so
 * the caller can fall through to the next layer.
 */
function legacyReactModeToCoordinator(value: boolean | undefined): 'on' | 'off' | undefined {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return undefined;
}

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
    description:
      'Maximum agent loop iterations per request (tripled automatically in coordinator / ReAct mode)',
    envVar: 'BERNARD_MAX_STEPS',
  },
};

/**
 * Persists user preferences to the **active profile** in `profiles.json` (#207).
 *
 * Acts as a partial patch: any field present in `prefs` (including `undefined`
 * to explicitly reset that field) is merged into the active profile's settings.
 * Other fields are preserved as-is. The provider/model arguments stay required
 * for backwards-compat with the pre-profiles signature but are themselves
 * patched in just like any other field.
 *
 * Side-effect note: if `profiles.json` does not yet exist on disk, the first
 * call here lazily creates it (migrating from a legacy `preferences.json` when
 * present) before merging this patch on top.
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
  coordinatorMode?: 'on' | 'off' | 'auto';
  modelMode?: 'off' | 'optimize-tokens' | 'balanced' | 'optimize-performance';
  subagentPac?: boolean;
  toolDetails?: boolean;
  autoCreateSpecialists?: boolean;
  autoCreateThreshold?: number;
  promptRewriter?: boolean;
  referenceLookup?: boolean;
  scratchSubjectThreshold?: number;
  conciseMode?: boolean;
  confirmMode?: 'off' | 'auto' | 'strict';
  toolMode?: 'read-only' | 'write';
  maxConcurrentAgents?: number;
  responseStyle?: ResponseStyle;
}): void {
  // Patch shape matches ProfileSettings exactly — keys present in `prefs`
  // (including explicit `undefined`s from resetOption / resetAllOptions) are
  // applied; missing keys are preserved by saveActiveSettings.
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(prefs)) {
    patch[k] = (prefs as Record<string, unknown>)[k];
  }
  saveActiveSettings(patch as ProfileSettings);
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
  coordinatorMode?: 'on' | 'off' | 'auto';
  modelMode?: 'off' | 'optimize-tokens' | 'balanced' | 'optimize-performance';
  subagentPac?: boolean;
  toolDetails?: boolean;
  autoCreateSpecialists?: boolean;
  autoCreateThreshold?: number;
  promptRewriter?: boolean;
  referenceLookup?: boolean;
  scratchSubjectThreshold?: number;
  conciseMode?: boolean;
  confirmMode?: 'off' | 'auto' | 'strict';
  toolMode?: 'read-only' | 'write';
  maxConcurrentAgents?: number;
  responseStyle?: ResponseStyle;
} {
  // Routes through the active profile in profiles.json (#207). Each field is
  // type-checked here so a malformed stored value falls through to undefined
  // and `loadConfig` picks up the env/default value instead.
  const { file } = loadProfiles();
  const parsed = file.profiles[file.activeProfileId]?.settings ?? {};
  const coordinatorMode = isCoordinatorMode(parsed.coordinatorMode)
    ? parsed.coordinatorMode
    : legacyReactModeToCoordinator(
        typeof (parsed as { reactMode?: unknown }).reactMode === 'boolean'
          ? ((parsed as { reactMode?: boolean }).reactMode as boolean)
          : undefined,
      );
  return {
    provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    maxTokens: typeof parsed.maxTokens === 'number' ? parsed.maxTokens : undefined,
    shellTimeout: typeof parsed.shellTimeout === 'number' ? parsed.shellTimeout : undefined,
    tokenWindow: typeof parsed.tokenWindow === 'number' ? parsed.tokenWindow : undefined,
    maxSteps: typeof parsed.maxSteps === 'number' ? parsed.maxSteps : undefined,
    theme: typeof parsed.theme === 'string' ? parsed.theme : undefined,
    autoUpdate: typeof parsed.autoUpdate === 'boolean' ? parsed.autoUpdate : undefined,
    coordinatorMode,
    modelMode: isModelMode(parsed.modelMode) ? parsed.modelMode : undefined,
    subagentPac: typeof parsed.subagentPac === 'boolean' ? parsed.subagentPac : undefined,
    toolDetails: typeof parsed.toolDetails === 'boolean' ? parsed.toolDetails : undefined,
    autoCreateSpecialists:
      typeof parsed.autoCreateSpecialists === 'boolean' ? parsed.autoCreateSpecialists : undefined,
    autoCreateThreshold:
      typeof parsed.autoCreateThreshold === 'number' ? parsed.autoCreateThreshold : undefined,
    promptRewriter: typeof parsed.promptRewriter === 'boolean' ? parsed.promptRewriter : undefined,
    referenceLookup:
      typeof parsed.referenceLookup === 'boolean' ? parsed.referenceLookup : undefined,
    scratchSubjectThreshold:
      typeof parsed.scratchSubjectThreshold === 'number'
        ? parsed.scratchSubjectThreshold
        : undefined,
    conciseMode: typeof parsed.conciseMode === 'boolean' ? parsed.conciseMode : undefined,
    confirmMode: isConfirmMode(parsed.confirmMode) ? parsed.confirmMode : undefined,
    toolMode: isToolMode(parsed.toolMode) ? parsed.toolMode : undefined,
    maxConcurrentAgents:
      typeof parsed.maxConcurrentAgents === 'number' ? parsed.maxConcurrentAgents : undefined,
    responseStyle: isResponseStyle(parsed.responseStyle) ? parsed.responseStyle : undefined,
  };
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
 * Accepts both built-in providers and custom providers that have been
 * registered via `bernard add-provider`.
 *
 * @throws {Error} If `provider` is neither a built-in nor a known custom provider.
 */
export function saveProviderKey(provider: string, key: string): void {
  const isBuiltin = !!PROVIDER_ENV_VARS[provider];
  if (!isBuiltin) {
    const customProviders = loadCustomProviders();
    if (!Object.hasOwn(customProviders, provider)) {
      const known = [...Object.keys(PROVIDER_ENV_VARS), ...Object.keys(customProviders)];
      throw new Error(
        `Unknown provider "${provider}". Known: ${known.join(', ') || '(none)'}. ` +
          `Run \`bernard add-provider ${provider} …\` first to register a custom provider.`,
      );
    }
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
 * @throws {Error} If `provider` has no stored key.
 */
export function removeProviderKey(provider: string): void {
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
 * Returns the API key availability status for every known provider —
 * built-in providers plus any registered custom providers.
 *
 * Checks both stored keys and environment variables (env vars apply only
 * to the three built-in providers; custom providers always use `keys.json`).
 */
export function getProviderKeyStatus(): Array<{
  provider: string;
  hasKey: boolean;
  custom?: boolean;
}> {
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
  const customProviders = loadCustomProviders();

  const builtin = Object.entries(PROVIDER_ENV_VARS).map(([provider, envVar]) => ({
    provider,
    hasKey: !!(storedKeys[provider] || process.env[envVar]),
  }));
  const custom = Object.keys(customProviders).map((provider) => ({
    provider,
    hasKey: !!storedKeys[provider],
    custom: true,
  }));
  return [...builtin, ...custom];
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

/**
 * Returns the first (preferred) model for a provider.
 *
 * For built-ins this is the first entry in `PROVIDER_MODELS`. For custom
 * providers it is the registered `defaultModel`. Falls back to Anthropic's
 * built-in default when the provider is unknown.
 */
export function getDefaultModel(
  provider: string,
  customProviders?: Record<string, CustomProvider>,
): string {
  if (PROVIDER_MODELS[provider]) return PROVIDER_MODELS[provider][0];
  const custom = customProviders ?? loadCustomProviders();
  if (custom[provider]) return custom[provider].defaultModel;
  return PROVIDER_MODELS[DEFAULT_PROVIDER][0];
}

/**
 * Returns the API key for the given provider from config, or undefined if not set.
 *
 * Looks up the generic `apiKeys` map first (which carries keys for both
 * built-in and custom providers), then falls back to the legacy named fields
 * (`anthropicApiKey`/`openaiApiKey`/`xaiApiKey`) for backwards compat with
 * older test fixtures.
 */
export function getProviderApiKey(config: BernardConfig, provider: string): string | undefined {
  if (config.apiKeys && Object.hasOwn(config.apiKeys, provider) && config.apiKeys[provider]) {
    return config.apiKeys[provider];
  }
  switch (provider) {
    case 'anthropic':
      return config.anthropicApiKey;
    case 'openai':
      return config.openaiApiKey;
    case 'xai':
      return config.xaiApiKey;
    default:
      return undefined;
  }
}

/**
 * Returns provider names that have an API key present in the given config.
 * Built-ins precede custom providers in the returned list.
 */
export function getAvailableProviders(config: BernardConfig): string[] {
  const builtin = Object.keys(PROVIDER_MODELS).filter((p) => !!getProviderApiKey(config, p));
  const custom = Object.keys(config.customProviders ?? {}).filter(
    (p) => !!getProviderApiKey(config, p),
  );
  return [...builtin, ...custom];
}

/**
 * Returns true if `provider` is a known provider — built-in or registered
 * as a custom provider in the supplied (or freshly loaded) registry.
 */
export function isValidProvider(
  provider: string,
  customProviders?: Record<string, CustomProvider>,
): boolean {
  if (Object.hasOwn(PROVIDER_MODELS, provider)) return true;
  const custom = customProviders ?? loadCustomProviders();
  return Object.hasOwn(custom, provider);
}

/** Returns true if the given config has an API key for the specified provider. */
export function hasProviderKey(config: BernardConfig, provider: string): boolean {
  return !!getProviderApiKey(config, provider);
}

/**
 * Returns the conventional env-var name for an API key for the given provider.
 * Built-ins return the canonical `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY`;
 * custom providers return `BERNARD_<NAME>_API_KEY` (informational only — custom
 * keys are never read from env, only from `keys.json`).
 */
export function providerEnvVar(provider: string): string {
  return (
    PROVIDER_ENV_VARS[provider] ?? `BERNARD_${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`
  );
}

/**
 * Coerces an empty or whitespace-only string to undefined, otherwise trims it.
 * Used to normalize provider/model overrides — the model sometimes passes
 * `provider: ""` to mean "use default" and saved specialists may have
 * `"provider": ""`. With `??` chains, empty strings would falsely "win" over
 * the next fallback; this helper makes them fall through.
 */
export function blankToUndefined(v: string | undefined): string | undefined {
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Result of {@link resolveProviderAndModel}. On the failure branch, `provider`
 * is the resolved provider name and `envVar` is the conventional environment
 * variable for it — only meaningful for built-in providers. Custom-provider
 * keys are stored in `keys.json` and never read from `process.env`, so
 * callers should hide the env-var hint when `isCustom` is `true`.
 */
export type ProviderResolution =
  | { ok: true; provider: string; model: string }
  | { ok: false; provider: string; envVar: string; isCustom: boolean };

/**
 * Resolves the provider and model to use for a sub-agent / specialist /
 * task / tool-wrapper invocation, applying the same precedence rule across
 * all four call sites:
 *
 * 1. Invocation-level override (the model passes `provider`/`model` args).
 * 2. Specialist-level default (when invoking a saved specialist).
 * 3. Global config.
 *
 * Empty/whitespace strings are treated as "not provided". When the resolved
 * provider differs from `config.provider` and no explicit model override is
 * given, `getDefaultModel(provider)` is used to avoid cross-provider model
 * mismatches (e.g. xai provider with an Anthropic model name).
 */
export function resolveProviderAndModel(opts: {
  provider?: string;
  model?: string;
  specialistProvider?: string;
  specialistModel?: string;
  config: BernardConfig;
}): ProviderResolution {
  const provider =
    blankToUndefined(opts.provider) ??
    blankToUndefined(opts.specialistProvider) ??
    opts.config.provider;
  const explicitModel = blankToUndefined(opts.model) ?? blankToUndefined(opts.specialistModel);
  const model =
    explicitModel ??
    (provider !== opts.config.provider
      ? getDefaultModel(provider, opts.config.customProviders)
      : opts.config.model);

  if (!hasProviderKey(opts.config, provider)) {
    const isCustom = Object.hasOwn(opts.config.customProviders ?? {}, provider);
    return { ok: false, provider, envVar: providerEnvVar(provider), isCustom };
  }
  return { ok: true, provider, model };
}

/**
 * Default error message format for a {@link ProviderResolution} failure.
 * Used by the plain-string callers (specialist-run, subagent). Other callers
 * (task: JSON-wrapped, tool-wrapper-run: shorter format) format their own.
 *
 * For custom providers, omits the env-var suggestion — those keys are not
 * read from `process.env`.
 */
export function defaultProviderErrorMessage(
  provider: string,
  envVar: string,
  isCustom = false,
): string {
  const envHint = isCustom ? '' : ` or set ${envVar}`;
  return `No API key found for provider "${provider}". Run: bernard add-key ${provider} <your-api-key>${envHint}.`;
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
export function loadConfig(overrides?: {
  provider?: string;
  model?: string;
  providerBaseUrl?: string;
  allowProviderBaseUrl?: boolean;
}): BernardConfig {
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

  // Stored keys override .env — user explicitly ran `add-key`.
  // Built-in providers also get their key bridged into `process.env` so the
  // AI SDK module-level singletons pick it up. Custom-provider keys live only
  // in `config.apiKeys` and are read directly when constructing the model.
  const storedKeys = loadStoredKeys();
  for (const [provider, key] of Object.entries(storedKeys)) {
    const envVar = PROVIDER_ENV_VARS[provider];
    if (envVar && key) process.env[envVar] = key;
  }

  const customProviders = loadCustomProviders();
  const prefs = loadPreferences();
  const explicitProvider = overrides?.provider || prefs.provider || process.env.BERNARD_PROVIDER;
  let provider = explicitProvider || DEFAULT_PROVIDER;
  let model =
    overrides?.model ||
    prefs.model ||
    process.env.BERNARD_MODEL ||
    getDefaultModel(provider, customProviders);

  // When provider was not explicitly chosen and the default has no key,
  // auto-detect the first provider (built-in or custom) that does have one.
  if (!explicitProvider) {
    const builtinKeys: Record<string, string | undefined> = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      xai: process.env.XAI_API_KEY,
    };
    const hasKey = (p: string): boolean => {
      if (builtinKeys[p]) return true;
      return !!storedKeys[p];
    };
    if (!hasKey(provider)) {
      const available =
        Object.keys(PROVIDER_ENV_VARS).find(hasKey) ?? Object.keys(customProviders).find(hasKey);
      if (available) {
        provider = available;
        if (!overrides?.model && !prefs.model && !process.env.BERNARD_MODEL) {
          model = getDefaultModel(provider, customProviders);
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
  const cacheEnabled = process.env.BERNARD_CACHE_ENABLED !== 'false';
  const theme = prefs.theme || 'bernard';

  // Tri-state coordinator mode (#167). Precedence: explicit pref >
  // BERNARD_COORDINATOR_MODE env > deprecated BERNARD_REACT_MODE env > default.
  const envCoordinator = isCoordinatorMode(process.env.BERNARD_COORDINATOR_MODE)
    ? (process.env.BERNARD_COORDINATOR_MODE as 'on' | 'off' | 'auto')
    : undefined;
  const envLegacyReact = (() => {
    const raw = process.env.BERNARD_REACT_MODE;
    if (raw === undefined) return undefined;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return undefined;
  })();
  const coordinatorMode: 'on' | 'off' | 'auto' =
    prefs.coordinatorMode ??
    envCoordinator ??
    legacyReactModeToCoordinator(envLegacyReact) ??
    DEFAULT_COORDINATOR_MODE;

  // Multi-model assignment mode (#170). Precedence: pref > env > default.
  const envModelMode = isModelMode(process.env.BERNARD_MODEL_MODE)
    ? (process.env.BERNARD_MODEL_MODE as
        | 'off'
        | 'optimize-tokens'
        | 'balanced'
        | 'optimize-performance')
    : undefined;
  const modelMode = prefs.modelMode ?? envModelMode ?? DEFAULT_MODEL_MODE;

  // Sub-agent PAC pipeline runs by default; users can opt out with BERNARD_SUBAGENT_PAC=false.
  const rawSubagentPac = process.env.BERNARD_SUBAGENT_PAC;
  const subagentPac =
    prefs.subagentPac ??
    (rawSubagentPac === undefined ? true : !(rawSubagentPac === 'false' || rawSubagentPac === '0'));

  const toolDetails =
    prefs.toolDetails ??
    (process.env.BERNARD_TOOL_DETAILS === 'true' || process.env.BERNARD_TOOL_DETAILS === '1');

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

  // Correction agent runs by default; users can opt out with BERNARD_CORRECTION_ENABLED=false.
  const rawCorrection = process.env.BERNARD_CORRECTION_ENABLED;
  const correctionEnabled =
    rawCorrection === undefined ? true : !(rawCorrection === 'false' || rawCorrection === '0');

  // Prompt rewriter runs by default; users can opt out with BERNARD_PROMPT_REWRITER=false.
  const rawRewriter = process.env.BERNARD_PROMPT_REWRITER;
  const promptRewriter =
    prefs.promptRewriter ??
    (rawRewriter === undefined ? true : !(rawRewriter === 'false' || rawRewriter === '0'));

  // Risk-based confirmation mode (#144). Precedence: pref > env > default 'auto'.
  const envConfirmMode = isConfirmMode(process.env.BERNARD_CONFIRM_MODE)
    ? (process.env.BERNARD_CONFIRM_MODE as 'off' | 'auto' | 'strict')
    : undefined;
  const confirmMode = prefs.confirmMode ?? envConfirmMode ?? DEFAULT_CONFIRM_MODE;

  // Least-privilege tool mode (#179). Precedence: pref > env > default 'read-only'.
  const envToolMode = isToolMode(process.env.BERNARD_TOOL_MODE)
    ? (process.env.BERNARD_TOOL_MODE as 'read-only' | 'write')
    : undefined;
  const toolMode = prefs.toolMode ?? envToolMode ?? DEFAULT_TOOL_MODE;

  // Configurable parallel sub-agent concurrency (#133). Precedence: pref > env > default.
  // Out-of-range values clamp to [1, MAX_CONCURRENT_AGENTS_LIMIT]. Env values must be a
  // pure integer string ("12abc" / "3.7" / "" fall through to the default).
  const envMaxConcurrentRaw = (process.env.BERNARD_MAX_CONCURRENT_AGENTS ?? '').trim();
  const envMaxConcurrentParsed = Number.parseInt(envMaxConcurrentRaw, 10);
  const envMaxConcurrent =
    envMaxConcurrentRaw !== '' &&
    Number.isFinite(envMaxConcurrentParsed) &&
    String(envMaxConcurrentParsed) === envMaxConcurrentRaw
      ? envMaxConcurrentParsed
      : undefined;
  const rawMaxConcurrent =
    prefs.maxConcurrentAgents ?? envMaxConcurrent ?? DEFAULT_MAX_CONCURRENT_AGENTS;
  const maxConcurrentAgents = normalizeMaxConcurrentAgents(rawMaxConcurrent);

  // Response-style picker (#133). Precedence: pref > env > 'default'.
  const envResponseStyle = isResponseStyle(process.env.BERNARD_RESPONSE_STYLE)
    ? process.env.BERNARD_RESPONSE_STYLE
    : undefined;
  const responseStyle = prefs.responseStyle ?? envResponseStyle ?? DEFAULT_RESPONSE_STYLE;

  // Concise-by-default response shaping (#175); opt-out via BERNARD_CONCISE_MODE=false.
  const rawConcise = process.env.BERNARD_CONCISE_MODE;
  const conciseMode =
    prefs.conciseMode ??
    (rawConcise === undefined
      ? DEFAULT_CONCISE_MODE
      : !(rawConcise === 'false' || rawConcise === '0'));

  // Reference tool-lookup runs by default; users can opt out with BERNARD_REFERENCE_LOOKUP=false.
  const rawReferenceLookup = process.env.BERNARD_REFERENCE_LOOKUP;
  const referenceLookup =
    prefs.referenceLookup ??
    (rawReferenceLookup === undefined
      ? true
      : !(rawReferenceLookup === 'false' || rawReferenceLookup === '0'));

  const referenceLookupTools = (process.env.BERNARD_LOOKUP_TOOLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Unlike `autoCreateThreshold` we don't rescale: `scratchSubjectThreshold`
  // is documented as a 0-1 Jaccard score and the REPL prompt enforces the
  // same range, so silently treating 15 → 0.15 would mask misconfiguration.
  // Out-of-range or non-finite inputs fall back to the default.
  const envScratchSubjectThreshold = parseFloat(
    process.env.BERNARD_SCRATCH_SUBJECT_THRESHOLD ?? '',
  );
  const rawScratchSubjectThreshold =
    prefs.scratchSubjectThreshold ??
    (Number.isFinite(envScratchSubjectThreshold)
      ? envScratchSubjectThreshold
      : DEFAULT_SCRATCH_SUBJECT_THRESHOLD);
  const scratchSubjectThreshold =
    Number.isFinite(rawScratchSubjectThreshold) &&
    rawScratchSubjectThreshold >= 0 &&
    rawScratchSubjectThreshold <= 1
      ? rawScratchSubjectThreshold
      : DEFAULT_SCRATCH_SUBJECT_THRESHOLD;

  const providerBaseUrl = resolveProviderBaseUrl(
    overrides?.providerBaseUrl,
    overrides?.allowProviderBaseUrl,
    provider,
    customProviders,
  );

  const config: BernardConfig = {
    provider,
    model,
    maxTokens,
    shellTimeout,
    tokenWindow,
    maxSteps,
    ragEnabled,
    cacheEnabled,
    theme,
    coordinatorMode,
    modelMode,
    subagentPac,
    toolDetails,
    autoCreateSpecialists,
    autoCreateThreshold,
    correctionEnabled,
    promptRewriter,
    confirmMode,
    toolMode,
    maxConcurrentAgents,
    responseStyle,
    referenceLookup,
    referenceLookupTools,
    scratchSubjectThreshold,
    conciseMode,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    xaiApiKey: process.env.XAI_API_KEY,
    apiKeys: { ...storedKeys },
    customProviders,
    providerBaseUrl,
  };

  validateConfig(config);
  // Apply the resolved concurrency cap to the shared agent pool (#133). Done
  // here so the very first sub-agent / task / specialist call respects user
  // intent — the REPL and CLI also call setMaxConcurrentAgents on subsequent
  // changes.
  setMaxConcurrentAgents(config.maxConcurrentAgents);
  return config;
}

/**
 * Validates and resolves the provider base URL override.
 *
 * Returns the URL string when the override is active and valid, or `undefined`
 * when no override is in play. Throws on misuse so the user sees the error at
 * startup rather than encountering a surprise routing change mid-session.
 */
function resolveProviderBaseUrl(
  url: string | undefined,
  allow: boolean | undefined,
  provider: string,
  customProviders: Record<string, CustomProvider>,
): string | undefined {
  if (url === undefined) return undefined;
  if (!allow) {
    throw new Error(
      '--provider-base-url requires the explicit opt-in flag --allow-provider-base-url. ' +
        'This guard exists so a stray flag cannot silently re-route your provider traffic.',
    );
  }
  const trimmed = url.trim();
  const err = validateBaseURL(trimmed);
  if (err) throw new Error(`--provider-base-url: ${err}`);
  if (Object.hasOwn(customProviders, provider)) {
    throw new Error(
      `--provider-base-url cannot be combined with custom provider "${provider}" — ` +
        `that provider already defines its own base URL. Either pick a built-in provider ` +
        `(anthropic, openai, xai) or edit the custom provider with \`bernard add-provider\`.`,
    );
  }
  return trimmed;
}

/**
 * Settings fields that profile-switching is allowed to overwrite on the live
 * `BernardConfig`. Anything outside this list (API keys, custom providers,
 * env-only toggles, CLI-scoped fields) is preserved across a switch.
 */
const PROFILE_SCOPED_KEYS: ReadonlyArray<keyof BernardConfig> = [
  'provider',
  'model',
  'maxTokens',
  'shellTimeout',
  'tokenWindow',
  'maxSteps',
  'theme',
  'coordinatorMode',
  'modelMode',
  'subagentPac',
  'toolDetails',
  'autoCreateSpecialists',
  'autoCreateThreshold',
  'promptRewriter',
  'confirmMode',
  'toolMode',
  'maxConcurrentAgents',
  'responseStyle',
  'referenceLookup',
  'scratchSubjectThreshold',
  'conciseMode',
];

/**
 * Overlays the active profile's settings onto an existing live `BernardConfig`
 * by re-running `loadConfig()` (which now reads the active profile) and
 * copying only the profile-scoped fields back into `config`. Mutates in place
 * so downstream subsystems holding a reference to `config` see the new values.
 *
 * Does not touch API keys, custom providers, the cached `providerBaseUrl`, or
 * env-only flags (`ragEnabled`, `cacheEnabled`, `correctionEnabled`,
 * `referenceLookupTools`) — those are not profile-scoped.
 *
 * @throws if the new profile selects a provider with no configured API key.
 */
export function applyProfileToConfig(config: BernardConfig): BernardConfig {
  const refreshed = loadConfig();
  const target = config as unknown as Record<string, unknown>;
  const source = refreshed as unknown as Record<string, unknown>;
  for (const key of PROFILE_SCOPED_KEYS) {
    target[key as string] = source[key as string];
  }
  // setMaxConcurrentAgents is already called inside loadConfig() above, so the
  // shared agent pool reflects the new profile's limit immediately.
  return config;
}

function validateConfig(config: BernardConfig): void {
  const key = getProviderApiKey(config, config.provider);
  if (!key) {
    const envVar = providerEnvVar(config.provider);
    const isCustom = Object.hasOwn(config.customProviders ?? {}, config.provider);
    const hint = isCustom
      ? `Run: bernard add-key ${config.provider} <your-api-key>`
      : `Run: bernard add-key ${config.provider} <your-api-key>\nOr set ${envVar} in your .env file or environment.`;
    throw new Error(`No API key found for provider "${config.provider}". ${hint}`);
  }
}
