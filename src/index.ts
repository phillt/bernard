#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './config.js';
import { startRepl } from './repl.js';
import { printWelcome, printError, printInfo } from './output.js';
import { CronStore } from './cron/store.js';

const program = new Command();

program
  .name('bernard')
  .description('Local CLI AI agent with multi-provider support')
  .version('0.1.0')
  .option('-p, --provider <provider>', 'LLM provider (anthropic, openai, xai)')
  .option('-m, --model <model>', 'Model name')
  .option('--alert <id>', 'Open with cron alert context')
  .action(async (opts) => {
    try {
      const config = loadConfig({
        provider: opts.provider,
        model: opts.model,
      });

      let alertContext: string | undefined;

      if (opts.alert) {
        const store = new CronStore();
        const alert = store.getAlert(opts.alert);
        if (!alert) {
          printError(`Alert "${opts.alert}" not found.`);
          process.exit(1);
        }
        store.acknowledgeAlert(alert.id);
        alertContext = `## Cron Alert

This session was opened in response to a cron job alert.

**Job:** ${alert.jobName}
**Alert Time:** ${alert.timestamp}
**Alert Message:** ${alert.message}
**Original Job Prompt:** ${alert.prompt}
**AI Response:** ${alert.response}

The user has been notified and this session is open for them to review and act on this alert. Help the user understand and address the issue described above.`;

        printInfo(`\n  Alert from cron job: ${alert.jobName}`);
        printInfo(`  Message: ${alert.message}`);
        printInfo(`  Time: ${alert.timestamp}\n`);
      }

      printWelcome(config.provider, config.model);
      await startRepl(config, alertContext);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program.parse();
