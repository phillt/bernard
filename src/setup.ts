import * as readline from 'node:readline';
import chalk from 'chalk';
import {
  getProviderKeyStatus,
  saveProviderKey,
  savePreferences,
  PROVIDER_ENV_VARS,
  getDefaultModel,
} from './config.js';

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
    console.log(chalk.bold.cyan('\n  Welcome to Bernard'));
    console.log(chalk.gray('  Local CLI AI Agent with multi-provider support\n'));
    console.log(chalk.white('  It looks like this is your first time running Bernard.'));
    console.log(chalk.white('  Let\'s get you set up with an AI provider.\n'));

    console.log(chalk.white('  Available providers:'));
    for (let i = 0; i < PROVIDERS.length; i++) {
      console.log(chalk.white(`    ${i + 1}. ${PROVIDERS[i]}`));
    }
    console.log();

    let provider: string | undefined;
    while (!provider) {
      const answer = await ask(rl, `  Select provider [1-${PROVIDERS.length}]: `);
      const num = parseInt(answer, 10);
      if (num >= 1 && num <= PROVIDERS.length) {
        provider = PROVIDERS[num - 1];
      } else {
        console.log(chalk.red(`  Please enter a number between 1 and ${PROVIDERS.length}.`));
      }
    }

    const envVar = PROVIDER_ENV_VARS[provider];
    console.log(chalk.gray(`\n  You'll need an API key for ${provider}.`));
    console.log(chalk.gray('  (This will be saved securely to ~/.bernard/keys.json)\n'));

    let key: string | undefined;
    while (!key) {
      const answer = await ask(rl, `  ${envVar}: `);
      if (answer.length > 0) {
        key = answer;
      } else {
        console.log(chalk.red('  API key cannot be empty.'));
      }
    }

    saveProviderKey(provider, key);
    const model = getDefaultModel(provider);
    savePreferences({ provider, model });

    console.log(chalk.green('\n  Setup complete!'));
    console.log(chalk.gray(`  Provider: ${provider} | Model: ${model}`));
    console.log(chalk.gray('  You can change these later with /provider and /model\n'));

    return true;
  } finally {
    rl.close();
  }
}
