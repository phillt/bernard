import * as dotenv from 'dotenv';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

export interface BernardConfig {
  provider: string;
  model: string;
  maxTokens: number;
  shellTimeout: number;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  xaiApiKey?: string;
}

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_SHELL_TIMEOUT = 30000;

export const PROVIDER_MODELS: Record<string, string[]> = {
  anthropic: [
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-20250514',
    'claude-sonnet-4-20250514',
    'claude-3-5-haiku-latest',
  ],
  openai: [
    'gpt-4o',
    'gpt-4o-mini',
    'o3',
    'o3-mini',
    'o4-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
  ],
  xai: [
    'grok-3',
    'grok-3-fast',
    'grok-3-mini',
    'grok-3-mini-fast',
  ],
};

export function getDefaultModel(provider: string): string {
  return PROVIDER_MODELS[provider]?.[0] ?? PROVIDER_MODELS[DEFAULT_PROVIDER][0];
}

export function getAvailableProviders(config: BernardConfig): string[] {
  const keyMap: Record<string, string | undefined> = {
    anthropic: config.anthropicApiKey,
    openai: config.openaiApiKey,
    xai: config.xaiApiKey,
  };
  return Object.keys(PROVIDER_MODELS).filter((p) => !!keyMap[p]);
}

export function loadConfig(overrides?: { provider?: string; model?: string }): BernardConfig {
  // Load .env from cwd first, then fallback to ~/.bernard/.env
  const cwdEnv = path.join(process.cwd(), '.env');
  const homeEnv = path.join(os.homedir(), '.bernard', '.env');

  if (fs.existsSync(cwdEnv)) {
    dotenv.config({ path: cwdEnv });
  } else if (fs.existsSync(homeEnv)) {
    dotenv.config({ path: homeEnv });
  }

  const provider = overrides?.provider || process.env.BERNARD_PROVIDER || DEFAULT_PROVIDER;
  const model = overrides?.model || process.env.BERNARD_MODEL || getDefaultModel(provider);
  const maxTokens = parseInt(process.env.BERNARD_MAX_TOKENS || '', 10) || DEFAULT_MAX_TOKENS;
  const shellTimeout = parseInt(process.env.BERNARD_SHELL_TIMEOUT || '', 10) || DEFAULT_SHELL_TIMEOUT;

  const config: BernardConfig = {
    provider,
    model,
    maxTokens,
    shellTimeout,
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
    const envVar = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      xai: 'XAI_API_KEY',
    }[config.provider];

    throw new Error(
      `No API key found for provider "${config.provider}". ` +
      `Set ${envVar} in your .env file or environment.`
    );
  }
}
