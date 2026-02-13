#!/usr/bin/env node

import { Command } from 'commander';
import * as readline from 'node:readline';
import { loadConfig, saveProviderKey, removeProviderKey, getProviderKeyStatus, PROVIDER_ENV_VARS, OPTIONS_REGISTRY, resetOption, resetAllOptions } from './config.js';
import { startRepl } from './repl.js';
import { printWelcome, printError, printInfo } from './output.js';
import { CronStore } from './cron/store.js';
import { listMCPServers, removeMCPServer } from './mcp.js';
import { runFirstTimeSetup } from './setup.js';

const program = new Command();

program
  .name('bernard')
  .description('Local CLI AI agent with multi-provider support')
  .version('0.1.0')
  .option('-p, --provider <provider>', 'LLM provider (anthropic, openai, xai)')
  .option('-m, --model <model>', 'Model name')
  .option('-r, --resume', 'Resume the previous conversation')
  .option('--alert <id>', 'Open with cron alert context')
  .action(async (opts) => {
    try {
      await runFirstTimeSetup();

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
      await startRepl(config, alertContext, !!opts.resume);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('add-key <provider> <key>')
  .description('Store an API key for a provider')
  .action((provider: string, key: string) => {
    try {
      saveProviderKey(provider, key);
      printInfo(`API key for "${provider}" saved successfully.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('remove-key <provider>')
  .description('Remove a stored API key for a provider')
  .action((provider: string) => {
    try {
      removeProviderKey(provider);
      printInfo(`API key for "${provider}" removed.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('providers')
  .description('List supported providers and their API key status')
  .action(() => {
    const statuses = getProviderKeyStatus();
    printInfo('Providers:');
    for (const { provider, hasKey } of statuses) {
      const envVar = PROVIDER_ENV_VARS[provider];
      const status = hasKey ? '\u2713' : '\u2717';
      printInfo(`  ${status} ${provider} (${envVar})`);
    }
    if (statuses.some((s) => !s.hasKey)) {
      printInfo('\nTo add a key: bernard add-key <provider> <key>');
    }
  });

program
  .command('list-options')
  .description('List configurable options and their current values')
  .action(() => {
    try {
      const config = loadConfig();
      printInfo('Options:');
      for (const [name, opt] of Object.entries(OPTIONS_REGISTRY)) {
        const current = config[opt.configKey];
        const isDefault = current === opt.default;
        const label = isDefault ? '(default)' : '(custom)';
        printInfo(`  ${name} = ${current} ${label}`);
        printInfo(`    ${opt.description}`);
        printInfo(`    Env var: ${opt.envVar}`);
      }
      printInfo('\nTo set options from chat: start bernard and use /options');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('reset-option <option>')
  .description('Reset a single option to its default value')
  .action((option: string) => {
    try {
      if (!OPTIONS_REGISTRY[option]) {
        printError(`Unknown option "${option}". Valid options: ${Object.keys(OPTIONS_REGISTRY).join(', ')}`);
        process.exit(1);
      }
      resetOption(option);
      printInfo(`Option "${option}" reset to default (${OPTIONS_REGISTRY[option].default}).`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('reset-options')
  .description('Reset all options to their default values')
  .action(() => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    printInfo('This will reset all options to their default values.');
    rl.question('Are you sure? (y/N): ', (answer) => {
      if (answer.trim().toLowerCase() === 'y') {
        resetAllOptions();
        printInfo('All options reset to defaults:');
        for (const [name, opt] of Object.entries(OPTIONS_REGISTRY)) {
          printInfo(`  ${name} = ${opt.default}`);
        }
      } else {
        printInfo('Cancelled.');
      }
      rl.close();
    });
  });

program
  .command('mcp-list')
  .description('List configured MCP servers')
  .action(() => {
    try {
      const servers = listMCPServers();
      if (servers.length === 0) {
        printInfo('No MCP servers configured.');
        printInfo('Add servers to ~/.bernard/mcp.json');
        return;
      }
      printInfo('MCP Servers:');
      for (const server of servers) {
        if (server.url) {
          const type = server.type ?? 'sse';
          printInfo(`  ${server.key} — ${server.url} (${type})`);
        } else {
          const args = server.args && server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
          printInfo(`  ${server.key} — ${server.command}${args}`);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('remove-mcp <key>')
  .description('Remove a configured MCP server')
  .action((key: string) => {
    try {
      removeMCPServer(key);
      printInfo(`MCP server "${key}" removed.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program.parse();
