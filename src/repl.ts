import * as readline from 'node:readline';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { Agent } from './agent.js';
import { MemoryStore } from './memory.js';
import { RAGStore } from './rag.js';
import { MCPManager } from './mcp.js';
import { printHelp, printInfo, printError, printConversationReplay, startSpinner, stopSpinner, buildSpinnerMessage, type SpinnerStats } from './output.js';
import type { ToolOptions } from './tools';
import { PROVIDER_MODELS, getAvailableProviders, getDefaultModel, savePreferences, OPTIONS_REGISTRY, saveOption, type BernardConfig } from './config.js';
import { getTheme, setTheme, getThemeKeys, getActiveThemeKey, THEMES } from './theme.js';
import { interactiveUpdate } from './update.js';
import { CronStore } from './cron/store.js';
import { isDaemonRunning } from './cron/client.js';
import { HistoryStore } from './history.js';
import { serializeMessages } from './context.js';
import { getDomain, getDomainIds } from './domains.js';

export async function startRepl(config: BernardConfig, alertContext?: string, resume?: boolean): Promise<void> {
  const SLASH_COMMANDS = [
    { command: '/help',     description: 'Show this help' },
    { command: '/clear',    description: 'Clear conversation history and scratch notes' },
    { command: '/memory',   description: 'List persistent memories' },
    { command: '/scratch',  description: 'List session scratch notes' },
    { command: '/mcp',      description: 'List MCP servers and tools' },
    { command: '/cron',     description: 'Show cron jobs and daemon status' },
    { command: '/rag',      description: 'Show RAG memory stats and recent facts' },
    { command: '/provider', description: 'Switch LLM provider' },
    { command: '/model',    description: 'Switch model for current provider' },
    { command: '/theme',    description: 'Switch color theme' },
    { command: '/options',  description: 'View and set options (max-tokens, shell-timeout)' },
    { command: '/update',   description: 'Check for and install updates' },
    { command: '/exit',     description: 'Quit Bernard' },
  ];

  function completer(line: string): [string[], string] {
    if (line.startsWith('/')) {
      const hits = SLASH_COMMANDS.filter(c => c.command.startsWith(line)).map(c => c.command);
      return [hits.length ? hits : SLASH_COMMANDS.map(c => c.command), line];
    }
    return [[], line];
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer,
  });

  // Bracket paste mode: track whether we're inside a terminal paste
  let isPasting = false;
  function getPromptStr(): string {
    const { ansi } = getTheme();
    return `${ansi.prompt}bernard>${ansi.reset} `;
  }

  if (process.stdin.isTTY) {
    process.stdout.write('\x1b[?2004h'); // enable bracket paste mode
  }

  let hintLineCount = 0;

  function redrawWithHints(line: string): void {
    const matches = (!isPasting && line.startsWith('/'))
      ? SLASH_COMMANDS.filter(c => c.command.startsWith(line))
      : [];

    // Nothing to show and nothing to clean up — let readline handle display
    if (matches.length === 0 && hintLineCount === 0) return;

    // Move up past any old hint lines to the prompt line
    if (hintLineCount > 0) {
      process.stdout.write(`\x1b[${hintLineCount}A`);
    }
    // Clear from prompt line downward
    process.stdout.write(`\r\x1b[J`);

    if (matches.length > 0) {
      const maxLen = Math.max(...matches.map(c => c.command.length));
      const { ansi } = getTheme();
      for (const c of matches) {
        const pad = ' '.repeat(maxLen - c.command.length + 2);
        process.stdout.write(`  ${ansi.hintCmd}${c.command}${ansi.reset}${pad}${ansi.hintDesc}— ${c.description}${ansi.reset}\n`);
      }
      hintLineCount = matches.length;
    } else {
      hintLineCount = 0;
    }

    // Reprint prompt + current input
    process.stdout.write(getPromptStr() + line);
  }

  let processing = false;
  let interrupted = false;

  process.stdin.on('keypress', (_str: string, key: any) => {
    if (!key) return;

    if (key.name === 'escape' && processing) {
      agent.abort();
      interrupted = true;
      return;
    }

    if (key.name === 'paste-start') {
      isPasting = true;
      rl.setPrompt(''); // suppress prompt on continuation lines
    }
    if (key.name === 'paste-end') {
      isPasting = false;
      rl.setPrompt(getPromptStr()); // restore prompt
    }

    // On Enter, clear hints before readline processes the line
    if (key.name === 'return' && hintLineCount > 0) {
      // Move up past hints, clear everything, reprint prompt+line so
      // readline's own newline lands cleanly
      const line = (rl as any).line as string || '';
      process.stdout.write(`\x1b[${hintLineCount}A\r\x1b[J`);
      process.stdout.write(getPromptStr() + line);
      hintLineCount = 0;
      return;
    }

    // Show/update slash command hints on next tick (after readline updates rl.line)
    if (!isPasting && key.name !== 'paste-start' && key.name !== 'paste-end' && key.name !== 'return') {
      process.nextTick(() => {
        const line = (rl as any).line as string;
        if (line !== undefined) {
          redrawWithHints(line);
        }
      });
    }
  });

  /** Read a single input (possibly multi-line via paste) from the REPL. */
  function readInput(): Promise<{ text: string; pasted: boolean }> {
    return new Promise((resolve) => {
      const pasteLines: string[] = [];

      const onLine = (line: string) => {
        if (isPasting) {
          pasteLines.push(line);
        } else if (pasteLines.length > 0) {
          // Paste ended; this Enter press finalises the input
          pasteLines.push(line);
          rl.removeListener('line', onLine);
          resolve({ text: pasteLines.join('\n'), pasted: true });
        } else {
          // Normal single-line input
          rl.removeListener('line', onLine);
          resolve({ text: line, pasted: false });
        }
      };

      rl.setPrompt(getPromptStr());
      rl.prompt();
      rl.on('line', onLine);
    });
  }

  const memoryStore = new MemoryStore();
  const ragStore = config.ragEnabled ? new RAGStore() : undefined;
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
      const { ansi } = getTheme();
      rl.question(`${ansi.warning}  ⚠ Dangerous command: ${command}\n  Allow? (y/N): ${ansi.reset}`, (answer) => {
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
  };

  const toolOptions: ToolOptions = {
    shellTimeout: config.shellTimeout,
    confirmDangerous: confirmFn,
  };

  const historyStore = new HistoryStore();
  let initialHistory: import('ai').CoreMessage[] | undefined;
  if (resume) {
    const loaded = historyStore.load();
    if (loaded.length > 0) {
      // Filter out old session boundary markers to prevent accumulation
      const filtered = loaded.filter(
        (msg) =>
          !(typeof msg.content === 'string' &&
            (msg.content.startsWith('[Previous session ended') ||
             msg.content === "Understood. Starting a new session. I'll only reference prior context if relevant to your current request.")),
      );
      const boundary: import('ai').CoreMessage = {
        role: 'user',
        content: '[Previous session ended. New session starting. Treat tasks from prior session as completed unless the user explicitly continues them.]',
      };
      const boundaryAck: import('ai').CoreMessage = {
        role: 'assistant',
        content: 'Understood. Starting a new session. I\'ll only reference prior context if relevant to your current request.',
      };
      initialHistory = [...filtered, boundary, boundaryAck];
      printConversationReplay(loaded);
    } else {
      printInfo('No previous conversation found — starting fresh.');
    }
  }

  const agent = new Agent(config, toolOptions, memoryStore, mcpTools, mcpServerNames, alertContext, initialHistory, ragStore);

  const cleanup = async () => {
    if (process.stdin.isTTY) {
      process.stdout.write('\x1b[?2004l'); // disable bracket paste mode
    }

    // Spawn background RAG extraction worker if applicable
    try {
      const history = agent.getHistory();
      if (ragStore && history.length >= 4) {
        const serialized = serializeMessages(history);
        if (serialized.trim()) {
          const ragDir = path.join(os.homedir(), '.bernard', 'rag');
          fs.mkdirSync(ragDir, { recursive: true });
          const tempFile = path.join(ragDir, `.pending-${crypto.randomBytes(8).toString('hex')}.json`);
          fs.writeFileSync(tempFile, JSON.stringify({
            serialized,
            provider: config.provider,
            model: config.model,
          }));

          const workerPath = path.join(__dirname, 'rag-worker.js');
          const child = childProcess.spawn(process.execPath, [workerPath, tempFile], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
          });
          child.unref();
        }
      }
    } catch {
      // Silent failure — don't block exit
    }

    await mcpManager.close();
  };

  const prompt = async () => {
    const { text, pasted } = await readInput();
    let trimmed = text.trim();

    if (!trimmed) {
      prompt();
      return;
    }

    // Escaped forward slash: unescape and send to agent as regular text
    const isEscapedSlash = trimmed.startsWith('\\/');
    if (isEscapedSlash) {
      trimmed = trimmed.slice(1);
    }

    // Bare "/" was handled by live keypress hints; just re-prompt
    if (!pasted && !isEscapedSlash && trimmed === '/') {
      prompt();
      return;
    }

    if (trimmed === 'exit' || trimmed === 'quit' || trimmed === '/exit') {
      printInfo('Goodbye!');
      await cleanup();
      rl.close();
      process.exit(0);
    }

    // Slash commands are only handled for typed (non-pasted, non-escaped) input
    if (!pasted && !isEscapedSlash && trimmed.startsWith('/')) {

    if (trimmed === '/help') {
      printHelp();
      prompt();
      return;
    }

    if (trimmed === '/clear') {
      agent.clearHistory();
      historyStore.clear();
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

    if (trimmed === '/rag') {
      if (!ragStore) {
        printInfo('RAG is disabled. Set BERNARD_RAG_ENABLED=true (default) to enable.');
        prompt();
        return;
      }
      const count = ragStore.count();
      printInfo(`\n  RAG memories: ${count}`);
      if (count === 0) {
        printInfo('  No RAG memories yet. Memories are extracted automatically during context compression.');
      } else {
        // Show per-domain breakdown
        const counts = ragStore.countByDomain();
        const knownDomains = new Set(getDomainIds());
        printInfo('  By domain:');
        for (const domainId of knownDomains) {
          const domainCount = counts[domainId] ?? 0;
          if (domainCount > 0) {
            const domain = getDomain(domainId);
            printInfo(`    ${domain.name}: ${domainCount}`);
          }
        }
        // Show any domains not in registry (legacy)
        for (const [domainId, domainCount] of Object.entries(counts)) {
          if (!knownDomains.has(domainId)) {
            printInfo(`    ${domainId}: ${domainCount}`);
          }
        }

        const facts = ragStore.listFacts();
        const recent = facts.slice(-10);
        printInfo(`\n  Most recent (up to 10):`);
        for (const f of recent) {
          printInfo(`    ${f}`);
        }
      }
      console.log();
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
          savePreferences({ provider: config.provider, model: config.model, maxTokens: config.maxTokens, shellTimeout: config.shellTimeout, theme: config.theme });
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
          savePreferences({ provider: config.provider, model: config.model, maxTokens: config.maxTokens, shellTimeout: config.shellTimeout, theme: config.theme });
          printInfo(`  Switched to ${config.model}`);
        } else {
          printInfo('  Cancelled.');
        }
        console.log();
        prompt();
      });
      return;
    }

    if (trimmed === '/theme') {
      const allKeys = getThemeKeys();
      const currentKey = getActiveThemeKey();
      const regularKeys = allKeys.filter(k => k !== 'high-contrast' && k !== 'colorblind');
      const a11yKeys = allKeys.filter(k => k === 'high-contrast' || k === 'colorblind');

      printInfo(`\n  Current theme: ${THEMES[currentKey].name}\n`);
      printInfo('  Themes:');
      let idx = 1;
      for (const k of regularKeys) {
        const marker = k === currentKey ? ' (active)' : '';
        printInfo(`    ${idx}. ${THEMES[k].name}${marker}`);
        idx++;
      }
      printInfo('\n  Accessibility:');
      for (const k of a11yKeys) {
        const marker = k === currentKey ? ' (active)' : '';
        printInfo(`    ${idx}. ${THEMES[k].name}${marker}`);
        idx++;
      }
      console.log();

      const ordered = [...regularKeys, ...a11yKeys];
      rl.question(`  Select [1-${ordered.length}]: `, (answer) => {
        const num = parseInt(answer.trim(), 10);
        if (num >= 1 && num <= ordered.length) {
          const chosen = ordered[num - 1];
          setTheme(chosen);
          config.theme = chosen;
          savePreferences({ provider: config.provider, model: config.model, maxTokens: config.maxTokens, shellTimeout: config.shellTimeout, theme: chosen });
          printInfo(`  Switched to ${THEMES[chosen].name} theme.`);
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

    if (trimmed === '/update') {
      await interactiveUpdate();
      prompt();
      return;
    }

    } // end slash command handling

    processing = true;
    interrupted = false;
    try {
      const spinnerStats: SpinnerStats = {
        startTime: Date.now(),
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        latestPromptTokens: 0,
        model: config.model,
      };
      agent.setSpinnerStats(spinnerStats);
      startSpinner(() => buildSpinnerMessage(spinnerStats));
      await agent.processInput(trimmed);
      historyStore.save(agent.getHistory());
    } catch (err: unknown) {
      if (!interrupted) {
        const message = err instanceof Error ? err.message : String(err);
        printError(message);
      }
    } finally {
      processing = false;
      stopSpinner();
    }

    if (interrupted) {
      printInfo('Interrupted.');
      interrupted = false;
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
