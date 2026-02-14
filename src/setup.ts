import * as readline from 'node:readline';
import {
  getProviderKeyStatus,
  saveProviderKey,
  savePreferences,
  PROVIDER_ENV_VARS,
  getDefaultModel,
} from './config.js';
import { getTheme } from './theme.js';

const PROVIDERS = Object.keys(PROVIDER_ENV_VARS);

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

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
    const t = getTheme();
    console.log(t.accentBold('\n  Welcome to Bernard'));
    console.log(t.muted('  Local CLI AI Agent with multi-provider support\n'));
    console.log(t.text('  It looks like this is your first time running Bernard.'));
    console.log(t.text('  Let\'s get you set up with an AI provider.\n'));

    console.log(t.text('  Available providers:'));
    for (let i = 0; i < PROVIDERS.length; i++) {
      console.log(t.text(`    ${i + 1}. ${PROVIDERS[i]}`));
    }
    console.log();

    let provider: string | undefined;
    while (!provider) {
      const answer = await ask(rl, `  Select provider [1-${PROVIDERS.length}]: `);
      const num = parseInt(answer, 10);
      if (num >= 1 && num <= PROVIDERS.length) {
        provider = PROVIDERS[num - 1];
      } else {
        console.log(t.error(`  Please enter a number between 1 and ${PROVIDERS.length}.`));
      }
    }

    const envVar = PROVIDER_ENV_VARS[provider];
    console.log(t.muted(`\n  You'll need an API key for ${provider}.`));
    console.log(t.muted('  (This will be saved securely to ~/.bernard/keys.json)\n'));

    let key: string | undefined;
    while (!key) {
      const answer = await ask(rl, `  ${envVar}: `);
      if (answer.length > 0) {
        key = answer;
      } else {
        console.log(t.error('  API key cannot be empty.'));
      }
    }

    saveProviderKey(provider, key);
    const model = getDefaultModel(provider);
    savePreferences({ provider, model });

    console.log(t.success('\n  Setup complete!'));
    console.log(t.muted(`  Provider: ${provider} | Model: ${model}`));
    console.log(t.muted('  You can change these later with /provider and /model\n'));

    return true;
  } finally {
    rl.close();
  }
}
