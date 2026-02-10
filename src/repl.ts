import * as readline from 'node:readline';
import { Agent } from './agent.js';
import { MemoryStore } from './memory.js';
import { MCPManager } from './mcp.js';
import { printHelp, printInfo, printError, startSpinner, stopSpinner } from './output.js';
import type { ToolOptions } from './tools/index.js';
import { PROVIDER_MODELS, getAvailableProviders, getDefaultModel, savePreferences, OPTIONS_REGISTRY, saveOption, type BernardConfig } from './config.js';
import { CronStore } from './cron/store.js';
import { isDaemonRunning } from './cron/client.js';

export async function startRepl(config: BernardConfig, alertContext?: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Bracket paste mode: track whether we're inside a terminal paste
  let isPasting = false;
  const PROMPT_STR = '\x1b[36mbernard>\x1b[0m ';

  if (process.stdin.isTTY) {
    process.stdout.write('\x1b[?2004h'); // enable bracket paste mode
  }

  process.stdin.on('keypress', (_str: string, key: any) => {
    if (!key) return;
    if (key.name === 'paste-start') {
      isPasting = true;
      rl.setPrompt(''); // suppress prompt on continuation lines
    }
    if (key.name === 'paste-end') {
      isPasting = false;
      rl.setPrompt(PROMPT_STR); // restore prompt
    }
  });

  /** Read a single input (possibly multi-line via paste) from the REPL. */
  function readInput(): Promise<string> {
    return new Promise((resolve) => {
      const pasteLines: string[] = [];

      const onLine = (line: string) => {
        if (isPasting) {
          pasteLines.push(line);
        } else if (pasteLines.length > 0) {
          // Paste ended; this Enter press finalises the input
          pasteLines.push(line);
          rl.removeListener('line', onLine);
          resolve(pasteLines.join('\n'));
        } else {
          // Normal single-line input
          rl.removeListener('line', onLine);
          resolve(line);
        }
      };

      rl.setPrompt(PROMPT_STR);
      rl.prompt();
      rl.on('line', onLine);
    });
  }

  const memoryStore = new MemoryStore();
  const mcpManager = new MCPManager();

  try {
    await mcpManager.connect();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`MCP initialization failed: ${message}`);
  }

  const statuses = mcpManager.getServerStatuses();
  if (statuses.length > 0) {
    printInfo('  MCP servers:');
    for (const s of statuses) {
      if (s.connected) {
        printInfo(`    ✓ ${s.name} (${s.toolCount} tools)`);
      } else {
        printError(`    ✗ ${s.name}: ${s.error}`);
      }
    }
  }

  const mcpTools = mcpManager.getTools();
  const mcpServerNames = mcpManager.getConnectedServerNames();

  const confirmFn = (command: string): Promise<boolean> => {
    return new Promise((resolve) => {
      rl.question(`\x1b[33m  ⚠ Dangerous command: ${command}\n  Allow? (y/N): \x1b[0m`, (answer) => {
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
  };

  const toolOptions: ToolOptions = {
    shellTimeout: config.shellTimeout,
    confirmDangerous: confirmFn,
  };

  const agent = new Agent(config, toolOptions, memoryStore, mcpTools, mcpServerNames, alertContext);

  const cleanup = async () => {
    if (process.stdin.isTTY) {
      process.stdout.write('\x1b[?2004l'); // disable bracket paste mode
    }
    await mcpManager.close();
  };

  const prompt = async () => {
    const input = await readInput();
    const trimmed = input.trim();

    if (!trimmed) {
      prompt();
      return;
    }

    if (trimmed === 'exit' || trimmed === 'quit' || trimmed === '/exit') {
      printInfo('Goodbye!');
      await cleanup();
      rl.close();
      process.exit(0);
    }

    if (trimmed === '/help') {
      printHelp();
      prompt();
      return;
    }

    if (trimmed === '/clear') {
      agent.clearHistory();
      printInfo('Conversation history and scratch notes cleared.');
      prompt();
      return;
    }

    if (trimmed === '/memory') {
      const keys = memoryStore.listMemory();
      if (keys.length === 0) {
        printInfo('No persistent memories stored.');
      } else {
        printInfo('Persistent memories:');
        for (const key of keys) {
          printInfo(`  - ${key}`);
        }
      }
      prompt();
      return;
    }

    if (trimmed === '/scratch') {
      const keys = memoryStore.listScratch();
      if (keys.length === 0) {
        printInfo('No scratch notes in this session.');
      } else {
        printInfo('Scratch notes:');
        for (const key of keys) {
          printInfo(`  - ${key}`);
        }
      }
      prompt();
      return;
    }

    if (trimmed === '/mcp') {
      const statuses = mcpManager.getServerStatuses();
      if (statuses.length === 0) {
        printInfo('No MCP servers configured. Add servers to ~/.bernard/mcp.json');
      } else {
        printInfo('MCP servers:');
        for (const s of statuses) {
          if (s.connected) {
            printInfo(`  ✓ ${s.name} (${s.toolCount} tools)`);
          } else {
            printInfo(`  ✗ ${s.name} — ${s.error}`);
          }
        }
        const toolNames = Object.keys(mcpManager.getTools());
        if (toolNames.length > 0) {
          printInfo(`\nMCP tools: ${toolNames.join(', ')}`);
        }
      }
      prompt();
      return;
    }

    if (trimmed === '/cron') {
      const store = new CronStore();
      const jobs = store.loadJobs();
      const running = isDaemonRunning();

      printInfo(`\n  Daemon: ${running ? 'running' : 'stopped'}`);
      if (jobs.length === 0) {
        printInfo('  No cron jobs configured.\n');
      } else {
        printInfo(`  Jobs (${jobs.length}):`);
        for (const job of jobs) {
          const status = job.enabled ? 'enabled' : 'disabled';
          const lastRun = job.lastRun
            ? `last: ${new Date(job.lastRun).toLocaleString()} (${job.lastRunStatus || 'unknown'})`
            : 'never run';
          printInfo(`    ${job.name} [${status}] — ${job.schedule} — ${lastRun}`);
          printInfo(`      ID: ${job.id}`);
        }

        const alerts = store.listAlerts().filter(a => !a.acknowledged);
        if (alerts.length > 0) {
          printInfo(`\n  Unacknowledged alerts (${alerts.length}):`);
          for (const alert of alerts.slice(0, 5)) {
            printInfo(`    [${new Date(alert.timestamp).toLocaleString()}] ${alert.jobName}: ${alert.message}`);
          }
        }
        console.log();
      }
      prompt();
      return;
    }

    if (trimmed === '/provider') {
      const available = getAvailableProviders(config);
      if (available.length === 0) {
        printError('No providers have API keys configured.');
        prompt();
        return;
      }
      printInfo(`\n  Current: ${config.provider} (${config.model})\n`);
      printInfo('  Available providers:');
      for (let i = 0; i < available.length; i++) {
        printInfo(`    ${i + 1}. ${available[i]}`);
      }
      console.log();
      rl.question(`  Select [1-${available.length}]: `, (answer) => {
        const num = parseInt(answer.trim(), 10);
        if (num >= 1 && num <= available.length) {
          config.provider = available[num - 1];
          config.model = getDefaultModel(config.provider);
          savePreferences({ provider: config.provider, model: config.model, maxTokens: config.maxTokens, shellTimeout: config.shellTimeout });
          printInfo(`  Switched to ${config.provider} (${config.model})`);
        } else {
          printInfo('  Cancelled.');
        }
        console.log();
        prompt();
      });
      return;
    }

    if (trimmed === '/model') {
      const models = PROVIDER_MODELS[config.provider];
      if (!models || models.length === 0) {
        printError(`No models listed for provider "${config.provider}".`);
        prompt();
        return;
      }
      printInfo(`\n  Current: ${config.provider} / ${config.model}\n`);
      printInfo('  Available models:');
      for (let i = 0; i < models.length; i++) {
        printInfo(`    ${i + 1}. ${models[i]}`);
      }
      console.log();
      rl.question(`  Select [1-${models.length}]: `, (answer) => {
        const num = parseInt(answer.trim(), 10);
        if (num >= 1 && num <= models.length) {
          config.model = models[num - 1];
          savePreferences({ provider: config.provider, model: config.model, maxTokens: config.maxTokens, shellTimeout: config.shellTimeout });
          printInfo(`  Switched to ${config.model}`);
        } else {
          printInfo('  Cancelled.');
        }
        console.log();
        prompt();
      });
      return;
    }

    if (trimmed === '/options') {
      const entries = Object.entries(OPTIONS_REGISTRY);
      printInfo('\n  Options:');
      for (let i = 0; i < entries.length; i++) {
        const [name, opt] = entries[i];
        const current = config[opt.configKey];
        const isDefault = current === opt.default;
        const label = isDefault ? '(default)' : '(custom)';
        printInfo(`    ${i + 1}. ${name} = ${current} ${label}`);
        printInfo(`       ${opt.description}`);
      }
      console.log();
      rl.question(`  Select option [1-${entries.length}] (Enter to cancel): `, (answer) => {
        const num = parseInt(answer.trim(), 10);
        if (num >= 1 && num <= entries.length) {
          const [name, opt] = entries[num - 1];
          rl.question(`  New value for ${name} (Enter to cancel): `, (valAnswer) => {
            const val = parseInt(valAnswer.trim(), 10);
            if (val > 0) {
              saveOption(name, val);
              config[opt.configKey] = val;
              printInfo(`  ${name} set to ${val}`);
            } else if (valAnswer.trim() === '') {
              printInfo('  Cancelled.');
            } else {
              printError('  Invalid value. Must be a positive integer.');
            }
            console.log();
            prompt();
          });
        } else {
          printInfo('  Cancelled.');
          console.log();
          prompt();
        }
      });
      return;
    }

    try {
      startSpinner();
      await agent.processInput(trimmed);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
    } finally {
      stopSpinner();
    }

    console.log(); // blank line between turns
    prompt();
  };

  // Handle Ctrl+C gracefully
  rl.on('close', async () => {
    printInfo('\nGoodbye!');
    await cleanup();
    process.exit(0);
  });

  prompt();
}
