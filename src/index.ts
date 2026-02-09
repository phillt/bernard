#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './config.js';
import { startRepl } from './repl.js';
import { printWelcome, printError } from './output.js';

const program = new Command();

program
  .name('bernard')
  .description('Local CLI AI agent with multi-provider support')
  .version('0.1.0')
  .option('-p, --provider <provider>', 'LLM provider (anthropic, openai, xai)')
  .option('-m, --model <model>', 'Model name')
  .action(async (opts) => {
    try {
      const config = loadConfig({
        provider: opts.provider,
        model: opts.model,
      });

      printWelcome(config.provider, config.model);
      await startRepl(config);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program.parse();
