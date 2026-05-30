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
import { runReferenceLookup } from './reference-tool-lookup.js';
import { createWebReadTool } from './tools/web.js';
import { createWebSearchTool } from './tools/web-search.js';
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
  setPinnedRegion,
  clearPinnedRegion,
  type SpinnerStats,
} from './output.js';
import type { ToolOptions, AskUserQuestion } from './tools/types.js';
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
  saveProviderKey,
  type BernardConfig,
} from './config.js';
import {
  loadCustomProviders,
  saveCustomProvider,
  rememberCustomModel,
  validateProviderName,
  validateBaseURL,
  SUPPORTED_SDKS,
  type CustomProvider,
} from './custom-providers.js';
import type { SupportedSdk } from './providers/types.js';
import { getTheme, setTheme, getThemeKeys, getActiveThemeKey, THEMES } from './theme.js';
import type { SourceItem } from './provenance.js';
import { interactiveUpdate, getLocalVersion } from './update.js';
import { CronStore } from './cron/store.js';
import { isDaemonRunning } from './cron/client.js';
import { HistoryStore } from './history.js';
import { generateText } from 'ai';
import { getModelProfile } from './providers/index.js';
import { resolveSiteModel } from './model-policy.js';
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
import { classifyError } from './error-taxonomy.js';
import { CandidateStore } from './specialist-candidates.js';
import { assembleContext } from './framework/context.js';
import {
  bootstrapPendingCandidates,
  buildCandidateContextBlock,
  promoteCandidate,
  promotePendingCandidates,
} from './candidate-bootstrap.js';
import { detectSpecialistCandidate } from './specialist-detector.js';
import { taskDefinition } from './tools/task.js';
import { runDefinition } from './framework/agents/run.js';
import type { TaskInput } from './framework/agents/task.js';
import { acquireSlot, releaseSlot, MAX_CONCURRENT_AGENTS } from './tools/agent-pool.js';
import { printTaskStart, printTaskEnd, printWarning, setToolDetailsVisible } from './output.js';
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
    { command: '/policy', description: 'Show last policy decision and reason codes' },
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
    // Show the coordinator-mode indicator only when the user has pinned it.
    // `'auto'` is the default and stays unmarked \u2014 the qualifier decides per
    // turn so a persistent prompt prefix would be misleading.
    const reactLabel = config.coordinatorMode === 'on' ? `${ansi.prompt}\u25B7${ansi.reset} ` : '';
    return `${reactLabel}${ansi.prompt}bernard>${ansi.reset} `;
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
    key: 'toolDetails' | 'promptRewriter' | 'autoCreateSpecialists' | 'conciseMode',
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
    console.log(t.muted(`    Coordinator mode: ${config.coordinatorMode}`));
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

  function persistReference(reference: string, value: string, store: MemoryStore): ResolvedEntry {
    const baseKey = deriveKeyFromReference(reference) || 'entity';
    const existing = new Set(store.listMemory());
    let key = baseKey;
    let suffix = 2;
    while (existing.has(key)) {
      key = `${baseKey}-${suffix++}`;
    }
    store.writeMemory(key, value);
    printInfo(`  Saved as memory: ${key}`);
    return { phrase: reference, resolvedTo: value, sourceKey: key };
  }

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
      return { entry: persistReference(reference, result.raw, store) };
    } finally {
      clearMenuSignal();
    }
  }

  // User confirmation is mandatory — the resolver lookup is a hint, not a fact,
  // and may have matched the wrong person.
  async function promptToolLookupConfirmation(
    reference: string,
    resolvedTo: string,
    toolName: string,
    store: MemoryStore,
  ): Promise<UnknownReferenceOutcome> {
    printInfo(
      `\n  Lookup via ${toolName} found a possible match for "${reference}":\n  → ${resolvedTo}`,
    );
    console.log();
    const SAVE = 0;
    const EDIT = 1;
    const SKIP = 2;
    const entries: MenuEntry[] = [
      { label: 'Save as memory', description: resolvedTo },
      { label: 'Edit before saving' },
      { label: 'Skip (do not resolve)' },
    ];
    const signal = createMenuSignal();
    try {
      const result = await selectFromMenu(
        rl,
        entries,
        { title: `Save lookup result for "${reference}"?`, promptLabel: 'Choose' },
        signal,
      );
      if (result.cancelled || result.index === SKIP) return { entry: null };

      let value = resolvedTo;
      if (result.index === EDIT) {
        const edited = await promptValue(rl, { label: `"${reference}" is` }, signal);
        if (edited.cancelled || !edited.raw.trim()) return { entry: null };
        value = edited.raw;
      } else if (result.index !== SAVE) {
        return { entry: null };
      }

      return { entry: persistReference(reference, value, store) };
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
        // Try a read-only tool lookup before falling back to asking the user.
        // Fail-open at every layer: any error or `none` drops through to the
        // existing free-form prompt.
        let lookupHandled = false;
        if (config.referenceLookup) {
          const lookupSignal = createMenuSignal();
          startSpinner();
          let lookup;
          try {
            lookup = await runReferenceLookup(
              resolveResult.reference,
              lookupTools,
              config,
              lookupSignal,
            );
          } finally {
            stopSpinner();
            clearMenuSignal();
          }
          if (lookup.status === 'found') {
            const outcome = await promptToolLookupConfirmation(
              resolveResult.reference,
              lookup.resolvedTo,
              lookup.toolName,
              memoryStore,
            );
            if (outcome.entry) entries = [outcome.entry];
            lookupHandled = true;
          }
        }
        if (!lookupHandled) {
          const outcome = await promptUnknownReference(resolveResult.reference, memoryStore);
          if (outcome.entry) entries = [outcome.entry];
        }
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
      const profile = getModelProfile(
        config.provider,
        config.model,
        config.customProviders?.[config.provider]?.sdk,
      );
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

  /**
   * Shift+Tab toggles the sources viewer for the last response. Issue #173.
   *
   * `\x1b[Z` is the canonical Shift+Tab CSI; Node's readline usually emits
   * `{ name: 'tab', shift: true }` for it but a few terminals deliver the
   * raw sequence without the shift flag — we check both.
   *
   * The first press pins a `<sources>` region above the prompt; the second
   * press clears it. Esc also clears (handled by an existing escape branch).
   * If the last turn registered no citations, the keystroke is a no-op.
   */
  let sourcesViewerOpen = false;
  function buildSourcesPanel(sources: SourceItem[], title: string): string[] {
    const t = getTheme();
    const lines: string[] = [];
    lines.push(t.accentBold(`▼ ${title}`));
    for (const s of sources) {
      const head = `${t.accent(`[^${s.id}]`)} ${t.dim(`(${s.kind})`)} ${s.label}`;
      lines.push(head);
      if (s.rawRef && s.rawRef !== s.label) {
        lines.push(`    ${t.dim(s.rawRef)}`);
      }
      if (s.contentPreview) {
        const preview = s.contentPreview.replace(/\s+/g, ' ').slice(0, 160);
        lines.push(`    ${t.dim(preview)}`);
      }
    }
    lines.push(t.dim('Shift+Tab or Esc to close'));
    return lines;
  }
  function renderSourcesViewer(): void {
    const cited = agent.getLastCitedSources();
    if (cited.length === 0) {
      // No cited sources — fall back to "all available" if any, so the user
      // can still see what was retrieved this turn.
      const all = agent.getLastSources();
      if (all.length === 0) {
        sourcesViewerOpen = false;
        return;
      }
      setPinnedRegion(
        'sources',
        buildSourcesPanel(all, 'Available sources (last turn — none cited)'),
      );
      sourcesViewerOpen = true;
      return;
    }
    setPinnedRegion('sources', buildSourcesPanel(cited, 'Cited sources (last response)'));
    sourcesViewerOpen = true;
  }
  function closeSourcesViewer(): void {
    if (!sourcesViewerOpen) return;
    clearPinnedRegion('sources');
    sourcesViewerOpen = false;
  }

  process.stdin.on('keypress', (_str: string, key: any) => {
    if (!key) return;

    // Shift+Tab → toggle the sources viewer. Check first so Esc/processing
    // branches below don't intercept it.
    const isShiftTab = (key.name === 'tab' && key.shift) || key.sequence === '\x1b[Z';
    if (isShiftTab && !processing && !menuAbortController) {
      if (sourcesViewerOpen) closeSourcesViewer();
      else renderSourcesViewer();
      return;
    }

    if (key.name === 'escape' && menuAbortController) {
      menuAbortController.abort();
      return;
    }

    if (key.name === 'escape' && sourcesViewerOpen && !processing) {
      closeSourcesViewer();
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

  // Tool registry exposed to the resolver's pre-fallback lookup pass. Limited
  // to read-only network tools + MCP tools so a slow or write-side tool can't
  // be selected. The lookup module further filters via `isAllowedLookupTool`.
  const lookupTools: Record<string, any> = {
    web_search: createWebSearchTool(),
    web_read: createWebReadTool(),
    ...mcpTools,
  };

  // The thinking-spinner repaints stdout every 80 ms and would blank any
  // interactive prompt, so callers that need to talk to the user must run
  // through this helper to stop the spinner first and restart it after.
  const withPausedSpinner = async <T>(
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> => {
    stopSpinner();
    try {
      return await fn();
    } finally {
      // Skip restart when the turn is over or aborted — nothing left to think about.
      if (processing && !signal?.aborted) {
        resumeSpinner();
      }
    }
  };

  const confirmFn = (command: string, signal?: AbortSignal): Promise<boolean> =>
    withPausedSpinner(signal, async () => {
      const result = await selectFromMenu(
        rl,
        [{ label: 'Allow once' }, { label: 'Cancel' }],
        { title: `⚠ Dangerous command: ${command}` },
        signal,
      );
      return !result.cancelled && result.index === 0;
    });

  const renderTabStrip = (currentIndex: number, total: number): string => {
    const theme = getTheme();
    const tabs: string[] = [];
    for (let i = 0; i < total; i++) {
      const num = String(i + 1);
      if (i < currentIndex) tabs.push(theme.success(`${num} ✓`));
      else if (i === currentIndex) tabs.push(theme.accentBold(`▸${num}◂`));
      else tabs.push(theme.dim(num));
    }
    return '  ' + tabs.join('   ');
  };

  const askSingleQuestion = async (
    q: AskUserQuestion,
    headerLines: string[] | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string | null> => {
    if (!q.choices || q.choices.length === 0) {
      const r = await promptValue(rl, { label: q.question, headerLines }, signal);
      return r.cancelled ? null : r.raw;
    }
    const entries = q.choices.map((label) => ({ label }));
    if (q.allowOther) entries.push({ label: q.otherLabel ?? 'Other (type a custom answer)' });
    const r = await selectFromMenu(rl, entries, { title: q.question, headerLines }, signal);
    if (r.cancelled) return null;
    if (q.allowOther && r.index === q.choices.length) {
      const free = await promptValue(rl, { label: q.question, headerLines }, signal);
      return free.cancelled ? null : free.raw;
    }
    return q.choices[r.index];
  };

  const askUserFn: NonNullable<ToolOptions['askUser']> = (questions, signal) =>
    withPausedSpinner(signal, async () => {
      const answered: string[] = [];
      const showTabs = questions.length > 1;
      for (let i = 0; i < questions.length; i++) {
        const headerLines = showTabs ? [renderTabStrip(i, questions.length)] : undefined;
        const answer = await askSingleQuestion(questions[i], headerLines, signal);
        if (answer === null) return { cancelled: true, answered };
        answered.push(answer);
      }
      return { answers: answered };
    });

  const toolOptions: ToolOptions = {
    shellTimeout: config.shellTimeout,
    confirmDangerous: confirmFn,
    askUser: askUserFn,
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

  const { pending: pendingCandidates, contextBlock } = bootstrapPendingCandidates(
    candidateStore,
    specialistStore,
    config,
    config,
  );
  if (contextBlock) {
    printInfo(
      `  ${pendingCandidates.length} specialist suggestion(s) pending. Use /candidates to review.`,
    );
    alertContext = alertContext ? alertContext + '\n\n' + contextBlock : contextBlock;
  }

  const agentCtx = assembleContext({
    config,
    toolOptions,
    mcp: { tools: mcpTools, serverNames: mcpServerNames },
    rag: ragStore,
    stores: {
      memory: memoryStore,
      routines: routineStore,
      specialists: specialistStore,
      candidates: candidateStore,
    },
  });
  const agent = new Agent(agentCtx, { alertContext, initialHistory });

  // Drain the correction-candidate backlog of non-correctable failures
  // (HTTP 404, rate limits, pool exhaustion, etc.) before the agent runs.
  // Best-effort, idempotent — only touches `status: 'pending'` rows.
  if (config.correctionEnabled) {
    try {
      const dismissed = agent.getCorrectionStore().dismissNonCorrectable(classifyError, {
        toolNameFor: (candidate) => {
          const specialist = specialistStore.get(candidate.specialistId);
          const tools = specialist?.targetTools ?? [];
          if (tools.length > 0) return tools;
          // Specialist was deleted between enqueue and now. Try to recover a
          // useful toolName from the error text so we don't dismiss what was
          // actually a learnable shell mistake.
          if (/command not found|no such file or directory/i.test(candidate.error)) {
            return ['shell'];
          }
          return [];
        },
      });
      if (dismissed > 0) {
        printInfo(`Dismissed ${dismissed} non-correctable correction candidate(s).`);
      }
    } catch (err) {
      debugLog('correction:dismiss-error', err instanceof Error ? err.message : String(err));
    }
  }

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
          // Read the live ctx off the agent so the correction pass sees
          // the latest policyDecision and any other per-turn refinements
          // made by `processInput`; `agentCtx` is the startup snapshot.
          const result = await runCorrectionAgent({ ctx: agent.getContext() }, pending);
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

  // Tracks the SpinnerStats for the in-flight turn so resumeSpinner() can
  // re-attach the spinner after a pause (e.g. an ask_user prompt) without
  // resetting startTime or the running token totals.
  let activeSpinnerStats: SpinnerStats | null = null;

  function initSpinner(): void {
    const spinnerStats: SpinnerStats = {
      startTime: Date.now(),
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      latestPromptTokens: 0,
      model: config.model,
      contextWindowOverride: config.tokenWindow || undefined,
    };
    activeSpinnerStats = spinnerStats;
    agent.setSpinnerStats(spinnerStats);
    startSpinner(() => buildSpinnerMessage(spinnerStats));
  }

  function resumeSpinner(): void {
    const stats = activeSpinnerStats;
    if (!stats) {
      initSpinner();
      return;
    }
    startSpinner(() => buildSpinnerMessage(stats));
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

    const slot = acquireSlot();
    if (!slot) {
      processing = false;
      taskAbortController = null;
      printError(`Maximum concurrent agents (${MAX_CONCURRENT_AGENTS}) reached.`);
      return;
    }

    printTaskStart(description);
    startSpinner('Running task...');

    // Provenance is per-turn (cleared at processInput entry). /task runs
    // outside processInput, so clear here to isolate its citations from the
    // last main-agent turn and from any prior /task in the same prompt.
    const ctx = agent.getContext();
    ctx.provenance.clear();

    try {
      const input: TaskInput = context
        ? { task: description, context, slotId: slot.id }
        : { task: description, slotId: slot.id };
      const { result, formatted: taskResult } = await runDefinition(ctx, taskDefinition, input, {
        abortSignal: taskAbortController.signal,
      });

      if (result.finishReason === 'length') {
        const recommended = Math.ceil((config.maxTokens * 2) / 1024) * 1024;
        printWarning(
          `Task response was truncated (hit ${config.maxTokens} token limit). ` +
            `Consider increasing: /options max-tokens ${recommended}`,
        );
      }

      stopSpinner();
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
      if (interrupted) {
        printTaskEnd(JSON.stringify({ status: 'cancelled', output: 'interrupted' }));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        printTaskEnd(JSON.stringify({ status: 'error', output: message }));
        printError(message);
      }
    } finally {
      releaseSlot();
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

              const summarySite = resolveSiteModel(config, 'compressor');
              const [summaryResult, domainFacts, candidateResult] = await Promise.all([
                generateText({
                  model: summarySite.model,
                  providerOptions: summarySite.providerOptions,
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
                        config,
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
        printWelcome(
          config.provider,
          config.model,
          getLocalVersion(),
          config.providerBaseUrl ?? config.customProviders?.[config.provider]?.baseURL,
        );
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

      if (trimmed === '/policy') {
        const last = agent.getLastPolicyDecision();
        if (!last) {
          printInfo('No policy decision yet — send a message first.');
        } else {
          printInfo('Last policy decision:');
          printInfo(JSON.stringify(last.decision, null, 2));
          printInfo('Reason codes:');
          for (const [key, reason] of Object.entries(last.reasons)) {
            printInfo(`  ${key}: ${reason}`);
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
        const customProviders = config.customProviders ?? {};
        const builtinAvailable = available.filter((p) => !customProviders[p]);
        const customAvailable = available.filter((p) => customProviders[p]);

        const entries: MenuEntry[] = [];
        for (const p of builtinAvailable) entries.push({ label: p, value: p });
        if (customAvailable.length > 0) {
          entries.push({ type: 'section', title: 'Custom:' });
          for (const p of customAvailable) {
            const entry = customProviders[p];
            entries.push({
              label: p,
              annotation: `(${entry.sdk} → ${entry.baseURL})`,
              value: p,
            });
          }
        }
        if (builtinAvailable.length === 0 && customAvailable.length === 0) {
          printInfo('No providers have API keys configured yet — add one below.');
        }
        entries.push({ type: 'section', title: '' });
        entries.push({ label: '+ Add custom provider…', value: '__add__' });

        const signal = createMenuSignal();
        try {
          const result = await selectFromMenu(
            rl,
            entries,
            { title: `Providers — current: ${config.provider} (${config.model})` },
            signal,
          );
          if (!result.cancelled) {
            const value = result.item.value as string;
            if (value === '__add__') {
              const added = await runAddProviderWizard(rl, createMenuSignal, clearMenuSignal);
              if (added) {
                config.customProviders = {
                  ...customProviders,
                  [added.entry.name]: added.entry,
                };
                config.apiKeys = { ...(config.apiKeys ?? {}), [added.entry.name]: added.apiKey };
                config.provider = added.entry.name;
                config.model = added.entry.defaultModel;
                // Drop any session-scoped --provider-base-url override: a custom
                // provider already defines its own baseURL, and re-applying the
                // CLI override to a different provider would mis-route traffic.
                config.providerBaseUrl = undefined;
                savePreferences({
                  provider: config.provider,
                  model: config.model,
                  maxTokens: config.maxTokens,
                  shellTimeout: config.shellTimeout,
                  tokenWindow: config.tokenWindow,
                  theme: config.theme,
                });
                printInfo(
                  `  Added and switched to ${added.entry.name} (${added.entry.defaultModel})`,
                );
              }
            } else {
              config.provider = value;
              config.model = getDefaultModel(config.provider, customProviders);
              // Drop the session-scoped --provider-base-url override. It was tied
              // to whichever provider was active at launch; silently re-applying
              // it to a different built-in (e.g. openai gateway → anthropic)
              // would route Anthropic traffic through an OpenAI endpoint.
              config.providerBaseUrl = undefined;
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
          }
        } finally {
          clearMenuSignal();
        }
        console.log();
        void prompt();
        return;
      }

      if (trimmed === '/model') {
        const customProviders = config.customProviders ?? {};
        const customEntry = customProviders[config.provider];
        const models = customEntry ? customEntry.models : PROVIDER_MODELS[config.provider];

        if (!models || models.length === 0) {
          printError(`No models listed for provider "${config.provider}".`);
          void prompt();
          return;
        }
        const entries: MenuEntry[] = models.map((m) => ({ label: m, value: m }));
        if (customEntry) {
          entries.push({ type: 'section', title: '' });
          entries.push({ label: '+ Type a new model name…', value: '__free__' });
        }
        const signal = createMenuSignal();
        try {
          const result = await selectFromMenu(
            rl,
            entries,
            { title: `Models — current: ${config.provider} / ${config.model}` },
            signal,
          );
          if (!result.cancelled) {
            const value = result.item.value as string;
            let chosenModel: string | null = null;
            if (value === '__free__' && customEntry) {
              const valueResult = await promptValue(
                rl,
                { label: 'Model name' },
                createMenuSignal(),
              );
              clearMenuSignal();
              if (!valueResult.cancelled) {
                const newModel = valueResult.raw.trim();
                if (newModel) {
                  rememberCustomModel(config.provider, newModel);
                  // Refresh local copy
                  config.customProviders = loadCustomProviders();
                  chosenModel = newModel;
                }
              }
            } else {
              chosenModel = value;
            }
            if (chosenModel) {
              config.model = chosenModel;
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
          agent.setAlertContext(buildCandidateContextBlock(pending));
        }
        void prompt();
        return;
      }

      // Backwards-compat shims: the standalone toggles (/react, /tool-details, /debug)
      // were consolidated into /agent-options and /options. Print a short pointer so users typing
      // the old command aren't silently dropped into the prompt.
      const legacyToggle = {
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
          key: 'autoCreateSpecialists' | 'promptRewriter' | 'toolDetails' | 'conciseMode';
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
                  config,
                );
              }
            },
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
          {
            key: 'conciseMode',
            label: 'Concise mode',
            description:
              'Default responses to the smallest sufficient size; expand only when asked or when the task needs length.',
            onMsg:
              '  [CONCISE:ON] Responses will be short by default; the model expands only when asked or when the task needs length.',
            offMsg:
              '  [CONCISE:OFF] Concision heuristic disabled; responses follow the base prompt without per-turn shaping.',
          },
        ];

        async function runCoordinatorModePrompt(): Promise<void> {
          const modes: Array<{ value: 'on' | 'off' | 'auto'; label: string; desc: string }> = [
            {
              value: 'auto',
              label: 'Auto (qualifier picks per turn)',
              desc: 'Classifier inspects each ask and chooses Normal or ReAct.',
            },
            {
              value: 'on',
              label: 'On (always coordinator)',
              desc: 'Every turn runs ReAct with plan tool + enforcement.',
            },
            {
              value: 'off',
              label: 'Off (always normal)',
              desc: 'Every turn runs single-shot Normal strategy.',
            },
          ];
          const entries: MenuEntry[] = modes.map((m) => ({
            label: m.label,
            description: m.desc,
            active: config.coordinatorMode === m.value,
          }));
          const signal = createMenuSignal();
          try {
            const result = await selectFromMenu(
              rl,
              entries,
              { title: `Coordinator mode: ${config.coordinatorMode.toUpperCase()}` },
              signal,
            );
            if (result.cancelled) return;
            const chosen = modes[result.index].value;
            config.coordinatorMode = chosen;
            savePreferences({
              ...loadPreferences(),
              provider: config.provider,
              model: config.model,
              coordinatorMode: chosen,
            });
            const labels: Record<typeof chosen, string> = {
              on: '  [COORDINATOR:ON] Every turn runs ReAct.',
              off: '  [COORDINATOR:OFF] Every turn runs Normal.',
              auto: '  [COORDINATOR:AUTO] Qualifier picks Normal or ReAct per turn.',
            };
            printInfo(labels[chosen]);
          } finally {
            clearMenuSignal();
          }
          console.log();
        }

        async function runModelModePrompt(): Promise<void> {
          const modes: Array<{
            value: 'off' | 'optimize-tokens' | 'balanced' | 'optimize-performance';
            label: string;
            desc: string;
          }> = [
            {
              value: 'off',
              label: 'Off (single model)',
              desc: 'Every site uses the active provider/model. Legacy behavior.',
            },
            {
              value: 'balanced',
              label: 'Balanced',
              desc: 'Premium for main; mid-tier for sub-agents; cheap for rewriter/qualifier.',
            },
            {
              value: 'optimize-tokens',
              label: 'Optimize for token usage',
              desc: 'Aggressive cost-saving: cheap for sub-agents and routing, mid-tier for main.',
            },
            {
              value: 'optimize-performance',
              label: 'Optimize for performance',
              desc: 'Push every site to the strongest model in the provider lineup.',
            },
          ];
          const entries: MenuEntry[] = modes.map((m) => ({
            label: m.label,
            description: m.desc,
            active: config.modelMode === m.value,
          }));
          const signal = createMenuSignal();
          try {
            const result = await selectFromMenu(
              rl,
              entries,
              { title: `Model mode: ${config.modelMode}` },
              signal,
            );
            if (result.cancelled) return;
            const chosen = modes[result.index].value;
            config.modelMode = chosen;
            savePreferences({
              ...loadPreferences(),
              provider: config.provider,
              model: config.model,
              modelMode: chosen,
            });
            printInfo(`  [MODEL-MODE:${chosen.toUpperCase()}] Site model assignment updated.`);
          } finally {
            clearMenuSignal();
          }
          console.log();
        }

        async function runScratchThresholdPrompt(): Promise<void> {
          const signal = createMenuSignal();
          try {
            const val = await promptValue(
              rl,
              { label: 'New subject-change threshold (0-1, e.g. 0.15)' },
              signal,
            );
            if (val.cancelled) return;
            const parsed = parseFloat(val.raw);
            if (isNaN(parsed) || parsed < 0 || parsed > 1) {
              printError('Threshold must be a number between 0 and 1 (e.g. 0.15)');
              return;
            }
            config.scratchSubjectThreshold = parsed;
            savePreferences({
              ...loadPreferences(),
              scratchSubjectThreshold: parsed,
              provider: config.provider,
              model: config.model,
            });
            printInfo(`  Scratch subject-change threshold: ${parsed}`);
          } finally {
            clearMenuSignal();
          }
        }

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
              promotePendingCandidates(
                candidateStore,
                specialistStore,
                config.autoCreateThreshold,
                config,
              );
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
          {
            kind: 'item',
            item: {
              label: 'Coordinator (ReAct) mode',
              annotation: `= ${config.coordinatorMode}`,
              description:
                'On = always coordinator; Off = always normal; Auto = per-turn qualifier.',
            },
            action: runCoordinatorModePrompt,
          },
          {
            kind: 'item',
            item: {
              label: 'Model mode',
              annotation: `= ${config.modelMode}`,
              description:
                'Off = single model. Balanced / Optimize-tokens / Optimize-performance pick a model per site.',
            },
            action: runModelModePrompt,
          },
          ...systemBools.slice(1).map(toggleRow),
          {
            kind: 'item',
            item: {
              label: 'Scratch subject-change threshold',
              annotation: `= ${config.scratchSubjectThreshold}`,
              description:
                'Jaccard similarity (0-1) below which a new turn clears all scratch. Lower = more conservative.',
            },
            action: runScratchThresholdPrompt,
          },
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
    // A new turn invalidates any pinned sources viewer from the previous one.
    closeSourcesViewer();
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

/**
 * Interactive wizard for adding a custom provider from `/provider`.
 * Returns the saved entry plus the freshly entered API key on success
 * (so the caller can update the live `config.apiKeys` map without
 * re-reading from disk), or `null` on cancel/error.
 */
async function runAddProviderWizard(
  rl: readline.Interface,
  createMenuSignal: () => AbortSignal,
  clearMenuSignal: () => void,
): Promise<{ entry: CustomProvider; apiKey: string } | null> {
  printInfo('\nAdd custom provider — follows the same SDK contract as built-ins.');

  // 1. SDK choice
  const sdkEntries: MenuEntry[] = SUPPORTED_SDKS.map((s) => ({ label: s, value: s }));
  let sdkResult: SelectResult;
  let sig = createMenuSignal();
  try {
    sdkResult = await selectFromMenu(rl, sdkEntries, { title: 'Which SDK to use?' }, sig);
  } finally {
    clearMenuSignal();
  }
  if (sdkResult.cancelled) return null;
  const sdk = sdkResult.item.value as SupportedSdk;

  // 2. Name
  sig = createMenuSignal();
  let nameResult: ValueResult;
  try {
    nameResult = await promptValue(rl, { label: 'Provider name (lowercase, e.g. "ollama")' }, sig);
  } finally {
    clearMenuSignal();
  }
  if (nameResult.cancelled) return null;
  const name = nameResult.raw.trim();
  const nameErr = validateProviderName(name);
  if (nameErr) {
    printError(nameErr);
    return null;
  }

  // 3. Base URL
  sig = createMenuSignal();
  let urlResult: ValueResult;
  try {
    urlResult = await promptValue(rl, { label: 'Base URL (e.g. http://localhost:11434/v1)' }, sig);
  } finally {
    clearMenuSignal();
  }
  if (urlResult.cancelled) return null;
  const baseURL = urlResult.raw.trim();
  const urlErr = validateBaseURL(baseURL);
  if (urlErr) {
    printError(urlErr);
    return null;
  }

  // 4. Default model
  sig = createMenuSignal();
  let modelResult: ValueResult;
  try {
    modelResult = await promptValue(rl, { label: 'Default model name' }, sig);
  } finally {
    clearMenuSignal();
  }
  if (modelResult.cancelled) return null;
  const defaultModel = modelResult.raw.trim();
  if (!defaultModel) {
    printError('Default model cannot be empty.');
    return null;
  }

  // 5. API key
  sig = createMenuSignal();
  let keyResult: ValueResult;
  try {
    keyResult = await promptValue(
      rl,
      { label: 'API key (any non-empty token; some local servers ignore the value)' },
      sig,
    );
  } finally {
    clearMenuSignal();
  }
  if (keyResult.cancelled) return null;
  const apiKey = keyResult.raw.trim();
  if (!apiKey) {
    printError('API key cannot be empty.');
    return null;
  }

  try {
    const entry = saveCustomProvider({ name, sdk, baseURL, defaultModel });
    saveProviderKey(name, apiKey);
    return { entry, apiKey };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    printError(message);
    return null;
  }
}
