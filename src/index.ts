#!/usr/bin/env node

import { Command } from 'commander';
import * as readline from 'node:readline';
import {
  loadConfig,
  loadPreferences,
  savePreferences,
  saveProviderKey,
  removeProviderKey,
  getProviderKeyStatus,
  PROVIDER_ENV_VARS,
  OPTIONS_REGISTRY,
  resetOption,
  resetAllOptions,
  getDefaultModel,
} from './config.js';
import { startRepl } from './repl.js';
import { printWelcome, printError, printInfo } from './output.js';
import { setTheme, DEFAULT_THEME } from './theme.js';
import { CronStore } from './cron/store.js';
import { cronList, cronRun, cronDelete, cronDeleteAll, cronStop, cronBounce } from './cron/cli.js';
import { listMCPServers, removeMCPServer } from './mcp.js';
import { runFirstTimeSetup } from './setup.js';
import { getLocalVersion, startupUpdateCheck, interactiveUpdate } from './update.js';
import { factsList, factsSearch } from './facts-cli.js';

const program = new Command();

program
  .name('bernard')
  .description('Local CLI AI agent with multi-provider support')
  .version(getLocalVersion())
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

      if (!setTheme(config.theme)) {
        config.theme = DEFAULT_THEME;
        setTheme(config.theme);
      }

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

      printWelcome(config.provider, config.model, getLocalVersion());
      const prefs = loadPreferences();
      startupUpdateCheck(!!prefs.autoUpdate);
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
        printError(
          `Unknown option "${option}". Valid options: ${Object.keys(OPTIONS_REGISTRY).join(', ')}`,
        );
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

program
  .command('cron-list')
  .description('List all cron jobs with status')
  .action(async () => {
    try {
      await cronList();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('cron-run <id>')
  .description('Manually run a cron job immediately')
  .action(async (id: string) => {
    try {
      await cronRun(id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('cron-delete <ids...>')
  .description('Delete specific cron jobs by ID')
  .action(async (ids: string[]) => {
    try {
      await cronDelete(ids);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('cron-delete-all')
  .description('Delete all cron jobs')
  .action(async () => {
    try {
      await cronDeleteAll();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('cron-stop [ids...]')
  .description('Stop the daemon (no args) or disable specific jobs')
  .action(async (ids: string[]) => {
    try {
      await cronStop(ids.length > 0 ? ids : undefined);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('cron-bounce [ids...]')
  .description('Restart the daemon (no args) or bounce specific jobs')
  .action(async (ids: string[]) => {
    try {
      await cronBounce(ids.length > 0 ? ids : undefined);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('update')
  .description('Check for and install updates')
  .action(async () => {
    try {
      await interactiveUpdate();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('auto-update <state>')
  .description('Enable or disable automatic updates (on/off)')
  .action((state: string) => {
    const lower = state.toLowerCase();
    if (lower !== 'on' && lower !== 'off') {
      printError('Usage: bernard auto-update <on|off>');
      process.exit(1);
    }
    const enabled = lower === 'on';
    const prefs = loadPreferences();
    savePreferences({
      provider: prefs.provider || 'anthropic',
      model: prefs.model || getDefaultModel(prefs.provider || 'anthropic'),
      maxTokens: prefs.maxTokens,
      shellTimeout: prefs.shellTimeout,
      theme: prefs.theme,
      autoUpdate: enabled,
    });
    printInfo(`Auto-update ${enabled ? 'enabled' : 'disabled'}.`);
  });

program
  .command('facts [query]')
  .description('Browse and manage RAG facts')
  .action(async (query?: string) => {
    try {
      if (query) {
        await factsSearch(query);
      } else {
        await factsList();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program.parse();
