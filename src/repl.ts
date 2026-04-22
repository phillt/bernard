import * as readline from 'node:readline';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import {
  RAG_DIR,
  MCP_CONFIG_PATH,
  CONFIG_DIR,
  DATA_DIR,
  CACHE_DIR,
  STATE_DIR,
  CRON_JOBS_FILE,
} from './paths.js';
import { Agent } from './agent.js';
import { MemoryStore, loadRewriterHints, saveRewriterHint } from './memory.js';
import {
  resolveReferences,
  renderResolvedBlock,
  deriveKeyFromReference,
  shouldSkipResolver,
  stripToolResolvableTokens,
  type ResolvedEntry,
  type Candidate,
} from './reference-resolver.js';
import { RAGStore, type RAGSearchResult } from './rag.js';
import { MCPManager } from './mcp.js';
import {
  printHelp,
  printInfo,
  printError,
  printConversationReplay,
  printWelcome,
  startSpinner,
  stopSpinner,
  buildSpinnerMessage,
  formatTokenCount,
  type SpinnerStats,
} from './output.js';
import type { ToolOptions } from './tools';
import {
  PROVIDER_MODELS,
  getAvailableProviders,
  getDefaultModel,
  savePreferences,
  loadPreferences,
  OPTIONS_REGISTRY,
  saveOption,
  getProviderKeyStatus,
  normalizeThreshold,
  type BernardConfig,
} from './config.js';
import { getTheme, setTheme, getThemeKeys, getActiveThemeKey, THEMES } from './theme.js';
import { interactiveUpdate, getLocalVersion } from './update.js';
import { CronStore } from './cron/store.js';
import { isDaemonRunning } from './cron/client.js';
import { HistoryStore } from './history.js';
import { generateText } from 'ai';
import { getModel, getModelProfile } from './providers/index.js';
import { rewritePrompt } from './prompt-rewriter.js';
import {
  serializeMessages,
  SUMMARIZATION_PROMPT,
  extractDomainFacts,
  getContextWindow,
} from './context.js';
import { getDomain, getDomainIds } from './domains.js';
import { RoutineStore } from './routines.js';
import { SpecialistStore, getBuiltinSpecialistIds } from './specialists.js';
import { runCorrectionAgent } from './correction.js';
import { CandidateStore, type SpecialistCandidate } from './specialist-candidates.js';
import { detectSpecialistCandidate } from './specialist-detector.js';
import {
  TASK_SYSTEM_PROMPT,
  wrapTaskResult,
  getTaskMaxSteps,
  makeLastStepTextOnly,
} from './tools/task.js';
import { createTools } from './tools/index.js';
import {
  printTaskStart,
  printTaskEnd,
  printToolCall,
  printToolResult,
  printAssistantText,
  printWarning,
  setToolDetailsVisible,
} from './output.js';
import { buildMemoryContext } from './memory-context.js';
import { debugLog } from './logger.js';
import {
  loadImage,
  tryLoadImage,
  extractImagePaths,
  stripImagePaths,
  isVisionCapableModel,
  type ImageAttachment,
} from './image.js';
import {
  selectFromMenu,
  promptValue,
  type MenuEntry,
  type MenuItem,
  type SelectResult,
  type ValueResult,
} from './menu.js';

/** Promote a pending candidate to a full specialist, updating status and logging. */
function promoteCandidate(
  candidate: Pick<
    SpecialistCandidate,
    'id' | 'draftId' | 'name' | 'description' | 'systemPrompt' | 'guidelines' | 'confidence'
  >,
  specialistStore: SpecialistStore,
  candidateStore: CandidateStore,
  threshold: number,
): void {
  specialistStore.create(
    candidate.draftId,
    candidate.name,
    candidate.description,
    candidate.systemPrompt,
    candidate.guidelines,
  );
  candidateStore.updateStatus(candidate.id, 'accepted');
  debugLog('repl:auto-create', {
    candidate: candidate.name,
    confidence: candidate.confidence,
    threshold,
  });
  printInfo(
    `Specialist auto-created: "${candidate.name}" (confidence: ${Math.round(candidate.confidence * 100)}%). Use /specialists to view.`,
  );
}

/** Re-evaluate all pending candidates and auto-create those meeting the threshold. */
function promotePendingCandidates(
  candidateStore: CandidateStore,
  specialistStore: SpecialistStore,
  threshold: number,
): void {
  const pending = candidateStore.listPending();
  for (const c of pending) {
    if (c.confidence >= threshold) {
      try {
        promoteCandidate(c, specialistStore, candidateStore, threshold);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        debugLog('repl:auto-create', {
          action: 're-evaluate-failed',
          candidate: c.name,
          confidence: c.confidence,
          error: errorMessage,
        });
        printWarning(`Failed to auto-create specialist "${c.name}": ${errorMessage}`);
      }
    }
  }
}

/**
 * Launch the interactive REPL, wiring up readline, MCP servers, memory stores, and the agent loop.
 * @param config - Resolved runtime configuration (provider, model, tokens, etc.).
 * @param alertContext - Optional pre-filled context from a cron alert that triggered this session.
 * @param resume - When true, reload the previous conversation from disk and continue it.
 */
export async function startRepl(
  config: BernardConfig,
  alertContext?: string,
  resume?: boolean,
): Promise<void> {
  setToolDetailsVisible(config.toolDetails);
  const SLASH_COMMANDS = [
    { command: '/help', description: 'Show this help' },
    { command: '/clear', description: 'Clear conversation (--save/-s to summarize first)' },
    { command: '/compact', description: 'Compress conversation history in-place' },
    { command: '/memory', description: 'List persistent memories' },
    { command: '/scratch', description: 'List session scratch notes' },
    { command: '/mcp', description: 'List MCP servers and tools' },
    { command: '/cron', description: 'Show cron jobs and daemon status' },
    { command: '/rag', description: 'Show RAG memory stats and recent facts' },
    { command: '/facts', description: 'Show RAG facts in the current context window' },
    { command: '/provider', description: 'Switch LLM provider' },
    { command: '/model', description: 'Switch model for current provider' },
    { command: '/theme', description: 'Switch color theme' },
    {
      command: '/options',
      description: 'View and set options (max-tokens, max-steps, shell-timeout, token-window)',
    },
    { command: '/update', description: 'Check for and install updates' },
    { command: '/task', description: 'Run an isolated task (no history, structured output)' },
    { command: '/routines', description: 'List saved routines' },
    { command: '/create-routine', description: 'Create a routine with guided AI assistance' },
    { command: '/create-task', description: 'Create a task routine with guided AI assistance' },
    { command: '/specialists', description: 'List specialist agents' },
    { command: '/create-specialist', description: 'Create a specialist with guided AI assistance' },
    { command: '/candidates', description: 'Review specialist suggestions' },
    {
      command: '/agent-options',
      description: 'Configure agent behavior (toggles, thresholds, saved assets)',
    },
    { command: '/image', description: 'Attach an image: /image <path> [prompt]' },
    { command: '/exit', description: 'Quit Bernard' },
  ];

  const routineStore = new RoutineStore();
  const specialistStore = new SpecialistStore();
  const candidateStore = new CandidateStore();

  let cachedAllCommands: { command: string; description: string }[] | null = null;
  let cachedAllCommandsAt = 0;
  const COMMAND_CACHE_TTL = 5_000; // 5 seconds

  function getAllSlashCommands(): { command: string; description: string }[] {
    const now = Date.now();
    if (cachedAllCommands && now - cachedAllCommandsAt < COMMAND_CACHE_TTL) {
      return cachedAllCommands;
    }
    const routineCommands = routineStore.getSummaries().map((r) => ({
      command: `/${r.id}`,
      description: `Routine: ${r.name}`,
    }));
    cachedAllCommands = [...SLASH_COMMANDS, ...routineCommands];
    cachedAllCommandsAt = now;
    return cachedAllCommands;
  }

  function completer(line: string): [string[], string] {
    if (line.startsWith('/')) {
      const all = getAllSlashCommands();
      const hits = all.filter((c) => c.command.startsWith(line)).map((c) => c.command);
      return [hits.length ? hits : all.map((c) => c.command), line];
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
    const criticLabel = config.criticMode ? `${ansi.warning}\u25C6${ansi.reset} ` : '';
    const reactLabel = config.reactMode ? `${ansi.prompt}\u25B7${ansi.reset} ` : '';
    return `${criticLabel}${reactLabel}${ansi.prompt}bernard>${ansi.reset} `;
  }

  if (process.stdin.isTTY) {
    process.stdout.write('\x1b[?2004h'); // enable bracket paste mode
  }

  let hintLineCount = 0;

  function redrawWithHints(line: string): void {
    const matches =
      !isPasting && line.startsWith('/')
        ? getAllSlashCommands().filter((c) => c.command.startsWith(line))
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
      const maxLen = Math.max(...matches.map((c) => c.command.length));
      const { ansi } = getTheme();
      for (const c of matches) {
        const pad = ' '.repeat(maxLen - c.command.length + 2);
        process.stdout.write(
          `  ${ansi.hintCmd}${c.command}${ansi.reset}${pad}${ansi.hintDesc}— ${c.description}${ansi.reset}\n`,
        );
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
  let taskAbortController: AbortController | null = null;
  let menuAbortController: AbortController | null = null;

  function createMenuSignal(): AbortSignal {
    menuAbortController = new AbortController();
    return menuAbortController.signal;
  }

  function clearMenuSignal(): void {
    menuAbortController = null;
  }

  async function toggleBooleanPref(
    key: 'criticMode' | 'reactMode' | 'toolDetails' | 'promptRewriter' | 'autoCreateSpecialists',
    label: string,
    onMsg: string,
    offMsg: string,
    onToggle?: (value: boolean) => void,
  ): Promise<void> {
    const entries: MenuEntry[] = [
      { label: 'On', active: config[key] === true },
      { label: 'Off', active: config[key] === false },
    ];
    const signal = createMenuSignal();
    try {
      const result = await selectFromMenu(
        rl,
        entries,
        { title: `${label}: ${config[key] ? 'ON' : 'OFF'}` },
        signal,
      );
      if (!result.cancelled) {
        config[key] = result.index === 0;
        savePreferences({
          ...loadPreferences(),
          provider: config.provider,
          model: config.model,
          [key]: config[key],
        });
        onToggle?.(config[key]);
        printInfo(config[key] ? onMsg : offMsg);
      }
    } finally {
      clearMenuSignal();
    }
    console.log();
  }

  function printSpecialistsList(): void {
    const specialists = specialistStore.list();
    if (specialists.length === 0) {
      printInfo(
        'No specialist agents defined yet. Ask me to create one or use /create-specialist.',
      );
      return;
    }
    const builtinIds = getBuiltinSpecialistIds();
    const bundled = specialists.filter((s) => builtinIds.has(s.id));
    const user = specialists.filter((s) => !builtinIds.has(s.id));
    const t = getTheme();
    printInfo(`\n  Specialists (${specialists.length}):`);
    if (bundled.length > 0) {
      console.log(t.muted('\n    Bundled:'));
      for (const s of bundled) {
        printInfo(`      ${s.id} — ${s.name}: ${s.description}`);
      }
    }
    if (user.length > 0) {
      console.log(t.muted('\n    Yours:'));
      for (const s of user) {
        printInfo(`      ${s.id} — ${s.name}: ${s.description}`);
      }
    }
    console.log();
  }

  function printRoutinesList(kind: 'tasks' | 'routines'): void {
    const all = routineStore.list();
    const match = all.filter((r) =>
      kind === 'tasks' ? r.id.startsWith('task-') : !r.id.startsWith('task-'),
    );
    if (match.length === 0) {
      if (kind === 'tasks') {
        printInfo('No tasks saved. Use /create-task to define one.');
      } else {
        printInfo('No routines saved. Teach me a workflow and I can save it as a routine.');
      }
      return;
    }
    const heading =
      kind === 'tasks'
        ? `\n  Tasks (${match.length}) — single-step, structured output:`
        : `\n  Routines (${match.length}) — multi-step workflows:`;
    printInfo(heading);
    const t = getTheme();
    for (const r of match) {
      console.log(`    ${t.accent(`/${r.id}`)} ${t.muted(`— ${r.name}: ${r.description}`)}`);
    }
    console.log();
  }

  function printDebugReport(): void {
    const t = getTheme();
    console.log(t.accent('\n  Bernard Diagnostic Report'));
    console.log(t.accent('  ' + '─'.repeat(40)));

    console.log(t.text('\n  Runtime:'));
    console.log(t.muted(`    Bernard version: ${getLocalVersion()}`));
    console.log(t.muted(`    Node.js version: ${process.version}`));
    console.log(t.muted(`    OS: ${process.platform} ${process.arch} (${os.release()})`));

    console.log(t.text('\n  LLM:'));
    console.log(t.muted(`    Provider: ${config.provider}`));
    console.log(t.muted(`    Model: ${config.model}`));
    console.log(t.muted(`    maxTokens: ${config.maxTokens}`));
    console.log(t.muted(`    shellTimeout: ${config.shellTimeout}ms`));
    console.log(t.muted(`    tokenWindow: ${config.tokenWindow || 'auto-detect'}`));

    console.log(t.text('\n  API Keys:'));
    for (const { provider, hasKey } of getProviderKeyStatus()) {
      console.log(t.muted(`    ${provider}: ${hasKey ? 'configured' : 'not set'}`));
    }

    const debugStatuses = mcpManager.getServerStatuses();
    console.log(t.text('\n  MCP Servers:'));
    if (debugStatuses.length === 0) {
      console.log(t.muted('    (none configured)'));
    } else {
      for (const s of debugStatuses) {
        if (s.connected) {
          console.log(t.muted(`    ${s.name}: connected (${s.toolCount} tools)`));
        } else {
          console.log(t.muted(`    ${s.name}: failed — ${s.error}`));
        }
      }
    }

    console.log(t.text('\n  RAG:'));
    console.log(t.muted(`    Enabled: ${config.ragEnabled}`));
    if (ragStore) {
      console.log(t.muted(`    Facts: ${ragStore.count()}`));
    }

    console.log(t.text('\n  Memory:'));
    console.log(t.muted(`    Persistent memories: ${memoryStore.listMemory().length}`));

    console.log(t.text('\n  Cron:'));
    console.log(t.muted(`    Daemon: ${isDaemonRunning() ? 'running' : 'stopped'}`));
    let debugJobCount = 0;
    try {
      const raw = fs.readFileSync(CRON_JOBS_FILE, 'utf-8');
      debugJobCount = JSON.parse(raw).length;
    } catch {
      // jobs.json doesn't exist yet — that's fine
    }
    console.log(t.muted(`    Jobs: ${debugJobCount}`));

    console.log(t.text('\n  Conversation:'));
    console.log(t.muted(`    Messages: ${agent.getHistory().length}`));

    console.log(t.text('\n  Settings:'));
    console.log(t.muted(`    Theme: ${getActiveThemeKey()}`));
    console.log(t.muted(`    Critic mode: ${config.criticMode ? 'on' : 'off'}`));
    console.log(t.muted(`    Coordinator mode: ${config.reactMode ? 'on' : 'off'}`));
    console.log(t.muted(`    Tool details: ${config.toolDetails ? 'on' : 'off'}`));
    console.log(t.muted(`    Prompt rewriter: ${config.promptRewriter ? 'on' : 'off'}`));
    const debugEnabled = process.env.BERNARD_DEBUG === 'true' || process.env.BERNARD_DEBUG === '1';
    console.log(t.muted(`    Debug mode: ${debugEnabled ? 'on' : 'off'}`));

    console.log(t.text('\n  Paths:'));
    if (process.env.BERNARD_HOME) {
      console.log(t.muted(`    BERNARD_HOME: ${process.env.BERNARD_HOME}`));
    }
    console.log(t.muted(`    Config: ${CONFIG_DIR}`));
    console.log(t.muted(`    Data: ${DATA_DIR}`));
    console.log(t.muted(`    Cache: ${CACHE_DIR}`));
    console.log(t.muted(`    State: ${STATE_DIR}`));

    console.log();
  }

  type DisambiguationOutcome =
    | { cancelled: true }
    | { cancelled: false; passAsIs: true }
    | { cancelled: false; passAsIs: false; entry: ResolvedEntry; remember: boolean };

  async function promptDisambiguation(
    reference: string,
    candidates: Candidate[],
  ): Promise<DisambiguationOutcome> {
    const entries: MenuEntry[] = [];
    for (const c of candidates) {
      entries.push({ label: c.label, description: c.preview });
    }
    entries.push({ label: 'Pass as-is (do not resolve)' });
    for (const c of candidates) {
      entries.push({ label: `Remember: "${reference}" → ${c.label}` });
    }

    const signal = createMenuSignal();
    try {
      const result = await selectFromMenu(
        rl,
        entries,
        { title: `Ambiguous reference: "${reference}"`, promptLabel: 'Resolve to' },
        signal,
      );
      if (result.cancelled) return { cancelled: true };

      const idx = result.index;
      if (idx < candidates.length) {
        const chosen = candidates[idx];
        return {
          cancelled: false,
          passAsIs: false,
          entry: {
            phrase: reference,
            resolvedTo: chosen.label,
            sourceKey: chosen.sourceKey,
          },
          remember: false,
        };
      }
      if (idx === candidates.length) {
        return { cancelled: false, passAsIs: true };
      }
      const rememberIdx = idx - candidates.length - 1;
      const chosen = candidates[rememberIdx];
      return {
        cancelled: false,
        passAsIs: false,
        entry: {
          phrase: reference,
          resolvedTo: chosen.label,
          sourceKey: chosen.sourceKey,
        },
        remember: true,
      };
    } finally {
      clearMenuSignal();
    }
  }

  type UnknownReferenceOutcome = { entry: ResolvedEntry | null };

  async function promptUnknownReference(
    reference: string,
    store: MemoryStore,
  ): Promise<UnknownReferenceOutcome> {
    printInfo(
      `\n  I don't have memory for "${reference}". Tell me about them and I'll remember.\n  (Enter or Esc skips — the agent will run without this resolved.)`,
    );
    console.log();
    const signal = createMenuSignal();
    try {
      const result = await promptValue(rl, { label: `"${reference}" is` }, signal);
      if (result.cancelled) return { entry: null };
      if (!result.raw.trim()) return { entry: null };
      const baseKey = deriveKeyFromReference(reference) || 'entity';
      const existing = new Set(store.listMemory());
      let key = baseKey;
      let suffix = 2;
      while (existing.has(key)) {
        key = `${baseKey}-${suffix++}`;
      }
      store.writeMemory(key, result.raw);
      printInfo(`  Saved as memory: ${key}`);
      return {
        entry: {
          phrase: reference,
          resolvedTo: result.raw,
          sourceKey: key,
        },
      };
    } finally {
      clearMenuSignal();
    }
  }

  async function runReferenceResolver(trimmed: string): Promise<ResolvedEntry[]> {
    // Strip image-attachment paths and tool-resolvable tokens (URLs, PR/issue refs, file
    // paths, commit hashes) so the resolver's LLM doesn't mistake them for unresolved
    // entities. The main agent fetches those directly via shell/gh/web_read.
    const resolverInput = stripToolResolvableTokens(stripImagePaths(trimmed));
    if (shouldSkipResolver(resolverInput) || resolverInput.length === 0) return [];
    try {
      const hints = loadRewriterHints(memoryStore);
      const resolveSignal = createMenuSignal();
      let resolveResult;
      startSpinner();
      try {
        resolveResult = await resolveReferences(
          resolverInput,
          memoryStore,
          config,
          hints,
          resolveSignal,
          ragStore,
          agent.getHistory(),
        );
      } finally {
        stopSpinner();
        clearMenuSignal();
      }

      let entries: ResolvedEntry[] = [];
      if (resolveResult.status === 'resolved') {
        entries = resolveResult.entries;
      } else if (resolveResult.status === 'ambiguous') {
        const outcome = await promptDisambiguation(
          resolveResult.reference,
          resolveResult.candidates,
        );
        // Esc/Enter is treated as "pass as-is" — the agent still runs with the original
        // prompt, consistent with the unknown-reference skip behavior.
        if (!outcome.cancelled && !outcome.passAsIs) {
          entries = [outcome.entry];
          if (outcome.remember) {
            saveRewriterHint(memoryStore, outcome.entry.phrase, outcome.entry.sourceKey);
            printInfo(`  Remembered: "${outcome.entry.phrase}" → ${outcome.entry.sourceKey}`);
          }
        }
      } else if (resolveResult.status === 'unknown') {
        const outcome = await promptUnknownReference(resolveResult.reference, memoryStore);
        if (outcome.entry) entries = [outcome.entry];
      }

      if (entries.length > 0) {
        debugLog('repl:resolved-references', {
          prompt: trimmed,
          entries,
          injectedBlock: renderResolvedBlock(entries),
        });
      }
      return entries;
    } catch (err: unknown) {
      debugLog('repl:resolve-references', err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async function runPromptRewriter(
    trimmed: string,
    resolvedEntries: ResolvedEntry[],
  ): Promise<string | null> {
    if (!config.promptRewriter) return null;
    try {
      const profile = getModelProfile(config.provider, config.model);
      const rewriteSignal = createMenuSignal();
      let result;
      startSpinner();
      try {
        result = await rewritePrompt(trimmed, profile, resolvedEntries, config, rewriteSignal);
      } finally {
        stopSpinner();
        clearMenuSignal();
      }
      if (result.status === 'rewritten') {
        debugLog('repl:prompt-rewritten', {
          original: trimmed,
          rewritten: result.text,
          family: profile.family,
        });
        return result.text;
      }
      return null;
    } catch (err: unknown) {
      debugLog('repl:prompt-rewriter', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  process.stdin.on('keypress', (_str: string, key: any) => {
    if (!key) return;

    if (key.name === 'escape' && menuAbortController) {
      menuAbortController.abort();
      return;
    }

    if (key.name === 'escape' && processing) {
      if (taskAbortController) {
        taskAbortController.abort();
      }
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
      const line = ((rl as any).line as string) || '';
      process.stdout.write(`\x1b[${hintLineCount}A\r\x1b[J`);
      process.stdout.write(getPromptStr() + line);
      hintLineCount = 0;
      return;
    }

    // Show/update slash command hints on next tick (after readline updates rl.line)
    if (
      !isPasting &&
      key.name !== 'paste-start' &&
      key.name !== 'paste-end' &&
      key.name !== 'return'
    ) {
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
      rl.question(
        `${ansi.warning}  ⚠ Dangerous command: ${command}\n  Allow? (y/N): ${ansi.reset}`,
        (answer) => {
          resolve(answer.trim().toLowerCase() === 'y');
        },
      );
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
          !(
            typeof msg.content === 'string' &&
            (msg.content.startsWith('[Previous session ended') ||
              msg.content ===
                "Understood. Starting a new session. I'll only reference prior context if relevant to your current request.")
          ),
      );
      const boundary: import('ai').CoreMessage = {
        role: 'user',
        content:
          '[Previous session ended. New session starting. Treat tasks from prior session as completed unless the user explicitly continues them.]',
      };
      const boundaryAck: import('ai').CoreMessage = {
        role: 'assistant',
        content:
          "Understood. Starting a new session. I'll only reference prior context if relevant to your current request.",
      };
      initialHistory = [...filtered, boundary, boundaryAck];
      printConversationReplay(loaded);
    } else {
      printInfo('No previous conversation found — starting fresh.');
    }
  }

  // Surface pending specialist candidates at session start
  candidateStore.pruneOld();
  candidateStore.reconcileSaved(specialistStore.list());
  if (config.autoCreateSpecialists) {
    promotePendingCandidates(candidateStore, specialistStore, config.autoCreateThreshold);
  }
  const pendingCandidates = candidateStore.listPending();
  if (pendingCandidates.length > 0) {
    printInfo(
      `  ${pendingCandidates.length} specialist suggestion(s) pending. Use /candidates to review.`,
    );
    const candidateContext = `## Specialist Suggestions\n\nBernard detected patterns in previous sessions that might benefit from saved specialists. Mention these when relevant.\n\n${pendingCandidates.map((c) => `- "${c.name}" (${c.draftId}): ${c.description}`).join('\n')}`;
    alertContext = alertContext ? alertContext + '\n\n' + candidateContext : candidateContext;
  }

  const agent = new Agent(
    config,
    toolOptions,
    memoryStore,
    mcpTools,
    mcpServerNames,
    alertContext,
    initialHistory,
    ragStore,
    routineStore,
    specialistStore,
    candidateStore,
  );

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (process.stdin.isTTY) {
      process.stdout.write('\x1b[?2004l'); // disable bracket paste mode
    }

    // Spawn background RAG extraction worker if applicable
    try {
      const history = agent.getHistory();
      if (ragStore && history.length >= 4) {
        const serialized = serializeMessages(history);
        if (serialized.trim()) {
          fs.mkdirSync(RAG_DIR, { recursive: true });
          const tempFile = path.join(
            RAG_DIR,
            `.pending-${crypto.randomBytes(8).toString('hex')}.json`,
          );
          fs.writeFileSync(
            tempFile,
            JSON.stringify({
              serialized,
              provider: config.provider,
              model: config.model,
            }),
          );

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

    // Run the correction agent over any tool-wrapper failures queued this
    // session. Best-effort; never block shutdown on errors.
    if (config.correctionEnabled) {
      try {
        const correctionStore = agent.getCorrectionStore();
        const pending = correctionStore.listPending();
        if (pending.length > 0) {
          printInfo(`Reviewing ${pending.length} tool-wrapper failure(s) for learning...`);
          const result = await runCorrectionAgent(
            {
              config,
              toolOptions,
              memoryStore,
              specialistStore: agent.getSpecialistStore(),
              correctionStore,
              ragStore,
              routineStore,
              candidateStore,
              mcpTools,
            },
            pending,
          );
          if (result.applied > 0) {
            printInfo(
              `  Learned from ${result.applied}/${result.processed} failure(s); examples updated.`,
            );
          }
        }
      } catch (err) {
        debugLog('correction:error', err instanceof Error ? err.message : String(err));
      }
    }

    await mcpManager.close();
  };

  function initSpinner(): void {
    const spinnerStats: SpinnerStats = {
      startTime: Date.now(),
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      latestPromptTokens: 0,
      model: config.model,
      contextWindowOverride: config.tokenWindow || undefined,
    };
    agent.setSpinnerStats(spinnerStats);
    startSpinner(() => buildSpinnerMessage(spinnerStats));
  }

  async function runGuidedCreation(message: string): Promise<void> {
    processing = true;
    interrupted = false;
    try {
      initSpinner();
      await agent.processInput(message);
      historyStore.save(agent.getHistory());
    } catch (err: unknown) {
      if (!interrupted) {
        const msg = err instanceof Error ? err.message : String(err);
        printError(msg);
      }
    } finally {
      processing = false;
      stopSpinner();
    }
    if (interrupted) {
      printInfo('Interrupted.');
      interrupted = false;
    }
    console.log();
    void prompt();
  }

  /** Execute a task with structured JSON output. Used by /task and /task-{id}. */
  async function executeTask(description: string, context?: string): Promise<void> {
    processing = true;
    interrupted = false;
    taskAbortController = new AbortController();
    printTaskStart(description);
    startSpinner('Running task...');

    try {
      const baseTools = createTools(toolOptions, memoryStore, mcpTools);

      // Optional RAG search for context
      let ragResults;
      if (ragStore) {
        try {
          ragResults = await ragStore.search(description);
          if (ragResults.length > 0) {
            debugLog('repl:task:rag', {
              query: description.slice(0, 100),
              results: ragResults.length,
            });
          }
        } catch (err) {
          debugLog('repl:task:rag:error', err instanceof Error ? err.message : String(err));
        }
      }

      const autoContext = `\n\nWorking directory: ${process.cwd()}\nAvailable tools: ${Object.keys(baseTools).join(', ')}`;

      const systemPrompt =
        TASK_SYSTEM_PROMPT +
        autoContext +
        buildMemoryContext({ memoryStore, ragResults, includeScratch: false });

      let userMessage = `Task: ${description}`;
      if (context) {
        userMessage += `\n\nAdditional context: ${context}`;
      }

      const taskMaxSteps = getTaskMaxSteps(config);
      const result = await generateText({
        model: getModel(config.provider, config.model),
        tools: baseTools,
        maxSteps: taskMaxSteps,
        maxTokens: config.maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        abortSignal: taskAbortController.signal,
        experimental_prepareStep: makeLastStepTextOnly(taskMaxSteps),
        onStepFinish: ({ text, toolCalls, toolResults }) => {
          for (const tc of toolCalls) {
            printToolCall(tc.toolName, tc.args as Record<string, unknown>);
          }
          for (const tr of toolResults) {
            printToolResult(tr.toolName, tr.result);
          }
          if (text) {
            printAssistantText(text);
          }
        },
      });

      if (result.finishReason === 'length') {
        const recommended = Math.ceil((config.maxTokens * 2) / 1024) * 1024;
        printWarning(
          `Task response was truncated (hit ${config.maxTokens} token limit). ` +
            `Consider increasing: /options max-tokens ${recommended}`,
        );
      }

      stopSpinner();
      const taskResult = wrapTaskResult(result.text);
      printTaskEnd(JSON.stringify(taskResult));

      // Print the full output for the user
      const t = getTheme();
      const outputStr =
        typeof taskResult.output === 'string'
          ? taskResult.output
          : JSON.stringify(taskResult.output, null, 2);
      if (taskResult.details) {
        console.log(t.text(`\n${outputStr}\n${taskResult.details}`));
      } else {
        console.log(t.text(`\n${outputStr}`));
      }
    } catch (err: unknown) {
      stopSpinner();
      if (!interrupted) {
        const message = err instanceof Error ? err.message : String(err);
        printTaskEnd(JSON.stringify({ status: 'error', output: message }));
        printError(message);
      }
    } finally {
      processing = false;
      taskAbortController = null;
      stopSpinner();
    }

    if (interrupted) {
      printInfo('Interrupted.');
      interrupted = false;
    }
  }

  const prompt = async () => {
    const { text, pasted } = await readInput();
    let trimmed = text.trim();

    if (!trimmed) {
      void prompt();
      return;
    }

    // Escaped forward slash: unescape and send to agent as regular text
    const isEscapedSlash = trimmed.startsWith('\\/');
    if (isEscapedSlash) {
      trimmed = trimmed.slice(1);
    }

    // Bare "/" was handled by live keypress hints; just re-prompt
    if (!pasted && !isEscapedSlash && trimmed === '/') {
      void prompt();
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
        void prompt();
        return;
      }

      if (trimmed === '/clear' || trimmed.startsWith('/clear ')) {
        const clearArgs = trimmed.slice('/clear'.length).trim();
        const shouldSave = clearArgs === '--save' || clearArgs === '-s';

        if (clearArgs && !shouldSave) {
          printError('Usage: /clear [--save|-s]');
          void prompt();
          return;
        }

        if (shouldSave) {
          const history = agent.getHistory();
          if (history.length < 2) {
            printInfo('Not enough conversation to summarize.');
          } else {
            processing = true;
            startSpinner('Summarizing conversation...');
            try {
              const serialized = serializeMessages(history);

              const [summaryResult, domainFacts, candidateResult] = await Promise.all([
                generateText({
                  model: getModel(config.provider, config.model),
                  maxTokens: 2048,
                  system: SUMMARIZATION_PROMPT,
                  messages: [
                    { role: 'user', content: `Summarize this conversation:\n\n${serialized}` },
                  ],
                }),
                extractDomainFacts(serialized, config),
                detectSpecialistCandidate(
                  serialized,
                  config,
                  specialistStore.list(),
                  candidateStore.listPending(),
                ).catch(() => null),
              ]);

              const summary = summaryResult.text?.trim();
              if (summary) {
                const key = `session-summary-${new Date().toISOString().replace(/[:.]/g, '-')}`;
                memoryStore.writeMemory(key, summary);
                printInfo(`Summary saved to memory: ${key}`);
              }

              if (ragStore && domainFacts.length > 0) {
                const totalFacts = domainFacts.reduce((sum, df) => sum + df.facts.length, 0);
                const results = await Promise.allSettled(
                  domainFacts.map((df) => ragStore.addFacts(df.facts, 'clear-save', df.domain)),
                );
                let storedFacts = 0;
                results.forEach((result, i) => {
                  if (result.status === 'fulfilled') {
                    storedFacts += domainFacts[i].facts.length;
                  } else {
                    debugLog(
                      'repl:clear-save:rag',
                      `Failed to store facts for domain ${domainFacts[i].domain}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
                    );
                  }
                });
                if (storedFacts > 0) {
                  printInfo(
                    storedFacts === totalFacts
                      ? `Extracted ${storedFacts} facts to RAG memory.`
                      : `Extracted ${storedFacts}/${totalFacts} facts to RAG memory.`,
                  );
                }
              }

              if (candidateResult) {
                try {
                  if (candidateResult.type === 'new-candidate') {
                    const created = candidateStore.create(candidateResult.candidate, 'clear-save');
                    if (
                      config.autoCreateSpecialists &&
                      candidateResult.candidate.confidence >= config.autoCreateThreshold
                    ) {
                      promoteCandidate(
                        { ...candidateResult.candidate, id: created.id },
                        specialistStore,
                        candidateStore,
                        config.autoCreateThreshold,
                      );
                    } else {
                      debugLog('repl:auto-create', {
                        action: 'skipped',
                        candidate: candidateResult.candidate.name,
                        confidence: candidateResult.candidate.confidence,
                        threshold: config.autoCreateThreshold,
                        autoCreateEnabled: config.autoCreateSpecialists,
                      });
                      printInfo(
                        `Specialist suggestion detected: "${candidateResult.candidate.name}". Use /candidates to review.`,
                      );
                    }
                  } else if (candidateResult.type === 'enhance-existing') {
                    printInfo(
                      `Enhancement suggested for specialist "${candidateResult.enhancement.existingSpecialistId}": ${candidateResult.enhancement.reasoning}`,
                    );
                  }
                } catch {
                  // Silent — candidate storage failure is non-critical
                }
              }
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              printError(`Failed to summarize: ${message}. Clearing anyway.`);
            } finally {
              processing = false;
              stopSpinner();
            }
          }
        }

        agent.clearHistory();
        historyStore.clear();
        console.clear();
        printWelcome(config.provider, config.model, getLocalVersion());
        printInfo('Conversation history and scratch notes cleared.');
        void prompt();
        return;
      }

      if (trimmed === '/compact') {
        const history = agent.getHistory();
        if (history.length < 2) {
          printInfo('Not enough conversation to compact.');
          void prompt();
          return;
        }
        processing = true;
        startSpinner('Compacting conversation...');
        try {
          const result = await agent.compactHistory();
          stopSpinner();
          if (!result.compacted) {
            printInfo('Nothing to compact — conversation is already short enough.');
          } else {
            const pct = Math.round(
              ((result.tokensBefore - result.tokensAfter) / result.tokensBefore) * 100,
            );
            printInfo(
              `Compacted: ~${formatTokenCount(result.tokensBefore)} → ~${formatTokenCount(result.tokensAfter)} tokens (${pct}% reduction)`,
            );
          }
          historyStore.save(agent.getHistory());
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          printError(`Compaction failed: ${message}`);
        } finally {
          processing = false;
          stopSpinner();
        }
        void prompt();
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
        void prompt();
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
        void prompt();
        return;
      }

      if (trimmed === '/mcp') {
        const statuses = mcpManager.getServerStatuses();
        if (statuses.length === 0) {
          printInfo(`No MCP servers configured. Add servers to ${MCP_CONFIG_PATH}`);
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
        void prompt();
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

          const alerts = store.listAlerts().filter((a) => !a.acknowledged);
          if (alerts.length > 0) {
            printInfo(`\n  Unacknowledged alerts (${alerts.length}):`);
            for (const alert of alerts.slice(0, 5)) {
              printInfo(
                `    [${new Date(alert.timestamp).toLocaleString()}] ${alert.jobName}: ${alert.message}`,
              );
            }
          }
          console.log();
        }
        void prompt();
        return;
      }

      if (trimmed === '/rag') {
        if (!ragStore) {
          printInfo('RAG is disabled. Set BERNARD_RAG_ENABLED=true (default) to enable.');
          void prompt();
          return;
        }
        const count = ragStore.count();
        printInfo(`\n  RAG memories: ${count}`);
        if (count === 0) {
          printInfo(
            '  No RAG memories yet. Memories are extracted automatically during context compression.',
          );
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
        void prompt();
        return;
      }

      if (trimmed === '/facts') {
        const results = agent.getLastRAGResults();
        if (results.length === 0) {
          printInfo('No RAG facts in current context window.');
        } else {
          printInfo(`\n## Recalled Context (${results.length} facts)\n`);
          const byDomain = new Map<string, RAGSearchResult[]>();
          for (const r of results) {
            if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
            byDomain.get(r.domain)!.push(r);
          }
          for (const [domainId, items] of byDomain) {
            const domain = getDomain(domainId);
            printInfo(`### ${domain.name}`);
            for (const item of items) {
              const pct = Math.round(item.similarity * 100);
              printInfo(`  - (${pct}%) ${item.fact}`);
            }
            printInfo('');
          }
        }
        void prompt();
        return;
      }

      if (trimmed === '/provider') {
        const available = getAvailableProviders(config);
        if (available.length === 0) {
          printError('No providers have API keys configured.');
          void prompt();
          return;
        }
        const entries: MenuEntry[] = available.map((p) => ({ label: p }));
        const signal = createMenuSignal();
        try {
          const result = await selectFromMenu(
            rl,
            entries,
            { title: `Providers — current: ${config.provider} (${config.model})` },
            signal,
          );
          if (!result.cancelled) {
            config.provider = available[result.index];
            config.model = getDefaultModel(config.provider);
            savePreferences({
              provider: config.provider,
              model: config.model,
              maxTokens: config.maxTokens,
              shellTimeout: config.shellTimeout,
              tokenWindow: config.tokenWindow,
              theme: config.theme,
            });
            printInfo(`  Switched to ${config.provider} (${config.model})`);
          }
        } finally {
          clearMenuSignal();
        }
        console.log();
        void prompt();
        return;
      }

      if (trimmed === '/model') {
        const models = PROVIDER_MODELS[config.provider];
        if (!models || models.length === 0) {
          printError(`No models listed for provider "${config.provider}".`);
          void prompt();
          return;
        }
        const entries: MenuEntry[] = models.map((m) => ({ label: m }));
        const signal = createMenuSignal();
        try {
          const result = await selectFromMenu(
            rl,
            entries,
            { title: `Models — current: ${config.provider} / ${config.model}` },
            signal,
          );
          if (!result.cancelled) {
            config.model = models[result.index];
            savePreferences({
              provider: config.provider,
              model: config.model,
              maxTokens: config.maxTokens,
              shellTimeout: config.shellTimeout,
              tokenWindow: config.tokenWindow,
              theme: config.theme,
            });
            printInfo(`  Switched to ${config.model}`);
          }
        } finally {
          clearMenuSignal();
        }
        console.log();
        void prompt();
        return;
      }

      if (trimmed === '/theme') {
        const allKeys = getThemeKeys();
        const currentKey = getActiveThemeKey();
        const regularKeys = allKeys.filter((k) => k !== 'high-contrast' && k !== 'colorblind');
        const a11yKeys = allKeys.filter((k) => k === 'high-contrast' || k === 'colorblind');

        const entries: MenuEntry[] = [
          ...regularKeys.map((k) => ({
            label: THEMES[k].name,
            active: k === currentKey,
            value: k,
          })),
          { type: 'section' as const, title: 'Accessibility:' },
          ...a11yKeys.map((k) => ({
            label: THEMES[k].name,
            active: k === currentKey,
            value: k,
          })),
        ];

        const signal = createMenuSignal();
        try {
          const result = await selectFromMenu(
            rl,
            entries,
            { title: `Themes — current: ${THEMES[currentKey].name}` },
            signal,
          );
          if (!result.cancelled) {
            const chosen = result.item.value as string;
            setTheme(chosen);
            config.theme = chosen;
            savePreferences({
              provider: config.provider,
              model: config.model,
              maxTokens: config.maxTokens,
              shellTimeout: config.shellTimeout,
              tokenWindow: config.tokenWindow,
              theme: chosen,
            });
            printInfo(`  Switched to ${THEMES[chosen].name} theme.`);
          }
        } finally {
          clearMenuSignal();
        }
        console.log();
        void prompt();
        return;
      }

      if (trimmed === '/options') {
        const optEntries = Object.entries(OPTIONS_REGISTRY);
        const menuEntries: MenuEntry[] = [
          ...optEntries.map(([name, opt]) => {
            const current = config[opt.configKey];
            const tag = current === opt.default ? '(default)' : '(custom)';
            return {
              label: name,
              annotation: `= ${current} ${tag}`,
              description: opt.description,
            };
          }),
          { type: 'section', title: 'Info' },
          { label: 'Debug report', description: 'Print a diagnostic report for troubleshooting' },
        ];
        const signal1 = createMenuSignal();
        let optResult: SelectResult;
        try {
          optResult = await selectFromMenu(
            rl,
            menuEntries,
            { title: 'Options', promptLabel: 'Select option' },
            signal1,
          );
        } finally {
          clearMenuSignal();
        }

        if (!optResult.cancelled) {
          if (optResult.index >= optEntries.length) {
            // Debug report is the only non-editable entry beyond the option rows.
            printDebugReport();
            void prompt();
            return;
          }

          const [name, opt] = optEntries[optResult.index];
          const signal2 = createMenuSignal();
          let valResult: ValueResult;
          try {
            valResult = await promptValue(rl, { label: `New value for ${name}` }, signal2);
          } finally {
            clearMenuSignal();
          }

          if (!valResult.cancelled) {
            const val = parseInt(valResult.raw, 10);
            const minVal = opt.default === 0 ? 0 : 1;
            if (!isNaN(val) && val >= minVal) {
              saveOption(name, val);
              config[opt.configKey] = val;
              printInfo(`  ${name} set to ${val}`);
              if (name === 'token-window') {
                const modelWindow = getContextWindow(config.model);
                if (val > modelWindow) {
                  printInfo(
                    `  Warning: ${val} exceeds ${config.model}'s context window (${modelWindow})`,
                  );
                }
              }
            } else {
              printError(
                `  Invalid value. Must be ${minVal === 0 ? 'a non-negative integer' : 'a positive integer'}.`,
              );
            }
          }
        }
        console.log();
        void prompt();
        return;
      }

      if (trimmed === '/update') {
        await interactiveUpdate();
        void prompt();
        return;
      }

      if (trimmed === '/routines') {
        const allRoutines = routineStore.list();
        if (allRoutines.length === 0) {
          printInfo('No routines saved. Teach me a workflow and I can save it as a routine.');
        } else {
          const hasTasks = allRoutines.some((r) => r.id.startsWith('task-'));
          const hasRoutines = allRoutines.some((r) => !r.id.startsWith('task-'));
          if (hasTasks) printRoutinesList('tasks');
          if (hasRoutines) printRoutinesList('routines');
        }
        void prompt();
        return;
      }

      if (trimmed === '/create-routine') {
        const message = `The user wants to create a new routine interactively. Guide them through the process:

1. Ask what workflow they want to save (what task, what steps, what's the goal)
2. Ask clarifying questions if the instructions are vague or incomplete — e.g., what should happen on errors, are there optional steps, what tools/commands are involved
3. Once you have enough information, draft the routine by optimizing their raw instructions into a well-structured routine using these prompting best practices:
   - **Clarity**: use simple, literal language; define terms; state fallback behavior
   - **Specificity**: specify exact commands, file paths, expected outputs, and decision rules
   - **Structure**: organize steps logically with clear numbering and section headers
   - **Constraints**: encode "never do X" + "do Y instead" at boundaries; keep constraints minimal but explicit
   - **Robustness**: include error handling guidance, edge cases, and "if X then Y" decision points
   - **Conciseness**: be token-efficient — no filler, no redundant instructions
4. Present the draft routine (id, name, description, content) to the user for review
5. Make any requested changes
6. Use the routine tool to save it once the user approves

Remember: routine content should be written as clear instructions that Bernard can follow. Think of it like writing a mini system prompt — specific, structured, and actionable.`;

        await runGuidedCreation(message);
        return;
      }

      if (trimmed === '/create-task') {
        const message = `The user wants to create a new saved task interactively. Saved tasks are routines whose ID is prefixed with "task-", but they execute differently from routines: tasks run in a single-step execution model (1 LLM call + tool use → structured JSON output). Guide them through the process:

1. Ask what task they want to save (what's the goal, what output is expected)
2. Ask clarifying questions if needed — e.g., what should happen on errors, what tools/commands are involved, what the expected output format is
3. Once you have enough information, draft the task using these guidelines:
   - **Single-step**: task content must be achievable in a single LLM call with tool use. If the task needs multiple sequential steps, it should be a routine that chains tasks instead.
   - **Explicit commands**: specify exact commands, file paths, and expected output format
   - **Success/error criteria**: define what constitutes success and how errors should be reported
   - **Output format**: specify what the structured JSON output should contain
   - **Conciseness**: be token-efficient — no filler, no redundant instructions
4. Present the draft task (id, name, description, content) to the user for review
5. Make any requested changes
6. Use the routine tool to save it once the user approves

IMPORTANT: The routine ID MUST start with "task-". When drafting, generate an ID like "task-deploy-staging" or "task-run-tests". If the user suggests an ID without the prefix, prepend "task-" automatically. The user will invoke this task with /task-{name} in the REPL.

Remember: task content should describe a single atomic operation with clear success criteria. Unlike routines (multi-step workflows), tasks must complete in one step.`;

        await runGuidedCreation(message);
        return;
      }

      if (trimmed === '/specialists') {
        printSpecialistsList();
        void prompt();
        return;
      }

      if (trimmed === '/create-specialist') {
        const message = `The user wants to create a new specialist agent interactively. Guide them through the process:

1. Ask what domain or recurring task pattern the specialist covers (e.g., email triage, code review, data analysis)
2. Ask about behavioral preferences — how should the specialist approach work? What tone, priorities, output formats, or decision rules should it follow?
3. Ask about specific guidelines — are there things it should always or never do?
4. Once you have enough information, draft the specialist by creating:
   - **id**: kebab-case slug (e.g., "email-triage")
   - **name**: display name (e.g., "Email Triage Specialist")
   - **description**: one-line summary
   - **systemPrompt**: the specialist's persona and behavioral instructions (this is the core — write it like a focused system prompt)
   - **guidelines**: short behavioral rules as a list of strings
5. Present the draft to the user for review
6. Make any requested changes
7. Use the specialist tool to save it once the user approves

Remember: the systemPrompt should read like a persona definition — who this specialist is, what they care about, how they work. Guidelines are individual rules that can be added/removed independently.`;

        await runGuidedCreation(message);
        return;
      }

      if (trimmed === '/candidates') {
        const pending = candidateStore.listPending();
        if (pending.length === 0) {
          printInfo('No pending specialist suggestions.');
        } else {
          const t = getTheme();
          printInfo(`\n  Specialist Suggestions (${pending.length}):\n`);
          for (const c of pending) {
            const pct = Math.round(c.confidence * 100);
            const date = new Date(c.detectedAt).toLocaleDateString();
            console.log(t.text(`    ${c.name}`) + t.muted(` (${c.draftId})`));
            console.log(t.muted(`      ${c.description}`));
            console.log(t.muted(`      Confidence: ${pct}% | Detected: ${date}`));
            console.log(t.muted(`      Reasoning: ${c.reasoning}`));
            console.log();
            candidateStore.acknowledge(c.id);
          }
          printInfo(
            '  To accept or reject, tell Bernard conversationally (e.g., "accept the code-review candidate").',
          );
          printInfo(
            '  The agent can create the specialist via the specialist tool, then update candidate status.\n',
          );
          // Inject candidate context so the agent knows about them for the rest of the session
          const candidateContext = `## Specialist Suggestions\n\nBernard detected patterns in previous sessions that might benefit from saved specialists. Mention these when relevant.\n\n${pending.map((c) => `- "${c.name}" (${c.draftId}): ${c.description}`).join('\n')}`;
          agent.setAlertContext(candidateContext);
        }
        void prompt();
        return;
      }

      // Backwards-compat shims: the standalone toggles (/critic, /react, /tool-details, /debug)
      // were consolidated into /agent-options and /options. Print a short pointer so users typing
      // the old command aren't silently dropped into the prompt.
      const legacyToggle = {
        '/critic': 'Critic mode → /agent-options',
        '/react': 'Coordinator (ReAct) mode → /agent-options',
        '/tool-details': 'Tool-call details → /agent-options',
        '/debug': 'Debug logging → /options',
      }[trimmed];
      if (legacyToggle) {
        printInfo(`  This command moved. ${legacyToggle}`);
        void prompt();
        return;
      }

      if (trimmed === '/agent-options') {
        type BooleanOpt = {
          key:
            | 'autoCreateSpecialists'
            | 'criticMode'
            | 'reactMode'
            | 'promptRewriter'
            | 'toolDetails';
          label: string;
          description: string;
          onMsg: string;
          offMsg: string;
          onToggle?: (value: boolean) => void;
        };

        const systemBools: BooleanOpt[] = [
          {
            key: 'autoCreateSpecialists',
            label: 'Auto-create specialists',
            description:
              'Auto-promote pending specialist candidates whose score exceeds the threshold.',
            onMsg: '  Auto-create specialists: on',
            offMsg: '  Auto-create specialists: off',
            onToggle: (value) => {
              if (value) {
                promotePendingCandidates(
                  candidateStore,
                  specialistStore,
                  config.autoCreateThreshold,
                );
              }
            },
          },
          {
            key: 'criticMode',
            label: 'Critic mode',
            description:
              'Plan the response, verify it with a critic pass, and retry on failure before replying.',
            onMsg: '  [CRITIC:ON] Responses will be planned and verified.',
            offMsg: '  [CRITIC:OFF] Critic mode disabled.',
          },
          {
            key: 'reactMode',
            label: 'Coordinator (ReAct) mode',
            description:
              'Iterate think → act → evaluate; delegate subtasks to subagents for complex work.',
            onMsg: '  [REACT:ON] Operating as coordinator with iterative reasoning and delegation.',
            offMsg: '  [REACT:OFF] Coordinator mode disabled.',
          },
          {
            key: 'promptRewriter',
            label: 'Prompt rewriter',
            description: 'Restructure your prompt for the active model family before each turn.',
            onMsg:
              '  [REWRITER:ON] User prompts will be restructured for the active model before execution.',
            offMsg: '  [REWRITER:OFF] Prompts will be sent to the model verbatim.',
          },
          {
            key: 'toolDetails',
            label: 'Tool details',
            description: 'Show full tool call args and results in the transcript.',
            onMsg: '  [TOOL-DETAILS:ON] Full tool call args and results will be shown.',
            offMsg: '  [TOOL-DETAILS:OFF] Only tool names shown; args and results hidden.',
            onToggle: setToolDetailsVisible,
          },
        ];

        async function runThresholdPrompt(): Promise<void> {
          const signal = createMenuSignal();
          try {
            const val = await promptValue(rl, { label: 'New threshold (0-100)' }, signal);
            if (val.cancelled) return;
            const parsed = parseFloat(val.raw);
            if (isNaN(parsed) || parsed < 0 || parsed > 100) {
              printError('Threshold must be a number between 0 and 100 (e.g. 0.8 or 80)');
              return;
            }
            const normalized = normalizeThreshold(parsed);
            config.autoCreateThreshold = normalized;
            savePreferences({
              ...loadPreferences(),
              autoCreateThreshold: normalized,
              provider: config.provider,
              model: config.model,
            });
            printInfo(`  Auto-create threshold: ${normalized} (${Math.round(normalized * 100)}%)`);
            if (config.autoCreateSpecialists) {
              promotePendingCandidates(candidateStore, specialistStore, config.autoCreateThreshold);
            }
          } finally {
            clearMenuSignal();
          }
        }

        // Data-driven menu: each row is either a section header or an item paired
        // with its action. `topEntries` and `itemActions` are derived from the
        // same source, so reordering or inserting rows cannot cause index drift.
        type MenuRow =
          | { kind: 'section'; title: string }
          | { kind: 'item'; item: MenuItem; action: () => void | Promise<void> };

        const toggleRow = (opt: BooleanOpt): MenuRow => ({
          kind: 'item',
          item: {
            label: opt.label,
            annotation: `= ${config[opt.key] ? 'on' : 'off'}`,
            description: opt.description,
          },
          action: () => toggleBooleanPref(opt.key, opt.label, opt.onMsg, opt.offMsg, opt.onToggle),
        });

        const rows: MenuRow[] = [
          { kind: 'section', title: 'System' },
          toggleRow(systemBools[0]),
          {
            kind: 'item',
            item: {
              label: 'Auto-create threshold',
              annotation: `= ${config.autoCreateThreshold} (${Math.round(config.autoCreateThreshold * 100)}%)`,
              description: 'Minimum score (0-1) a pending specialist needs before auto-promotion.',
            },
            action: runThresholdPrompt,
          },
          ...systemBools.slice(1).map(toggleRow),
          { kind: 'section', title: 'User-created' },
          {
            kind: 'item',
            item: {
              label: 'Specialists',
              description: 'List bundled and user-created specialists.',
            },
            action: () => printSpecialistsList(),
          },
          {
            kind: 'item',
            item: { label: 'Tasks', description: 'List saved single-step tasks.' },
            action: () => printRoutinesList('tasks'),
          },
          {
            kind: 'item',
            item: { label: 'Routines', description: 'List saved multi-step routines.' },
            action: () => printRoutinesList('routines'),
          },
        ];

        const topEntries: MenuEntry[] = rows.map((r) =>
          r.kind === 'section' ? { type: 'section', title: r.title } : r.item,
        );
        const itemActions = rows.flatMap((r) => (r.kind === 'item' ? [r.action] : []));

        const signal1 = createMenuSignal();
        let topResult: SelectResult;
        try {
          topResult = await selectFromMenu(rl, topEntries, { title: 'Agent Options' }, signal1);
        } finally {
          clearMenuSignal();
        }

        if (!topResult.cancelled) {
          const action = itemActions[topResult.index];
          if (action) await action();
        }
        console.log();
        void prompt();
        return;
      }

      if (trimmed === '/task' || trimmed.startsWith('/task ')) {
        const taskDescription = trimmed.slice('/task'.length).trim();
        if (!taskDescription) {
          printError('Usage: /task <description>');
          printInfo('  Example: /task List all .ts files in the src directory');
          void prompt();
          return;
        }

        await executeTask(taskDescription);
        console.log();
        void prompt();
        return;
      }

      if (trimmed === '/image' || trimmed.startsWith('/image ')) {
        const args = trimmed.slice('/image'.length).trim();
        if (!args) {
          printError('Usage: /image <path> [prompt]');
          printInfo('  Example: /image ~/screenshot.png What is on the screen?');
          printInfo(
            '  Tip: you can also paste image paths inline, e.g. "describe ~/screenshot.png"',
          );
          void prompt();
          return;
        }

        let imagePath: string;
        let userText: string;
        const quoteMatch = args.match(/^(["'])(.+?)\1(?:\s+(.*))?$/);
        if (quoteMatch) {
          imagePath = quoteMatch[2];
          userText = quoteMatch[3]?.trim() || 'Describe this image.';
        } else {
          const spaceIdx = args.indexOf(' ');
          imagePath = spaceIdx === -1 ? args : args.slice(0, spaceIdx);
          userText =
            spaceIdx === -1
              ? 'Describe this image.'
              : args.slice(spaceIdx + 1).trim() || 'Describe this image.';
        }

        if (!isVisionCapableModel(config.provider, config.model)) {
          printError(
            `Model "${config.model}" does not support image input. Switch to a vision-capable model with /model.`,
          );
          void prompt();
          return;
        }

        let attachment: ImageAttachment;
        try {
          attachment = loadImage(imagePath);
        } catch (err: unknown) {
          printError(err instanceof Error ? err.message : String(err));
          void prompt();
          return;
        }

        printInfo(`  Attaching image: ${attachment.path}`);
        printInfo(`  Image will be sent to ${config.provider}/${config.model}`);

        processing = true;
        interrupted = false;
        try {
          initSpinner();
          await agent.processInput(userText, [attachment]);
          historyStore.save(agent.getHistory());
        } catch (err: unknown) {
          if (!interrupted) {
            printError(err instanceof Error ? err.message : String(err));
          }
        } finally {
          processing = false;
          stopSpinner();
        }

        if (interrupted) {
          printInfo('Interrupted.');
          interrupted = false;
        }

        console.log();
        void prompt();
        return;
      }

      // Dynamic routine invocation: /{routine-id} [args...]
      {
        const parts = trimmed.slice(1).split(/\s+/);
        const routineId = parts[0];
        const routine = routineStore.get(routineId);
        if (routine) {
          const args = parts.slice(1).join(' ');

          // Task-prefixed routines run through single-step task executor
          if (routineId.startsWith('task-')) {
            await executeTask(routine.content, args || undefined);
            console.log();
            void prompt();
            return;
          }

          // Regular routines run through the full agent loop
          let message = `Execute routine "${routine.name}" (/${routine.id}):\n${routine.description}\n\n## Routine Steps\n${routine.content}`;
          if (args) {
            message += `\n\n## Additional Context\n${args}`;
          }
          message +=
            "\n\nFollow this routine intelligently — adapt to the current situation, skip steps that don't apply, and explain any deviations.";

          processing = true;
          interrupted = false;
          try {
            initSpinner();
            await agent.processInput(message);
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

          console.log();
          void prompt();
          return;
        }
      }
    } // end slash command handling

    let inlineImages: ImageAttachment[] | undefined;
    const candidatePaths = extractImagePaths(trimmed);
    if (candidatePaths.length > 0) {
      if (isVisionCapableModel(config.provider, config.model)) {
        const loaded: ImageAttachment[] = [];
        for (const p of candidatePaths) {
          const img = tryLoadImage(p);
          if (img) loaded.push(img);
        }
        if (loaded.length > 0) {
          for (const img of loaded) {
            printInfo(`  Attaching image: ${img.path}`);
          }
          inlineImages = loaded;
        }
      } else {
        printWarning(
          `Image(s) detected but model "${config.model}" does not support vision. Sending as text only.`,
        );
      }
    }

    const resolvedEntries = await runReferenceResolver(trimmed);
    const rewritten = await runPromptRewriter(trimmed, resolvedEntries);
    const agentInput = rewritten ?? trimmed;

    processing = true;
    interrupted = false;
    try {
      initSpinner();
      await agent.processInput(agentInput, inlineImages, resolvedEntries);
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

    // Offer to double the loop limit when the agent exhausts its step budget
    const stepHit = agent.getStepLimitHit();
    if (stepHit) {
      const doubled = stepHit.currentLimit * 2;
      const hint = stepHit.hitCount >= 2 ? ' (Tip: /options max-steps to set permanently)' : '';
      rl.question(
        getTheme().warning(`Double to ${doubled} for this session?${hint} (y/N): `),
        (answer) => {
          if (answer.trim().toLowerCase() === 'y') {
            config.maxSteps = doubled;
            printInfo(`Loop limit doubled to ${doubled} for this session.`);
          }
          console.log();
          void prompt();
        },
      );
      return;
    }

    console.log(); // blank line between turns
    void prompt();
  };

  // Handle Ctrl+C gracefully
  rl.on('close', () => {
    printInfo('\nGoodbye!');
    void cleanup()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });

  void prompt();
}
