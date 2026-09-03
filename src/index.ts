#!/usr/bin/env node

/**
 * @module index
 * CLI entry point for Bernard. Defines all Commander commands and
 * dispatches to the interactive REPL or the appropriate sub-command handler.
 */

import { Command } from 'commander';
import * as readline from 'node:readline';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as childProcess from 'node:child_process';
import { createElement } from 'react';
import { render } from 'ink';
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
  providerEnvVar,
  normalizeMaxConcurrentAgents,
  getAvailableProviders,
  resolveVoiceWarmupMs,
} from './config.js';
import { normalizeStoredModelMode } from './model-policy.js';
import { loadLineups, resolveActiveLineup, resolveActiveLineupWithCorrection } from './lineups.js';
import { validateLineup, formatLineupValidation } from './model-validate.js';
import { setMaxConcurrentAgents, MAX_CONCURRENT_AGENTS_LIMIT } from './tools/agent-pool.js';
import {
  loadCustomProviders,
  saveCustomProvider,
  removeCustomProvider,
} from './custom-providers.js';
import type { SupportedSdk } from './providers/types.js';
import { printWelcome, buildWelcomeLines, printError, printInfo } from './output.js';
import {
  listTelemetrySessions,
  readSessionTelemetry,
  aggregateRecords,
  formatSessionUsageLines,
} from './session-telemetry.js';
import {
  resolveBackend,
  resolveWarmupPlayer,
  VoiceService,
  type VoiceBackend,
} from './voice-service.js';
import { toLiteralSpeech } from './speech-text.js';
import { setTheme, DEFAULT_THEME } from './theme.js';
import { CronStore } from './cron/store.js';
import {
  cronList,
  cronRun,
  cronGrant,
  cronDelete,
  cronDeleteAll,
  cronStop,
  cronBounce,
} from './cron/cli.js';
import type { ScriptCliOptions } from './script/run.js';
import { listMCPServers, removeMCPServer, MCPManager, setActiveMCPManager } from './mcp.js';
import { ToolProfileStore } from './tool-profiles.js';
import { runFirstTimeSetup } from './setup.js';
import { getLocalVersion, startupUpdateCheck, interactiveUpdate } from './update.js';
import { factsList, factsSearch, clearFacts } from './facts-cli.js';
import { migrateFromLegacy } from './migrate.js';
import { MCP_CONFIG_PATH, PROFILES_PATH, PREFS_PATH, RAG_DIR } from './paths.js';
import * as fs from 'node:fs';
import { listProfiles } from './profiles.js';
import { MemoryStore } from './memory.js';
import { serializeMessages, MIN_HISTORY_FOR_FACTS } from './context.js';
import { RAGStore } from './rag.js';
import { RoutineStore } from './routines.js';
import { SpecialistStore } from './specialists.js';
import { CandidateStore } from './specialist-candidates.js';
import { HistoryStore } from './history.js';
import { ProvenanceHistoryStore } from './provenance-history.js';
import { TurnContextStore } from './turn-context.js';
import { assembleContext } from './framework/context.js';
import { Agent } from './agent.js';
import { bootstrapPendingCandidates } from './candidate-bootstrap.js';
import { runCorrectionAgent } from './correction.js';
import { debugLog, isDebugEnabled } from './logger.js';
import { installInstrumentedFetchIfDebug } from './framework/instrumented-fetch.js';
import { initShellParser } from './permissions/shell-ast.js';
import { App } from './ui/App.js';
import { DimensionsProvider } from './ui/DimensionsContext.js';
import { withFullScreen } from './ui/withFullScreen.js';
import { getInkHandlers } from './ui/ink-handlers.js';
import type {
  ToolOptions,
  ConfirmActionInput,
  BlockActionInput,
  BlockOutcome,
  AskUserQuestion,
  AskUserBatchResult,
} from './tools/types.js';
import type { CoreMessage } from 'ai';
import {
  SESSION_BOUNDARY_ACK,
  SESSION_BOUNDARY_NOTICE,
  SESSION_BOUNDARY_PREFIX,
} from './session-markers.js';
import { fileURLToPath } from 'node:url';

let signalHandlersInstalled = false;

/**
 * Registers a SIGUSR2 handler that dumps a snapshot of active event-loop
 * resources to the debug log and stderr. Gated on `BERNARD_DEBUG` so prod
 * never carries the listener. Idempotent.
 *
 * Use `kill -USR2 <pid>` to inspect a stuck process: the JSONL line lands
 * in the session log, and the stderr line lands in whatever terminal
 * Bernard is running in.
 */
function installDebugSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  if (!isDebugEnabled()) return;
  process.on('SIGUSR2', () => {
    type ProcessWithInternals = {
      _getActiveHandles?: () => unknown[];
      _getActiveRequests?: () => unknown[];
    };
    const p = process as unknown as ProcessWithInternals;
    const payload = {
      activeHandles: p._getActiveHandles?.().length ?? -1,
      activeRequests: p._getActiveRequests?.().length ?? -1,
      resources: process.getActiveResourcesInfo?.() ?? [],
    };
    debugLog('process:dump', payload);
    try {
      process.stderr.write(`[bernard process:dump] ${JSON.stringify(payload)}\n`);
    } catch {
      // best-effort; the JSONL line is the durable record
    }
  });
  signalHandlersInstalled = true;
}

const program = new Command();

program
  .name('bernard')
  .description('Local CLI AI agent with multi-provider support')
  .version(getLocalVersion())
  .option('-p, --provider <provider>', 'LLM provider (anthropic, openai, xai)')
  .option('-m, --model <model>', 'Model name')
  .option('-r, --resume', 'Resume the previous conversation')
  .option('--alert <id>', 'Open with cron alert context')
  .option('--tool-details', 'Show full tool call args and result output (default: hidden)')
  .option(
    '--allow-provider-base-url',
    'Opt-in flag required to enable --provider-base-url for this session',
  )
  .option(
    '--provider-base-url <url>',
    "Override the active built-in provider's endpoint URL for this session (requires --allow-provider-base-url)",
  )
  .option('--voice', 'Enable text-to-speech readback after each assistant turn')
  .option(
    '--voice-backend <backend>',
    'TTS backend: auto | macos-say | spd-say | espeak-ng | espeak | windows-speech',
  )
  .option('--voice-rate <n>', 'Speech rate in words per minute', parseInt)
  .option(
    '--no-voice-normalize',
    'Speak the literal response text instead of a natural spoken rendering (#432)',
  )
  .action(async (opts) => {
    try {
      // Detect a fresh install BEFORE any module touches preferences/profiles
      // so we can decide whether to offer the onboarding wizard later. Both
      // `profiles.json` and the legacy `preferences.json` must be absent to
      // qualify — an existing prefs file means we're migrating, not onboarding.
      const isFreshInstall = !fs.existsSync(PROFILES_PATH) && !fs.existsSync(PREFS_PATH);

      await runFirstTimeSetup();

      const config = loadConfig({
        provider: opts.provider,
        model: opts.model,
        providerBaseUrl: opts.providerBaseUrl,
        allowProviderBaseUrl: opts.allowProviderBaseUrl,
        voiceTts: opts.voice ? true : undefined,
        voiceBackend: opts.voiceBackend,
        voiceRate: opts.voiceRate,
        // Commander sets a `--no-x` option to `true` when the flag is ABSENT, so
        // this must test `=== false`. A truthiness test would pin the field to
        // the CLI on every run and make the profile setting unreachable.
        voiceNormalizer: opts.voiceNormalize === false ? false : undefined,
      });

      // `loadConfig` runs dotenv, so BERNARD_DEBUG from `.env` is in scope by
      // here. Both helpers are no-ops when debug is off — safe to call
      // unconditionally.
      installInstrumentedFetchIfDebug();
      installDebugSignalHandlers();

      if (opts.toolDetails) config.toolDetails = true;

      if (!setTheme(config.theme)) {
        config.theme = DEFAULT_THEME;
        setTheme(config.theme);
      }

      let alertContext: string | undefined;
      let alertBanner: string | undefined;

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

        alertBanner = `Cron alert: ${alert.jobName} — ${alert.message} (${alert.timestamp})`;
      }

      const prefs = loadPreferences();
      startupUpdateCheck(!!prefs.autoUpdate);

      await runInkRepl({
        config,
        alertContext,
        alertBanner,
        resume: !!opts.resume,
        isFreshInstall: isFreshInstall && !opts.alert && !opts.resume,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

/**
 * Mount the Ink REPL. Replaces the legacy `startRepl()` from `src/repl.ts`.
 *
 * Bootstraps every store the agent and overlays share, builds the
 * `ToolOptions` callbacks as thin shims that forward to the App's
 * overlay-request closures (via `getInkHandlers()`), then renders `<App>`
 * and awaits unmount. The cleanup chain (RAG worker spawn, correction
 * agent, MCP close) runs from `onExit` — invoked by either `/exit` or
 * Ink unmount.
 */
async function runInkRepl(args: {
  config: ReturnType<typeof loadConfig>;
  alertContext?: string;
  alertBanner?: string;
  resume: boolean;
  isFreshInstall: boolean;
}): Promise<void> {
  const { config, resume, isFreshInstall, alertBanner } = args;
  let { alertContext } = args;

  // Decided up-front because it changes how the welcome splash is surfaced: in
  // full-screen the splash can't be printed to the normal screen (the alt
  // buffer hides it), so it's collected and rendered inside the Ink tree.
  const fullScreenActive = config.fullScreen && Boolean(process.stdout.isTTY);
  // Lines rendered at the top of the transcript in full-screen (splash + the
  // notices that would otherwise be printed pre-render and lost).
  const startupLines: string[] = [];
  /**
   * Startup chatter goes to the Ink splash in full-screen (the alt buffer hides
   * anything printed pre-render) and to stdout otherwise. Three sites need the
   * same branch plus the same two-space indent.
   */
  const emitStartupNotice = (text: string): void => {
    if (fullScreenActive) startupLines.push(text);
    else printInfo(`  ${text}`);
  };

  // Kick off the tree-sitter bash parser load (#261) in the background so
  // shell permission rules can match compound commands precisely. Best-effort:
  // until it's ready, the engine falls back to the conservative regex path.
  void initShellParser();

  const memoryStore = new MemoryStore();
  const routineStore = new RoutineStore();
  const specialistStore = new SpecialistStore();
  const candidateStore = new CandidateStore();
  const historyStore = new HistoryStore();
  const provenanceHistoryStore = new ProvenanceHistoryStore();
  const turnContextStore = new TurnContextStore();
  const ragStore = config.ragEnabled ? new RAGStore() : undefined;
  const mcpManager = new MCPManager();

  try {
    await mcpManager.connect();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`MCP initialization failed: ${message}`);
  }
  // Register the live manager so `mcp_verify` can reconcile a fresh probe
  // against the tools actually wired into this session (#healthy-but-not-there).
  setActiveMCPManager(mcpManager);

  const statuses = mcpManager.getServerStatuses();
  const connected = statuses.filter((s) => s.connected);
  const failed = statuses.filter((s) => !s.connected);
  const totalTools = connected.reduce((acc, s) => acc + s.toolCount, 0);

  const mcpSummary =
    statuses.length > 0
      ? { connected: connected.length, failed: failed.length, tools: totalTools }
      : undefined;
  const providers = getAvailableProviders(config);
  const version = getLocalVersion();
  const failedMcpLines = failed.map((s) => `✗ mcp ${s.name}: ${s.error}`);
  if (fullScreenActive) {
    // Collect for in-tree rendering (the alt buffer hides normal-screen output).
    startupLines.push(...buildWelcomeLines(providers, version, mcpSummary), ...failedMcpLines);
  } else {
    printWelcome(providers, version, mcpSummary);
    // Surface any failed MCP servers explicitly below the splash so users can
    // see *which* one is broken — the splash itself just reports the count.
    for (const s of failed) printError(`  ✗ mcp ${s.name}: ${s.error}`);
  }

  const mcpSnapshot = mcpManager.snapshot({
    mode: config.mcpResultShaping,
    maxChars: config.mcpResultShapingMaxChars,
  });

  const sessionToolAllowlist = new Set<string>();

  const confirmDangerous = async (command: string, signal?: AbortSignal): Promise<boolean> => {
    const h = getInkHandlers();
    if (!h) return false;
    return h.requestConfirmDangerous(command, signal);
  };
  const confirmAction = async (
    input: ConfirmActionInput,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const h = getInkHandlers();
    if (!h) return false;
    return h.requestConfirm(input, signal);
  };
  const blockAction = async (
    input: BlockActionInput,
    signal?: AbortSignal,
  ): Promise<BlockOutcome> => {
    const h = getInkHandlers();
    if (!h) return 'deny';
    return h.requestBlock(input, signal);
  };
  const askUser = async (
    questions: AskUserQuestion[],
    signal?: AbortSignal,
  ): Promise<AskUserBatchResult> => {
    const h = getInkHandlers();
    if (!h) return { cancelled: true, answered: [] };
    return h.requestAskUser(questions, signal);
  };

  const toolOptions: ToolOptions = {
    shellTimeout: config.shellTimeout,
    confirmDangerous,
    confirmAction,
    blockAction,
    sessionToolAllowlist,
    askUser,
    // Profile-persisted grants (#212). Reads the live config reference so
    // "always allow for this profile" decisions and profile switches
    // (applyProfileToConfig mutates in place) take effect immediately.
    getToolPermissions: () => config.toolPermissions,
  };

  // Auto-correct a dangling `activeLineupId` (#264 follow-up). A stale id —
  // left over from a deleted lineup, or a typo in a hand-edited profile —
  // otherwise falls back silently inside model-policy, so the user has no idea
  // their selection isn't in effect. Detect it here, persist the corrected id
  // to the active profile, and pass a transcript notice into <App> so the
  // switch is visible. Best-effort: a persistence failure still keeps the
  // in-memory correction for this session.
  let startupNotice: string | undefined;
  if (config.activeLineupId) {
    try {
      const resolution = resolveActiveLineupWithCorrection(
        loadLineups(),
        config.activeLineupId,
        config.provider,
      );
      if (resolution.corrected) {
        const { requestedId, resolvedId } = resolution.corrected;
        config.activeLineupId = resolvedId;
        try {
          savePreferences({
            provider: config.provider,
            model: config.model,
            activeLineupId: resolvedId,
          });
        } catch {
          // best-effort; the in-memory correction still applies this session
        }
        startupNotice =
          `Heads up — your selected model lineup "${requestedId}" no longer exists, ` +
          `so I switched you to "${resolution.lineup.name}" (${resolvedId}) and saved that choice. ` +
          `Use /lineups to pick a different one.`;
        debugLog('lineup:auto-corrected', { requestedId, resolvedId });
      }
    } catch (err: unknown) {
      // loadLineups always seeds, so this should be unreachable — but never let
      // a lineup-resolution hiccup block REPL startup.
      debugLog('lineup:auto-correct-error', err instanceof Error ? err.message : String(err));
    }
  }

  let initialHistory: CoreMessage[] | undefined;
  if (resume) {
    const loaded = historyStore.load();
    if (loaded.length > 0) {
      // Drop any boundary pair left by an earlier resume before appending a
      // fresh one, so repeated `-r` doesn't stack markers.
      const filtered = loaded.filter(
        (msg) =>
          !(
            typeof msg.content === 'string' &&
            (msg.content.startsWith(SESSION_BOUNDARY_PREFIX) ||
              msg.content === SESSION_BOUNDARY_ACK)
          ),
      );
      initialHistory = [
        ...filtered,
        { role: 'user', content: SESSION_BOUNDARY_NOTICE },
        { role: 'assistant', content: SESSION_BOUNDARY_ACK },
      ];
      emitStartupNotice(`Restored ${filtered.length} message(s) from the previous session.`);
    } else {
      emitStartupNotice('No previous conversation found — starting fresh.');
    }
  }

  const { pending: pendingCandidates, contextBlock } = bootstrapPendingCandidates(
    candidateStore,
    specialistStore,
    config,
    config,
  );
  if (contextBlock) {
    emitStartupNotice(
      `${pendingCandidates.length} specialist suggestion(s) pending. Use /candidates to review.`,
    );
    alertContext = alertContext ? alertContext + '\n\n' + contextBlock : contextBlock;
  }

  const agentCtx = assembleContext({
    config,
    toolOptions,
    // Passed whole: `snapshot()` is the single assembler, so a field added to
    // `AgentContextMCP` can never be silently dropped here (#305).
    mcp: mcpSnapshot,
    rag: ragStore,
    stores: {
      memory: memoryStore,
      routines: routineStore,
      specialists: specialistStore,
      candidates: candidateStore,
    },
  });
  const agent = new Agent(agentCtx, { alertContext, initialHistory });

  if (resume) {
    agent.setTurnProvenance(provenanceHistoryStore.load());
    agent.setTurnContext(turnContextStore.load());
  }

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;

    try {
      const history = agent.getHistory();
      // MIN_HISTORY_FOR_FACTS = 2 (one user + one assistant).
      // Asymmetry vs /clear --save: this exit path only feeds RAG (spawns the
      // background worker for fact extraction). It does NOT write a
      // session-summary memory entry — that is deliberately deferred to
      // /clear --save, which runs interactively and can show the user the key.
      if (ragStore && history.length >= MIN_HISTORY_FOR_FACTS) {
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
          const __dirname = path.dirname(fileURLToPath(import.meta.url));
          // Built install: this file lives in dist/ next to rag-worker.js.
          // Dev (`npm run dev` via tsx): import.meta.url points at src/, where
          // only rag-worker.ts exists — fall back to the built sibling in
          // dist/ so exit-time extraction works in dev sessions too.
          let workerPath = path.join(__dirname, 'rag-worker.js');
          if (!fs.existsSync(workerPath)) {
            workerPath = path.join(__dirname, '..', 'dist', 'rag-worker.js');
          }
          if (fs.existsSync(workerPath)) {
            const child = childProcess.spawn(process.execPath, [workerPath, tempFile], {
              detached: true,
              stdio: 'ignore',
              env: process.env,
            });
            child.unref();
          } else {
            // No built worker anywhere (fresh clone, never built). Drop the
            // payload so it doesn't sit as an orphan until the 1h reaper.
            fs.unlinkSync(tempFile);
            debugLog('rag:exit-worker-missing', { workerPath });
          }
        }
      }
    } catch {
      // Silent failure — don't block exit.
    }

    if (config.correctionEnabled) {
      try {
        const correctionStore = agent.getCorrectionStore();
        const pending = correctionStore.listPending();
        if (pending.length > 0) {
          printInfo(`Reviewing ${pending.length} tool-wrapper failure(s) for learning...`);
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

    // Independent try/catch per store so a failure saving one (e.g. a disk-full
    // burst on the first write) doesn't skip the others.
    for (const [label, save] of [
      ['history', () => historyStore.save(agent.getHistory())],
      ['provenance', () => provenanceHistoryStore.save(agent.getTurnProvenance())],
      ['turn-context', () => turnContextStore.save(agent.getTurnContext())],
    ] as const) {
      try {
        save();
      } catch (err) {
        debugLog('persist:error', {
          store: label,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      await mcpManager.close();
    } catch (err) {
      debugLog('mcp:close-error', err instanceof Error ? err.message : String(err));
    }
  };

  // Enter the alternate screen buffer (full-screen, vim/htop style) before
  // mounting Ink. `fullScreenActive` was decided up-front. Mouse-wheel capture
  // is gated by `config.mouse` (BERNARD_DISABLE_MOUSE). A non-TTY stdout
  // (piped / CI) never enters full-screen — the escapes would corrupt output.
  const fullScreen = fullScreenActive ? withFullScreen({ mouse: config.mouse }) : null;

  const { waitUntilExit } = render(
    createElement(
      DimensionsProvider,
      null,
      createElement(App, {
        agent,
        config,
        historyStore,
        provenanceHistoryStore,
        turnContextStore,
        stores: {
          memory: memoryStore,
          routines: routineStore,
          specialists: specialistStore,
          candidates: candidateStore,
          rag: ragStore,
          mcp: mcpManager,
        },
        sessionToolAllowlist,
        fullScreen: fullScreenActive,
        welcomeLines: fullScreenActive ? startupLines : undefined,
        // Real cleanup runs AFTER waitUntilExit so its printInfo / printError
        // calls don't write through stdout while the Ink renderer is still
        // mounted (which would corrupt the live UI).
        onExit: async () => {},
        alertBanner,
        isFreshInstall,
        startupNotice,
      }),
    ),
  );

  await waitUntilExit();
  // Leave the alt buffer + disable mouse BEFORE cleanup(): cleanup prints via
  // printInfo / printError and that output must land on the restored normal
  // screen, not the about-to-be-discarded alt screen.
  fullScreen?.teardown();
  await cleanup();
}

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
    const customProviders = loadCustomProviders();
    const builtinStatuses = statuses.filter((s) => !customProviders[s.provider]);
    const customStatuses = statuses.filter((s) => customProviders[s.provider]);

    printInfo('Built-in providers:');
    for (const { provider, hasKey } of builtinStatuses) {
      const envVar = PROVIDER_ENV_VARS[provider] ?? providerEnvVar(provider);
      const status = hasKey ? '\u2713' : '\u2717';
      printInfo(`  ${status} ${provider} (${envVar})`);
    }

    if (customStatuses.length > 0) {
      printInfo('\nCustom providers:');
      for (const { provider, hasKey } of customStatuses) {
        const entry = customProviders[provider];
        const status = hasKey ? '\u2713' : '\u2717';
        printInfo(`  ${status} ${provider} \u2014 sdk=${entry.sdk} url=${entry.baseURL}`);
      }
    }

    if (statuses.some((s) => !s.hasKey)) {
      printInfo('\nTo add a key: bernard add-key <provider> <key>');
    }
    if (customStatuses.length === 0) {
      printInfo(
        'To add a custom provider: bernard add-provider <name> --sdk <openai|anthropic|xai> --base-url <url> --model <model>',
      );
    }
  });

program
  .command('usage [sessionId]')
  .description('Show the LLM cost/usage breakdown for a session (defaults to the most recent).')
  .action((sessionId?: string) => {
    const sessions = listTelemetrySessions();
    if (sessions.length === 0) {
      printInfo(
        'No telemetry recorded yet. Run a Bernard session first (telemetry is on by default; disable with BERNARD_TELEMETRY=false).',
      );
      return;
    }
    const id = sessionId ?? sessions[0];
    const records = readSessionTelemetry(id);
    if (records.length === 0) {
      printError(`No telemetry for session "${id}".`);
      printInfo(`Available sessions: ${sessions.slice(0, 15).join(', ')}`);
      return;
    }
    for (const line of formatSessionUsageLines(aggregateRecords(id, records))) {
      printInfo(line);
    }
  });

program
  .command('validate-lineup [id]')
  .description(
    'Live-probe every model in a lineup (defaults to the active one). Exits non-zero if any model is unreachable.',
  )
  .action(async (id?: string) => {
    const config = loadConfig();
    const lineups = loadLineups();
    const target =
      id && lineups[id]
        ? lineups[id]
        : resolveActiveLineup(lineups, config.activeLineupId, config.provider);
    if (id && !lineups[id]) {
      printError(`No lineup with id "${id}". Available: ${Object.keys(lineups).join(', ')}.`);
      process.exit(1);
    }
    printInfo(`Validating lineup "${target.name}" (${target.id})…`);
    const v = await validateLineup(config, target);
    printInfo(formatLineupValidation(v));
    if (!v.ok) {
      printInfo(
        '\nNote: a reachable model can still be too weak for a real task — a probe only checks access.',
      );
      process.exit(1);
    }
  });

program
  .command('profiles')
  .description('List saved settings profiles (active marked with *)')
  .action(() => {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      printInfo('No profiles configured.');
      return;
    }
    printInfo('Profiles:');
    for (const p of profiles) {
      const mark = p.active ? '*' : ' ';
      const idSuffix = p.id !== p.name ? ` (${p.id})` : '';
      printInfo(`  ${mark} ${p.name}${idSuffix}`);
    }
    printInfo('\nManage profiles from the REPL: /profiles, /manage-profiles');
  });

program
  .command('add-provider <name>')
  .description('Register a custom provider (OpenAI/Anthropic/xAI-compatible endpoint)')
  .requiredOption('--sdk <sdk>', 'Which SDK to use: openai, anthropic, or xai')
  .requiredOption('--base-url <url>', 'Base URL for the API endpoint')
  .requiredOption('--model <model>', 'Default model name to use')
  .option('--key <key>', 'API key (can also be added later via add-key)')
  .action((name: string, opts: { sdk: string; baseUrl: string; model: string; key?: string }) => {
    try {
      const entry = saveCustomProvider({
        name,
        sdk: opts.sdk.toLowerCase() as SupportedSdk,
        baseURL: opts.baseUrl,
        defaultModel: opts.model,
      });
      printInfo(`Custom provider "${entry.name}" saved (sdk=${entry.sdk}, url=${entry.baseURL}).`);
      if (opts.key) {
        saveProviderKey(name, opts.key);
        printInfo(`API key for "${name}" saved.`);
      } else {
        printInfo(`Next: bernard add-key ${name} <your-api-key>`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('remove-provider <name>')
  .description('Remove a custom provider and its stored API key')
  .action((name: string) => {
    try {
      removeCustomProvider(name);
      try {
        removeProviderKey(name);
      } catch {
        // No key stored for this provider \u2014 fine.
      }
      printInfo(`Custom provider "${name}" removed.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
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
  .command('set-model-mode <mode>')
  .description(
    'Set multi-model assignment policy: optimize-tokens | balanced | optimize-performance ' +
      '(legacy "off" is accepted and migrated to optimize-performance)',
  )
  .action((mode: string) => {
    const normalized = normalizeStoredModelMode(mode);
    if (!normalized) {
      printError(
        `Unknown model mode "${mode}". Valid values: optimize-tokens, balanced, optimize-performance ` +
          `(legacy "off" is accepted and migrates to optimize-performance).`,
      );
      process.exit(1);
    }
    try {
      const prefs = loadPreferences();
      // savePreferences requires provider/model. When prefs don't carry them,
      // fall back to the active env (BERNARD_PROVIDER/BERNARD_MODEL) so this
      // command doesn't silently override a user who configured their provider
      // via env vars only. Anthropic remains the last-resort default.
      const provider = prefs.provider || process.env.BERNARD_PROVIDER || 'anthropic';
      const model = prefs.model || process.env.BERNARD_MODEL || getDefaultModel(provider);
      savePreferences({
        ...prefs,
        provider,
        model,
        modelMode: normalized,
      });
      if (normalized !== mode) {
        printInfo(`Model mode "${mode}" migrated to "${normalized}".`);
      } else {
        printInfo(`Model mode set to "${normalized}".`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('set-max-concurrent <n>')
  .description(
    `Set the maximum number of concurrent sub-agents / tasks / specialists (1-${MAX_CONCURRENT_AGENTS_LIMIT}, default 4)`,
  )
  .action((raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
      printError(
        `Invalid value "${raw}". Provide an integer between 1 and ${MAX_CONCURRENT_AGENTS_LIMIT}.`,
      );
      process.exit(1);
    }
    if (parsed < 1 || parsed > MAX_CONCURRENT_AGENTS_LIMIT) {
      printError(
        `Value out of range. Must be between 1 and ${MAX_CONCURRENT_AGENTS_LIMIT}, got ${parsed}.`,
      );
      process.exit(1);
    }
    try {
      const normalized = normalizeMaxConcurrentAgents(parsed);
      const prefs = loadPreferences();
      const provider = prefs.provider || process.env.BERNARD_PROVIDER || 'anthropic';
      const model = prefs.model || process.env.BERNARD_MODEL || getDefaultModel(provider);
      savePreferences({
        ...prefs,
        provider,
        model,
        maxConcurrentAgents: normalized,
      });
      setMaxConcurrentAgents(normalized);
      printInfo(`Max concurrent sub-agents set to ${normalized}.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('mcp-list')
  .description('List configured MCP servers')
  .action(() => {
    try {
      const servers = listMCPServers();
      if (servers.length === 0) {
        printInfo('No MCP servers configured.');
        printInfo(`Add servers to ${MCP_CONFIG_PATH}`);
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
  .command('applet-host <action>')
  .description('Manage the applet host: status | start | stop')
  .action(async (action: string) => {
    const { appletHostStatus, appletHostStart, appletHostStop } = await import('./host/cli.js');
    try {
      if (action === 'status') await appletHostStatus();
      else if (action === 'start') await appletHostStart();
      else if (action === 'stop') await appletHostStop();
      else {
        printError(`Unknown action "${action}". Use status, start or stop.`);
        process.exitCode = 1;
      }
    } catch (err: unknown) {
      printError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
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
  .command('script')
  .description('Run a named app action programmatically; prints one JSON object on stdout')
  .option('--app <appId>', 'App id, as registered under the apps directory')
  .option('--action <name>', 'Action name declared by that app')
  .option('--args <json>', "JSON object of the action's declared arguments")
  .option('--args-file <path>', "Read --args from a file; '-' reads stdin")
  .option('--timeout <ms>', "Lower the action's wall clock (never raises it)", parseInt)
  .option('--describe', 'Print the app and its action schemas, then exit without dispatching')
  .action(async (options: ScriptCliOptions) => {
    // Deliberately no --provider / --model: the active profile decides the
    // model, and a caller choosing a vendor per invocation is the user's
    // decision, not the app's.
    //
    // A thin shim like every neighbouring subcommand. `scriptMain` owns the
    // branching, the flag rule and the catch-all, because it also owns the
    // "exactly one JSON object on stdout" contract — which had drifted while
    // this file hand-rolled two envelopes of its own.
    const { scriptMain } = await import('./script/run.js');
    process.exitCode = await scriptMain(options);
  });

program
  .command('cron-grant <id> [paths...]')
  .description('Show or set the folders a cron job may write to, beyond its own workspace')
  .option('--clear', 'Remove all extra write paths, leaving only the job workspace')
  .action(async (id: string, paths: string[], options: { clear?: boolean }) => {
    try {
      await cronGrant(id, paths ?? [], options);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('app [action] [appId] [actionName]')
  .description('List, inspect, permit or delete applets (list | allow | delete | path)')
  .option('--tools <names>', 'Comma-separated tool names for `allow` (empty clears)')
  .option('--write', 'Let this action write, rather than read-only')
  .option('--confirm <mode>', 'Confirmation mode for this action: off | auto | strict')
  .action(
    async (
      action: string | undefined,
      appId: string | undefined,
      actionName: string | undefined,
      options: { tools?: string; write?: boolean; confirm?: string },
    ) => {
      try {
        const cli = await import('./apps/app-cli.js');
        switch (action ?? 'list') {
          case 'list':
            cli.appList();
            return;
          case 'path':
            if (!appId) throw new Error('Usage: bernard app path <appId>');
            cli.appPath(appId);
            return;
          case 'delete':
            if (!appId) throw new Error('Usage: bernard app delete <appId>');
            cli.appDelete(appId);
            return;
          case 'allow': {
            if (!appId || !actionName) {
              throw new Error('Usage: bernard app allow <appId> <action> --tools a,b');
            }
            const tools = (options.tools ?? '')
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean);
            cli.appAllow(appId, actionName, tools, {
              ...(options.write !== undefined ? { write: options.write } : {}),
              ...(options.confirm !== undefined ? { confirm: options.confirm } : {}),
            });
            return;
          }
          default:
            throw new Error(`Unknown action "${action}". Use list, allow, delete or path.`);
        }
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    },
  );

program
  .command('app-grant <appId> [tools...]')
  .description('Show or set the permission rules an applet runs under')
  .option('--deny', 'Write the named tools as deny rules instead of allow')
  .option('--clear', 'Remove every rule for this app')
  .action(async (appId: string, tools: string[], options: { deny?: boolean; clear?: boolean }) => {
    try {
      const { appGrant } = await import('./apps/grant-cli.js');
      await appGrant(appId, tools ?? [], options);
    } catch (err: unknown) {
      printError(err instanceof Error ? err.message : String(err));
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
      tokenWindow: prefs.tokenWindow,
      theme: prefs.theme,
      autoUpdate: enabled,
    });
    printInfo(`Auto-update ${enabled ? 'enabled' : 'disabled'}.`);
  });

program
  .command('tool-profiles')
  .description('Show learned tool reliability: successes, learned errors, and dismissed failures')
  .action(() => {
    try {
      const store = new ToolProfileStore({ seed: false });
      const rows = store
        .list()
        .map((p) => {
          const dismissed = Object.values(p.dismissed ?? {}).reduce((a, b) => a + b, 0);
          const byCategory = Object.entries(p.dismissed ?? {})
            .sort((a, b) => b[1] - a[1])
            .map(([c, n]) => `${c}:${n}`)
            .join(' ');
          return { name: p.toolName, ok: p.successCount, err: p.errorCount, dismissed, byCategory };
        })
        .filter((r) => r.ok > 0 || r.err > 0 || r.dismissed > 0)
        // Most-failing first — the reason to run this is to find what is broken.
        .sort((a, b) => b.err + b.dismissed - (a.err + a.dismissed) || b.ok - a.ok);

      if (rows.length === 0) {
        printInfo('No tool profiles recorded yet.');
        return;
      }
      const pad = Math.max(...rows.map((r) => r.name.length));
      printInfo('tool'.padEnd(pad) + '   ok   learned  dismissed');
      for (const r of rows) {
        const line =
          r.name.padEnd(pad) +
          String(r.ok).padStart(5) +
          String(r.err).padStart(9) +
          String(r.dismissed).padStart(11) +
          (r.byCategory ? `   (${r.byCategory})` : '');
        printInfo(line);
      }
      printInfo('');
      printInfo('learned   = failures that were call-shape mistakes, recorded as bad examples');
      printInfo('dismissed = failures the model cannot fix (environmental) — a high count with no');
      printInfo('            learned errors means the tool is unreliable, not misused');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
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

program
  .command('clear-facts')
  .description('Permanently delete all stored RAG facts')
  .action(async () => {
    try {
      await clearFacts();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program
  .command('voice-test [text]')
  .description('Test the TTS backend by speaking a short message')
  .action(async (text?: string) => {
    const message = text || 'Hello from Bernard.';
    // Load config to pick up persisted voice preferences; skip API key validation
    // by providing a dummy key so the command works without a provider configured.
    let voiceBackend: VoiceBackend = 'auto';
    let voiceVoice: string | undefined;
    let voiceRate: number | undefined;
    let voiceWarmupMs = resolveVoiceWarmupMs();
    try {
      const prefs = loadPreferences();
      voiceBackend = prefs.voiceBackend ?? 'auto';
      voiceVoice = prefs.voiceVoice;
      voiceRate = prefs.voiceRate;
      voiceWarmupMs = resolveVoiceWarmupMs(undefined, prefs.voiceWarmupMs);
    } catch {
      // ignore — fall through to env/default
    }
    const resolved = resolveBackend(process.platform, voiceBackend);
    if (!resolved) {
      printError(
        'No TTS backend found. Install spd-say, espeak-ng, or espeak on Linux; ' +
          'macOS uses "say" built-in; Windows uses PowerShell.',
      );
      process.exit(1);
    }
    printInfo(`TTS backend: ${resolved.backend} (${resolved.bin})`);
    printInfo(`Speaking: "${message}"`);
    const svc = new VoiceService(resolved, {
      player: resolveWarmupPlayer(process.platform),
      ms: voiceWarmupMs,
    });
    try {
      // Deterministic normalization only — this path deliberately constructs no
      // provider or model (it must work with no API key configured), and the
      // message is text the user typed themselves.
      await svc.speak(toLiteralSpeech(message), { voice: voiceVoice, rate: voiceRate });
      printInfo('Done.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      printError(`TTS failed: ${msg}`);
      process.exit(1);
    }
  });

migrateFromLegacy();
program.parse();
