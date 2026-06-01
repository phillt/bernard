import * as readline from 'node:readline';
import {
  getProviderKeyStatus,
  saveProviderKey,
  savePreferences,
  loadPreferences,
  PROVIDER_ENV_VARS,
  getDefaultModel,
} from './config.js';
import { KEYS_PATH } from './paths.js';

const PROVIDERS = Object.keys(PROVIDER_ENV_VARS);

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

/**
 * Run the interactive first-time setup wizard if no API keys are configured.
 * Prompts the user to select a provider and enter an API key, then persists both.
 * @returns `true` if setup ran (keys were missing), `false` if skipped (keys already present).
 */
export async function runFirstTimeSetup(): Promise<boolean> {
  const statuses = getProviderKeyStatus();
  if (statuses.some((s) => s.hasKey)) {
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('\n  Welcome to Bernard');
    console.log('  Local CLI AI Agent with multi-provider support\n');
    console.log('  It looks like this is your first time running Bernard.');
    console.log("  Let's get you set up with an AI provider.\n");

    console.log('  Available providers:');
    for (let i = 0; i < PROVIDERS.length; i++) {
      console.log(`    ${i + 1}. ${PROVIDERS[i]}`);
    }
    console.log();

    let provider: string | undefined;
    while (!provider) {
      const answer = await ask(rl, `  Select provider [1-${PROVIDERS.length}]: `);
      const num = parseInt(answer, 10);
      if (num >= 1 && num <= PROVIDERS.length) {
        provider = PROVIDERS[num - 1];
      } else {
        console.log(`  Please enter a number between 1 and ${PROVIDERS.length}.`);
      }
    }

    const envVar = PROVIDER_ENV_VARS[provider];
    console.log(`\n  You'll need an API key for ${provider}.`);
    console.log(`  (This will be saved securely to ${KEYS_PATH})\n`);

    let key: string | undefined;
    while (!key) {
      const answer = await ask(rl, `  ${envVar}: `);
      if (answer.length > 0) {
        key = answer;
      } else {
        console.log('  API key cannot be empty.');
      }
    }

    saveProviderKey(provider, key);
    const model = getDefaultModel(provider);
    const existingPrefs = loadPreferences();
    savePreferences({ provider, model, theme: existingPrefs.theme });

    console.log('\n  Setup complete!');
    console.log(`  Provider: ${provider} | Model: ${model}`);
    console.log('  You can change these later with /provider and /model');
    console.log(
      '  Tip: running a local LLM? Use `bernard add-provider` to point at it (Ollama, LM Studio, OpenRouter, etc.)\n',
    );

    return true;
  } finally {
    rl.close();
  }
}
