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
const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-5-20250929',
  openai: 'gpt-4o',
  xai: 'grok-3',
};
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_SHELL_TIMEOUT = 30000;

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
  const model = overrides?.model || process.env.BERNARD_MODEL || DEFAULT_MODEL[provider] || DEFAULT_MODEL[DEFAULT_PROVIDER];
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
