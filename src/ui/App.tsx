import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Agent } from '../agent.js';
import type { BernardConfig } from '../config.js';
import {
  savePreferences,
  loadPreferences,
  PROVIDER_MODELS,
  saveProviderKey,
  OPTIONS_REGISTRY,
  saveOption,
  getProviderKeyStatus,
  normalizeMaxConcurrentAgents,
  normalizeThreshold,
  getAvailableProviders,
} from '../config.js';
import { MAX_CONCURRENT_AGENTS_LIMIT, setMaxConcurrentAgents } from '../tools/agent-pool.js';
import { RESPONSE_STYLE_IDS, type ResponseStyle } from '../agent-prompt.js';
import { getContextWindow } from '../context.js';
import { loadCatalog, getCatalogAgeMs, getCatalogSource } from '../providers/catalog.js';
import { getLocalVersion } from '../update.js';
import { CONFIG_DIR, DATA_DIR, CACHE_DIR, STATE_DIR } from '../paths.js';
import * as os from 'node:os';
import {
  loadCustomProviders,
  saveCustomProvider,
  rememberCustomModel,
  validateProviderName,
  validateBaseURL,
  SUPPORTED_SDKS,
} from '../custom-providers.js';
import {
  LINEUP_TIERS,
  type Lineup,
  type LineupSlot,
  type LineupTier,
  loadLineups,
  resolveActiveLineup,
  saveLineup,
  deleteLineup,
  listLineups,
  validateLineupName,
  PROVIDER_DISPLAY_NAMES,
} from '../lineups.js';
import type { SupportedSdk } from '../providers/types.js';
import { THEMES, getThemeKeys, getActiveThemeKey, setTheme, getThemeColors } from '../theme.js';
import type { HistoryStore } from '../history.js';
import type { ProvenanceHistoryStore } from '../provenance-history.js';
import type { MemoryStore } from '../memory.js';
import type { RoutineStore } from '../routines.js';
import type { SpecialistStore } from '../specialists.js';
import type { CandidateStore } from '../specialist-candidates.js';
import type { RAGStore, RAGSearchResult } from '../rag.js';
import type { MCPManager } from '../mcp.js';
import { CronStore } from '../cron/store.js';
import { isDaemonRunning } from '../cron/client.js';
import { getDomain, getDomainIds } from '../domains.js';
import { MCP_CONFIG_PATH } from '../paths.js';
import { interactiveUpdate } from '../update.js';
import { getBuiltinSpecialistIds } from '../specialists.js';
import { buildCandidateContextBlock, promotePendingCandidates } from '../candidate-bootstrap.js';
import {
  listProfiles,
  createProfile,
  switchActiveProfile,
  renameProfile,
  deleteProfile,
  validateProfileName,
  saveActiveSettings,
  type ProfileSettings,
} from '../profiles.js';
import { permissionKeyLabel, type ToolPermissionValue } from '../tool-permissions.js';
import { applyProfileToConfig } from '../config.js';
import { setToolDetailsVisible } from '../output.js';
import { WIZARD_CATEGORIES_DATA, type WizardFieldData } from '../profiles-wizard-data.js';
import {
  loadImage,
  tryLoadImage,
  extractImagePaths,
  isVisionCapableModel,
  type ImageAttachment,
} from '../image.js';
import { runDefinition } from '../framework/agents/run.js';
import { taskDefinition, type TaskInput } from '../framework/agents/task.js';
import { generateText } from 'ai';
import { resolveSiteModel, resolveMainModel, logSiteModelSnapshot } from '../model-policy.js';
import { serializeMessages, extractDomainFacts, SUMMARIZATION_PROMPT } from '../context.js';
import { detectSpecialistCandidate } from '../specialist-detector.js';
import { promoteCandidate } from '../candidate-bootstrap.js';
import {
  resolveReferences,
  stripToolResolvableTokens,
  shouldSkipResolver,
  type ResolvedEntry,
} from '../reference-resolver.js';
import { rewritePrompt } from '../prompt-rewriter.js';
import { loadRewriterHints } from '../memory.js';
import { stripImagePaths } from '../image.js';
import { getModelProfile } from '../providers/index.js';
import { debugLog, getSessionId, getSessionLogPath, isDebugEnabled } from '../logger.js';
import { acquireSlot, releaseSlot, getMaxConcurrentAgents } from '../tools/agent-pool.js';
import type {
  AskUserQuestion,
  AskUserBatchResult,
  ConfirmActionInput,
  BlockActionInput,
  BlockOutcome,
} from '../tools/types.js';
import type {
  MenuEntry,
  MenuItem,
  MenuOptions,
  ValuePromptOptions,
  ValueResult,
} from './menu-types.js';
import { Thread, REWRITE_ICON } from './Thread.js';
import { Prompt } from './Prompt.js';
import { Spinner } from './Spinner.js';
import { StatusBar } from './StatusBar.js';
import { HintBar } from './HintBar.js';
import { PlanPanel } from './PlanPanel.js';
import { MenuOverlay } from './overlays/MenuOverlay.js';
import { ModelGridOverlay } from './overlays/ModelGridOverlay.js';
import { ConfirmDialog } from './overlays/ConfirmDialog.js';
import { StatusViewer } from './overlays/StatusViewer.js';
import { SourcesViewer } from './overlays/SourcesViewer.js';
import { HelpOverlay } from './overlays/HelpOverlay.js';
import { TextInputOverlay } from './overlays/TextInputOverlay.js';
import { InfoOverlay } from './overlays/InfoOverlay.js';
import { Toast, type ToastVariant } from './Toast.js';
import { persistAgentState } from './save.js';
import { MessageStore } from './message-store.js';
import { setOutputSink } from '../framework/hooks/output-sink.js';
import { setInkHandlers } from './ink-handlers.js';

/**
 * Slash commands and overlays need direct access to the same stores the
 * agent's tool layer already uses. Phase D bundles them into one prop so
 * `<App>` doesn't grow a long parallel signature; `src/index.ts` constructs
 * each store once and passes the same references into both `assembleContext`
 * and `<App>`.
 */
export interface AppStores {
  memory: MemoryStore;
  routines: RoutineStore;
  specialists: SpecialistStore;
  candidates: CandidateStore;
  /** Optional — only present when `config.ragEnabled === true`. */
  rag?: RAGStore;
  /** Optional — only present when MCP servers are configured. */
  mcp?: MCPManager;
}

interface AppProps {
  agent: Agent;
  config: BernardConfig;
  historyStore: HistoryStore;
  provenanceHistoryStore: ProvenanceHistoryStore;
  stores: AppStores;
  /** Per-REPL-session allowlist (#179). Owned by the caller so it survives mount. */
  sessionToolAllowlist: Set<string>;
  /** Called when the user requests exit (Ctrl-C or `/exit`). */
  onExit: () => Promise<void> | void;
  /**
   * Optional alert banner string rendered above the thread until dismissed.
   * Built in `src/index.ts` when `--alert` resumes a session in response to
   * a cron alert.
   */
  alertBanner?: string;
  /**
   * When true, run the fresh-install profile wizard once on mount before
   * accepting input. The default profile is already on disk; the wizard
   * overlays the user's choices on top of it.
   */
  isFreshInstall?: boolean;
}

type Overlay =
  | 'status'
  | 'sources'
  | 'menu'
  | 'grid'
  | 'confirm'
  | 'help'
  | 'text-input'
  | 'info';

interface PendingTextInput {
  options: ValuePromptOptions;
  resolve: (result: ValueResult) => void;
}

interface PendingInfo {
  title: string;
  lines: { text: string; dim?: boolean; bold?: boolean }[];
}

interface ToastState {
  message: string;
  variant: ToastVariant;
}

interface PendingMenu {
  entries: MenuEntry[];
  options?: MenuOptions;
  resolve: (
    result: { cancelled: true } | { cancelled: false; index: number; item: MenuItem },
  ) => void;
}

interface PendingGrid {
  items: string[];
  options?: { title?: string; footer?: string; initialIndex?: number; currentItem?: string };
  resolve: (result: { cancelled: true } | { cancelled: false; index: number }) => void;
}

interface PendingConfirm {
  kind: 'confirm';
  input: ConfirmActionInput;
  resolve: (allowed: boolean, scope: 'once' | 'session' | 'profile') => void;
}

interface PendingBlock {
  kind: 'block';
  input: BlockActionInput;
  resolve: (outcome: BlockOutcome) => void;
}

type PendingDialog = PendingConfirm | PendingBlock;

/**
 * "Other"-shaped choice labels ("Other", "Other (I'll specify)", …).
 * Models include these in `ask_user` choices despite the tool description
 * saying not to (#230); `requestAskUser` dedupes against the auto-appended
 * escape hatch and routes matching selections to the free-text input.
 */
const OTHER_RE = /^other\b/i;

/**
 * Top-level Ink component. Owns the lifecycle of a Bernard REPL session:
 * turn submission, history versioning, overlay queueing, Shift-Tab cycling,
 * and Esc / Ctrl-C handling.
 *
 * `<App>` is **not** mounted from `src/index.ts` in Phase B — the legacy
 * readline REPL is still the user-visible entry point. The dev preview
 * script at `scripts/preview-ink.mjs` mounts this against an isolated
 * `BERNARD_HOME` for end-to-end validation of the #211 round-2 fixes.
 *
 * Tool callbacks are constructed inside `<App>` and would be wired into the
 * `ToolOptions` passed to `assembleContext` at mount time — see
 * `scripts/preview-ink.mjs` for the wiring example. The contracts match
 * `src/tools/types.ts:58-100` exactly so Phase D can swap them in without
 * touching tool code.
 */
export function App({
  agent,
  config,
  historyStore,
  provenanceHistoryStore,
  stores,
  sessionToolAllowlist: _sessionToolAllowlist,
  onExit,
  alertBanner,
  isFreshInstall,
}: AppProps) {
  const { exit } = useApp();
  const [activeOverlay, setActiveOverlay] = useState<Overlay | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [pendingMenu, setPendingMenu] = useState<PendingMenu | null>(null);
  const [pendingGrid, setPendingGrid] = useState<PendingGrid | null>(null);
  const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null);
  const [pendingTextInput, setPendingTextInput] = useState<PendingTextInput | null>(null);
  const [pendingInfo, setPendingInfo] = useState<PendingInfo | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [bannerVisible, setBannerVisible] = useState<boolean>(!!alertBanner);
  const [interrupted, setInterrupted] = useState(false);
  const [slashActive, setSlashActive] = useState(false);
  // Per-history-index timing for completed turns: drives the timestamp +
  // duration footer under every assistant message in <Thread>. Stored as a
  // ref because re-renders are already triggered by historyVersion bumps; the
  // map is append-only across the session and cleared by /clear.
  const turnTimingsRef = useRef<Map<number, { endedAt: number; durationMs: number }>>(new Map());
  // history-index → user's original text when the rewriter substituted it.
  // Lives outside React state because it's append-only and not React-reactive
  // (history re-renders are driven by historyVersion bumps already).
  const rewriteOriginalsRef = useRef<Map<number, string>>(new Map());
  const colors = getThemeColors();

  // Confirm-action session memo: `${toolName}:${stableHash(args)}` → true.
  // Mirrors the legacy REPL's confirm-allow-for-session map.
  const confirmAllowSession = useRef<Map<string, boolean>>(new Map());
  // One-shot guard so onExit runs exactly once whether the user types
  // `/exit` (handleSubmit) or the Ink tree unmounts (useEffect cleanup).
  const exitedRef = useRef(false);
  // Synchronous guard against double-Enter: setBusy schedules a re-render but
  // a second submit can land before Prompt sees `disabled={busy}` flip.
  const submittingRef = useRef(false);
  // Turn-level abort controller. Esc aborts this controller (cancels the
  // pre-turn pipeline) AND calls agent.abort() (cancels the agent loop once
  // it's started). Reset to null in runAgentTurn's finally block.
  const turnAbortRef = useRef<AbortController | null>(null);
  // Phase C (#214): one MessageStore per <App> lifecycle. Held in a ref so
  // re-renders don't reinstantiate it (which would unsubscribe consumers and
  // drop in-flight events). Registered with the framework's output-sink seam
  // in a mount-time effect; cleared on unmount.
  const messageStoreRef = useRef<MessageStore | null>(null);
  if (messageStoreRef.current === null) {
    messageStoreRef.current = new MessageStore();
  }
  const messageStore = messageStoreRef.current;

  // Closes the active overlay and resolves any pending request as a cancel.
  const closeOverlay = () => {
    if (pendingMenu) {
      pendingMenu.resolve({ cancelled: true });
      setPendingMenu(null);
    }
    if (pendingGrid) {
      pendingGrid.resolve({ cancelled: true });
      setPendingGrid(null);
    }
    if (pendingDialog) {
      if (pendingDialog.kind === 'confirm') pendingDialog.resolve(false, 'once');
      else pendingDialog.resolve('deny');
      setPendingDialog(null);
    }
    if (pendingTextInput) {
      pendingTextInput.resolve({ cancelled: true });
      setPendingTextInput(null);
    }
    if (pendingInfo) setPendingInfo(null);
    setActiveOverlay(null);
  };

  // Gate the App-level useInput so it never fires concurrently with an
  // overlay's own useInput. Modal overlays (menu, confirm, help, text-input)
  // own the keystream; viewer overlays (status, sources) leave it to App so
  // Esc can close them and Shift-Tab can keep cycling.
  const appInputActive =
    activeOverlay === null || activeOverlay === 'status' || activeOverlay === 'sources';

  useInput(
    (_input, key) => {
      // Shift-Tab cycles viewer tabs only while idle.
      if (key.shift && key.tab) {
        if (busy) return;
        setActiveOverlay((curr) => {
          if (curr === null) return 'status';
          if (curr === 'status') return 'sources';
          return null;
        });
        return;
      }
      if (key.escape) {
        debugLog('app:esc', { busy, activeOverlay, hasTurnAbort: !!turnAbortRef.current });
        if (activeOverlay) {
          closeOverlay();
          return;
        }
        if (busy) {
          setInterrupted(true);
          turnAbortRef.current?.abort();
          agent.abort();
        }
      }
    },
    { isActive: appInputActive },
  );

  // Exit cleanup runs on Ink unmount. The exitedRef guard means `/exit` (which
  // already awaited onExit) doesn't trigger a second invocation.
  useEffect(() => {
    return () => {
      if (exitedRef.current) return;
      exitedRef.current = true;
      void onExit();
    };
  }, [onExit]);

  // Phase C (#214) sink registration. The framework's `getOutputSink()` reads
  // this slot on every step; the legacy readline REPL leaves it null. Cleared
  // on unmount so a test or preview that re-mounts <App> doesn't leak the
  // previous store into the new run.
  useEffect(() => {
    setOutputSink(messageStore);
    return () => setOutputSink(null);
  }, [messageStore]);

  // Per-session debug log boundaries. `session:start` captures the runtime
  // shape so a future tail-read can correlate behavior with the active
  // provider / model / lineup; `session:end` lets us see how long the REPL
  // ran and roughly how many turns happened. Mount-once on purpose: the
  // boundaries delimit the REPL *process* lifetime, so mid-session
  // provider/model/mode changes must not emit a spurious end/start pair
  // (those mutations already log their own `model-policy:snapshot` diffs).
  // `agent` and `config` are stable references for the App lifetime; the
  // fields read here are deliberately the mount-time values.
  useEffect(() => {
    const startedAt = Date.now();
    debugLog('session:start', {
      sessionId: getSessionId(),
      logPath: getSessionLogPath(),
      cwd: process.cwd(),
      provider: config.provider,
      model: config.model,
      modelMode: config.modelMode,
      coordinatorMode: config.coordinatorMode,
    });
    logSiteModelSnapshot(config, 'session-start');
    return () => {
      debugLog('session:end', {
        durationMs: Date.now() - startedAt,
        turns: agent.getHistory().filter((m) => m.role === 'user').length,
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session boundaries are per-mount, not per-config-change
  }, [agent]);

  // Attach a persistent SpinnerStats object so the framework's token-stats
  // hook accumulates usage across turns. <StatusBar> polls this for the
  // pinned bottom-right readout. We never null it out — totals carry across
  // the whole session and only reset on REPL restart. Seeded in a mount-time
  // effect (StrictMode-safe; render-body side effects double-fire and would
  // re-overwrite the object on every re-render including the StatusBar tick).
  useEffect(() => {
    if (!agent.spinnerStats) {
      agent.setSpinnerStats({
        startTime: Date.now(),
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        latestPromptTokens: 0,
        // Lineup-resolved main model, not the stale `config.model` base field
        // (#233) — the gauge denominator must follow the model we actually talk
        // to. The agent loop also refreshes this each turn for mid-session
        // lineup/model switches; this just seeds the first pre-turn render.
        model: resolveMainModel(config),
        contextWindowOverride: config.tokenWindow || undefined,
      });
    }
  }, [agent, config.model, config.tokenWindow]);

  // Phase D (#215) ink-handlers bridge. The toolOptions callbacks built in
  // `src/index.ts` read from `getInkHandlers()` at call time, so this effect
  // hands them the live overlay-request closures. The methods on the
  // registered object close over `handlersRef.current`, which is rewritten on
  // every render so the toolOptions see the latest closures without
  // re-registering. Cleared on unmount so post-exit calls fail closed.
  const handlersRef = useRef<{
    requestMenu: typeof requestMenu;
    requestConfirm: typeof requestConfirm;
    requestBlock: typeof requestBlock;
    requestTextInput: typeof requestTextInput;
    requestAskUser: typeof requestAskUser;
  } | null>(null);
  useEffect(() => {
    setInkHandlers({
      requestMenu: (entries, options) => handlersRef.current!.requestMenu(entries, options),
      requestConfirm: (input, signal) => handlersRef.current!.requestConfirm(input, signal),
      requestBlock: (input, signal) => handlersRef.current!.requestBlock(input, signal),
      requestTextInput: (options) => handlersRef.current!.requestTextInput(options),
      requestAskUser: (questions, signal) => handlersRef.current!.requestAskUser(questions, signal),
      requestConfirmDangerous: async (command, signal) => {
        if (signal?.aborted) return false;
        const result = await handlersRef.current!.requestMenu(
          [{ label: 'Allow once' }, { label: 'Cancel' }],
          { title: `⚠ Dangerous command: ${command}` },
        );
        if (signal?.aborted) return false;
        return !result.cancelled && result.index === 0;
      },
    });
    return () => setInkHandlers(null);
  }, []);

  // Fresh-install profile wizard (#207). Runs once on mount, after handlers
  // are registered, before the user starts typing. Failures are swallowed so
  // a wizard glitch never blocks the REPL from coming up.
  const onboardingRanRef = useRef(false);
  useEffect(() => {
    if (!isFreshInstall || onboardingRanRef.current) return;
    onboardingRanRef.current = true;
    void (async () => {
      try {
        const wiz = await runProfileWizardInk(requestMenu, requestTextInput, flashToast);
        if (!wiz.cancelled) {
          const { savePreferences: save } = await import('../config.js');
          save({ provider: config.provider, model: config.model, ...wiz.settings });
          const { applyProfileToConfig: apply } = await import('../config.js');
          apply(config);
          flashToast('Default profile updated.', 'success');
        } else {
          flashToast('Setup skipped — running with built-in defaults.', 'info');
        }
      } catch (err) {
        flashToast(
          `Onboarding wizard error: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    })();
  }, [isFreshInstall]);

  const flashToast = (message: string, variant: ToastVariant = 'info') => {
    setToast({ message, variant });
  };

  const showInfo = (title: string, lines: PendingInfo['lines']) => {
    setPendingInfo({ title, lines });
    setActiveOverlay('info');
  };

  const handleSubmit = async (text: string) => {
    // Clear any prior toast on the next submit so flashes don't accumulate.
    if (toast) setToast(null);
    // Dismiss the alert banner once the user starts interacting.
    if (bannerVisible) setBannerVisible(false);

    // ── Simple one-shot slash commands (no overlay, no agent turn) ──
    if (text === '/exit' || text === '/quit') {
      if (exitedRef.current) return;
      exitedRef.current = true;
      await onExit();
      exit();
      return;
    }
    if (text === '/clear' || text.startsWith('/clear ')) {
      const clearArgs = text.slice('/clear'.length).trim();
      const shouldSave = clearArgs === '--save' || clearArgs === '-s';
      if (clearArgs && !shouldSave) {
        flashToast('Usage: /clear [--save|-s]', 'error');
        return;
      }
      if (shouldSave) {
        const history = agent.getHistory();
        if (history.length < 2) {
          flashToast('Not enough conversation to summarize.', 'warning');
        } else {
          setBusy(true);
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
                stores.specialists.list(),
                stores.candidates.listPending(),
              ).catch(() => null),
            ]);
            const summary = summaryResult.text?.trim();
            if (summary) {
              const key = `session-summary-${new Date().toISOString().replace(/[:.]/g, '-')}`;
              stores.memory.writeMemory(key, summary);
              flashToast(`Summary saved to memory: ${key}`, 'success');
            }
            if (stores.rag && domainFacts.length > 0) {
              const results = await Promise.allSettled(
                domainFacts.map((df) => stores.rag!.addFacts(df.facts, 'clear-save', df.domain)),
              );
              let storedFacts = 0;
              results.forEach((r, i) => {
                if (r.status === 'fulfilled') storedFacts += domainFacts[i].facts.length;
              });
              if (storedFacts > 0) {
                debugLog('app:clear-save:rag', { storedFacts });
              }
            }
            if (candidateResult) {
              try {
                if (candidateResult.type === 'new-candidate') {
                  const created = stores.candidates.create(candidateResult.candidate, 'clear-save');
                  if (
                    config.autoCreateSpecialists &&
                    candidateResult.candidate.confidence >= config.autoCreateThreshold
                  ) {
                    promoteCandidate(
                      { ...candidateResult.candidate, id: created.id },
                      stores.specialists,
                      stores.candidates,
                      config.autoCreateThreshold,
                      config,
                    );
                  }
                }
              } catch {
                // Silent — candidate storage failure is non-critical
              }
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            flashToast(`Failed to summarize: ${message}. Clearing anyway.`, 'error');
          } finally {
            setBusy(false);
          }
        }
      }
      historyStore.clear();
      provenanceHistoryStore.clear();
      agent.clearHistory();
      turnTimingsRef.current.clear();
      rewriteOriginalsRef.current.clear();
      setInterrupted(false);
      // Wipe scrollback + visible region so the old transcript doesn't linger
      // above the cleared <Thread>. `\x1b[3J` clears scrollback, `\x1b[2J`
      // the visible region, `\x1b[H` homes the cursor. Ink repaints on the
      // next setHistoryVersion bump below.
      process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
      setHistoryVersion((v) => v + 1);
      flashToast('Conversation history cleared.', 'success');
      return;
    }
    if (text === '/help') {
      setActiveOverlay('help');
      return;
    }
    if (text === '/session-log') {
      flashToast(
        isDebugEnabled()
          ? `Session log: ${getSessionLogPath()}`
          : 'Session log is disabled. Start Bernard with BERNARD_DEBUG=1 to record one.',
      );
      return;
    }
    if (text === '/refresh-models') {
      flashToast('Refreshing model catalog…');
      try {
        const refreshed = await loadCatalog({ force: true });
        const source = getCatalogSource();
        flashToast(
          `Catalog refreshed: ${refreshed.entries.length} models (source: ${source}).`,
          'success',
        );
      } catch (err) {
        flashToast(
          `Catalog refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
      return;
    }
    if (text === '/memory') {
      const keys = stores.memory.listMemory();
      flashToast(
        keys.length === 0
          ? 'No persistent memories stored.'
          : `Persistent memories (${keys.length}): ${keys.join(', ')}`,
      );
      return;
    }
    if (text === '/scratch') {
      const keys = stores.memory.listScratch();
      flashToast(
        keys.length === 0
          ? 'No scratch notes in this session.'
          : `Scratch notes (${keys.length}): ${keys.join(', ')}`,
      );
      return;
    }
    if (text === '/compact') {
      const history = agent.getHistory();
      if (history.length < 2) {
        flashToast('Not enough conversation to compact.', 'warning');
        return;
      }
      setBusy(true);
      try {
        const result = await agent.compactHistory();
        if (!result.compacted) {
          flashToast('Nothing to compact — conversation is already short enough.');
        } else {
          // History indices shift after compaction; per-index maps would now
          // attach to the wrong messages.
          turnTimingsRef.current.clear();
          rewriteOriginalsRef.current.clear();
          const pct = Math.round(
            ((result.tokensBefore - result.tokensAfter) / result.tokensBefore) * 100,
          );
          flashToast(
            `Compacted: ~${result.tokensBefore} → ~${result.tokensAfter} tokens (${pct}% reduction)`,
            'success',
          );
        }
        persistAgentState({ agent, historyStore, provenanceHistoryStore });
        setHistoryVersion((v) => v + 1);
      } catch (err) {
        flashToast(
          `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      } finally {
        setBusy(false);
      }
      return;
    }

    if (text === '/policy') {
      const last = agent.getLastPolicyDecision();
      if (!last) {
        flashToast('No policy decision yet — send a message first.');
        return;
      }
      const lines: PendingInfo['lines'] = [
        { text: 'Decision:', bold: true },
        ...JSON.stringify(last.decision, null, 2)
          .split('\n')
          .map((l) => ({ text: l })),
        { text: '' },
        { text: 'Reason codes:', bold: true },
        ...Object.entries(last.reasons).map(([k, r]) => ({ text: `  ${k}: ${r}` })),
      ];
      showInfo('Last policy decision', lines);
      return;
    }

    if (text === '/mcp') {
      if (!stores.mcp) {
        flashToast(`No MCP servers configured. Add servers to ${MCP_CONFIG_PATH}`);
        return;
      }
      const statuses = stores.mcp.getServerStatuses();
      if (statuses.length === 0) {
        flashToast(`No MCP servers configured. Add servers to ${MCP_CONFIG_PATH}`);
        return;
      }
      const lines: PendingInfo['lines'] = statuses.map((s) =>
        s.connected
          ? { text: `  ✓ ${s.name} (${s.toolCount} tools)` }
          : { text: `  ✗ ${s.name} — ${s.error}` },
      );
      const toolNames = Object.keys(stores.mcp.getTools());
      if (toolNames.length > 0) {
        lines.push({ text: '' });
        lines.push({ text: `MCP tools: ${toolNames.join(', ')}`, dim: true });
      }
      showInfo('MCP servers', lines);
      return;
    }

    if (text === '/cron') {
      const store = new CronStore();
      const jobs = store.loadJobs();
      const running = isDaemonRunning();
      const lines: PendingInfo['lines'] = [
        { text: `Daemon: ${running ? 'running' : 'stopped'}`, bold: true },
      ];
      if (jobs.length === 0) {
        lines.push({ text: 'No cron jobs configured.', dim: true });
      } else {
        lines.push({ text: '' });
        lines.push({ text: `Jobs (${jobs.length}):`, bold: true });
        for (const job of jobs) {
          const status = job.enabled ? 'enabled' : 'disabled';
          const lastRun = job.lastRun
            ? `last: ${new Date(job.lastRun).toLocaleString()} (${job.lastRunStatus || 'unknown'})`
            : 'never run';
          lines.push({ text: `  ${job.name} [${status}] — ${job.schedule} — ${lastRun}` });
          lines.push({ text: `    ID: ${job.id}`, dim: true });
        }
        const alerts = store.listAlerts().filter((a) => !a.acknowledged);
        if (alerts.length > 0) {
          lines.push({ text: '' });
          lines.push({ text: `Unacknowledged alerts (${alerts.length}):`, bold: true });
          for (const alert of alerts.slice(0, 5)) {
            lines.push({
              text: `  [${new Date(alert.timestamp).toLocaleString()}] ${alert.jobName}: ${alert.message}`,
            });
          }
        }
      }
      showInfo('Cron', lines);
      return;
    }

    if (text === '/rag') {
      if (!stores.rag) {
        flashToast('RAG is disabled. Set BERNARD_RAG_ENABLED=true (default) to enable.');
        return;
      }
      const count = stores.rag.count();
      const lines: PendingInfo['lines'] = [{ text: `Total memories: ${count}`, bold: true }];
      if (count === 0) {
        lines.push({
          text: 'No RAG memories yet. Memories are extracted automatically during context compression.',
          dim: true,
        });
      } else {
        const counts = stores.rag.countByDomain();
        const knownDomains = new Set(getDomainIds());
        lines.push({ text: '' });
        lines.push({ text: 'By domain:', bold: true });
        for (const domainId of knownDomains) {
          const domainCount = counts[domainId] ?? 0;
          if (domainCount > 0) {
            const domain = getDomain(domainId);
            lines.push({ text: `  ${domain.name}: ${domainCount}` });
          }
        }
        for (const [domainId, domainCount] of Object.entries(counts)) {
          if (!knownDomains.has(domainId)) {
            lines.push({ text: `  ${domainId}: ${domainCount}` });
          }
        }
        const facts = stores.rag.listFacts();
        const recent = facts.slice(-10);
        lines.push({ text: '' });
        lines.push({ text: 'Most recent (up to 10):', bold: true });
        for (const f of recent) lines.push({ text: `  ${f}`, dim: true });
      }
      showInfo('RAG memories', lines);
      return;
    }

    if (text === '/facts') {
      const results = agent.getLastRAGResults();
      if (results.length === 0) {
        flashToast('No RAG facts in current context window.');
        return;
      }
      const lines: PendingInfo['lines'] = [];
      const byDomain = new Map<string, RAGSearchResult[]>();
      for (const r of results) {
        if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
        byDomain.get(r.domain)!.push(r);
      }
      for (const [domainId, items] of byDomain) {
        const domain = getDomain(domainId);
        lines.push({ text: `### ${domain.name}`, bold: true });
        for (const item of items) {
          const pct = Math.round(item.similarity * 100);
          lines.push({ text: `  - (${pct}%) ${item.fact}` });
        }
        lines.push({ text: '' });
      }
      showInfo(`Recalled Context (${results.length} facts)`, lines);
      return;
    }

    if (text === '/update') {
      flashToast('Checking for updates…');
      try {
        await interactiveUpdate();
        flashToast('Update check complete.', 'success');
      } catch (err) {
        flashToast(
          `Update check failed: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
      return;
    }

    if (text === '/theme') {
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
      const result = await requestMenu(entries, {
        title: `Themes — current: ${THEMES[currentKey].name}`,
      });
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
        flashToast(`Switched to ${THEMES[chosen].name} theme.`, 'success');
      }
      return;
    }

    if (text === '/tool-permissions') {
      await runToolPermissionsMenu();
      return;
    }

    if (text === '/provider' || text === '/models') {
      await runModelsCatalogInk(config, requestMenu, requestTextInput, flashToast);
      return;
    }

    if (text === '/model') {
      flashToast(
        'Model selection is now per-tier. Use /lineup to edit the active lineup, or /lineups to switch.',
        'info',
      );
      return;
    }

    if (text === '/lineup') {
      const lineups = loadLineups();
      const active = resolveActiveLineup(lineups, config.activeLineupId, config.provider);
      const edited = await runLineupEditorInk(
        active,
        config,
        requestMenu,
        requestGridMenu,
        requestTextInput,
        flashToast,
      );
      if (edited) {
        config.activeLineupId = edited.id;
        savePreferences({
          provider: config.provider,
          model: config.model,
          activeLineupId: edited.id,
        });
        logSiteModelSnapshot(config, 'lineup-change');
        flashToast(`Lineup "${edited.name}" saved.`, 'success');
      }
      return;
    }

    if (text === '/lineups') {
      const all = listLineups();
      // Resolve once so a stale `config.activeLineupId` (e.g. pointing at a
      // lineup the user deleted) falls through to whatever resolveActiveLineup
      // picks instead of leaving every row marked as not-active.
      const activeId = resolveActiveLineup(
        loadLineups(),
        config.activeLineupId,
        config.provider,
      ).id;
      const entries: MenuEntry[] = all.map((l) => ({
        label: l.name,
        annotation: `(${l.id})`,
        active: l.id === activeId,
        description: `premium ${l.premium.provider}/${l.premium.model} · mid ${l.mid.provider}/${l.mid.model} · cheap ${l.cheap.provider}/${l.cheap.model}`,
        value: l.id,
      }));
      entries.push({ type: 'section', title: '' });
      entries.push({ label: '+ Create new lineup…', value: '__new__' });
      const pick = await requestMenu(entries, {
        title: 'Lineups — select to switch (active is opened for edit)',
      });
      if (pick.cancelled) return;
      const value = pick.item.value as string;
      if (value === '__new__') {
        const nameRes = await requestTextInput({ label: 'New lineup name' });
        if (nameRes.cancelled || !nameRes.raw.trim()) return;
        const nameErr = validateLineupName(nameRes.raw);
        if (nameErr) {
          flashToast(nameErr, 'error');
          return;
        }
        const seed = resolveActiveLineup(loadLineups(), config.activeLineupId, config.provider);
        const draft: Lineup = {
          ...seed,
          id: '',
          name: nameRes.raw.trim(),
        };
        const created = await runLineupEditorInk(
          draft,
          config,
          requestMenu,
          requestGridMenu,
          requestTextInput,
          flashToast,
          { isNew: true },
        );
        if (created) {
          config.activeLineupId = created.id;
          savePreferences({
            provider: config.provider,
            model: config.model,
            activeLineupId: created.id,
          });
          logSiteModelSnapshot(config, 'lineup-change');
          flashToast(`Created and switched to "${created.name}".`, 'success');
        }
        return;
      }
      const target = all.find((l) => l.id === value);
      if (!target) return;
      const isActive = target.id === activeId;
      if (isActive) {
        const edited = await runLineupEditorInk(
          target,
          config,
          requestMenu,
          requestGridMenu,
          requestTextInput,
          flashToast,
        );
        if (edited) {
          config.activeLineupId = edited.id;
          savePreferences({
            provider: config.provider,
            model: config.model,
            activeLineupId: edited.id,
          });
          logSiteModelSnapshot(config, 'lineup-change');
          flashToast(`Lineup "${edited.name}" saved.`, 'success');
        }
        return;
      }
      config.activeLineupId = target.id;
      savePreferences({
        provider: config.provider,
        model: config.model,
        activeLineupId: target.id,
      });
      logSiteModelSnapshot(config, 'lineup-change');
      flashToast(`Switched to lineup "${target.name}".`, 'success');
      return;
    }

    if (text === '/agent-options') {
      await runAgentOptions();
      return;
    }

    if (text === '/profiles') {
      const profiles = listProfiles();
      const entries: MenuEntry[] = profiles.map((p) => ({
        label: p.name,
        annotation: p.id !== p.name ? `(${p.id})` : undefined,
        active: p.active,
      }));
      entries.push({ label: '+ Create new profile…', value: '__new__' });
      const result = await requestMenu(entries, {
        title: 'Profiles — select one to switch, or create a new one',
      });
      if (result.cancelled) return;
      if (result.index === profiles.length) {
        const wiz = await runProfileWizardInk(requestMenu, requestTextInput, flashToast);
        if (wiz.cancelled) {
          flashToast('Profile creation cancelled.');
          return;
        }
        const priorActive = listProfiles().find((p) => p.active)?.id;
        let createdId: string | undefined;
        try {
          const profile = createProfile(wiz.name, wiz.settings);
          createdId = profile.id;
          switchActiveProfile(profile.id);
          applyProfileToConfig(config);
          reapplyRuntimeSettings(config);
          logSiteModelSnapshot(config, 'profile-switch');
          flashToast(`Created profile "${profile.name}" and switched to it.`, 'success');
        } catch (err) {
          if (createdId && priorActive) {
            try {
              switchActiveProfile(priorActive);
              applyProfileToConfig(config);
              reapplyRuntimeSettings(config);
            } catch {
              /* best-effort rollback */
            }
          }
          flashToast(`Failed to create profile: ${(err as Error).message}`, 'error');
        }
        return;
      }
      const target = profiles[result.index];
      if (target.active) {
        flashToast(`Already on profile "${target.name}".`);
        return;
      }
      const priorActive = profiles.find((p) => p.active)?.id;
      try {
        switchActiveProfile(target.id);
        applyProfileToConfig(config);
        reapplyRuntimeSettings(config);
        logSiteModelSnapshot(config, 'profile-switch');
        flashToast(`Switched to profile "${target.name}".`, 'success');
      } catch (err) {
        if (priorActive) {
          try {
            switchActiveProfile(priorActive);
            applyProfileToConfig(config);
            reapplyRuntimeSettings(config);
          } catch {
            /* best-effort rollback */
          }
        }
        flashToast(`Failed to switch profile: ${(err as Error).message}`, 'error');
      }
      return;
    }

    if (text === '/manage-profiles') {
      const profiles = listProfiles();
      if (profiles.length === 0) {
        flashToast('No profiles configured.');
        return;
      }
      const entries: MenuEntry[] = profiles.map((p) => ({
        label: p.name,
        annotation: p.active ? '(active)' : undefined,
      }));
      const pick = await requestMenu(entries, { title: 'Manage profiles — select one' });
      if (pick.cancelled) return;
      const target = profiles[pick.index];
      const action = await requestMenu(
        [{ label: 'Rename' }, { label: 'Delete' }, { label: 'Back' }],
        { title: `Profile "${target.name}" (${target.id})` },
      );
      if (action.cancelled || action.index === 2) return;
      if (action.index === 0) {
        const val = await requestTextInput({ label: `New name for "${target.name}"` });
        if (val.cancelled || !val.raw.trim()) return;
        try {
          const updated = renameProfile(target.id, val.raw.trim());
          flashToast(`Renamed to "${updated.name}".`, 'success');
        } catch (err) {
          flashToast(`Failed to rename: ${(err as Error).message}`, 'error');
        }
        return;
      }
      // Delete path.
      const confirm = await requestMenu(
        [
          { label: `Delete "${target.name}"`, description: 'This cannot be undone.' },
          { label: 'Cancel' },
        ],
        { title: 'Confirm deletion' },
      );
      if (confirm.cancelled || confirm.index === 1) return;
      try {
        deleteProfile(target.id);
        flashToast(`Deleted profile "${target.name}".`, 'success');
      } catch (err) {
        flashToast(`Cannot delete: ${(err as Error).message}`, 'error');
      }
      return;
    }

    if (text === '/options') {
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
      const optResult = await requestMenu(menuEntries, {
        title: 'Options',
        promptLabel: 'Select option',
      });
      if (optResult.cancelled) return;
      if (optResult.index >= optEntries.length) {
        showInfo('Bernard Diagnostic Report', buildDebugReportLines(config, agent, stores));
        return;
      }
      const [name, opt] = optEntries[optResult.index];
      const valResult = await requestTextInput({ label: `New value for ${name}` });
      if (valResult.cancelled) return;
      const val = parseInt(valResult.raw, 10);
      const minVal = opt.default === 0 ? 0 : 1;
      if (Number.isNaN(val) || val < minVal) {
        flashToast(
          `Invalid value. Must be ${minVal === 0 ? 'a non-negative integer' : 'a positive integer'}.`,
          'error',
        );
        return;
      }
      saveOption(name, val);
      (config as unknown as Record<string, unknown>)[opt.configKey] = val;
      if (name === 'token-window') {
        // Validate against the lineup-resolved main model's window, not the
        // stale base field (#233).
        const mainModel = resolveMainModel(config);
        const modelWindow = getContextWindow(mainModel);
        if (val > modelWindow) {
          flashToast(
            `Set ${name} = ${val} (warning: exceeds ${mainModel}'s context window ${modelWindow})`,
            'warning',
          );
          return;
        }
      }
      flashToast(`${name} set to ${val}`, 'success');
      return;
    }

    if (text === '/routines') {
      const all = stores.routines.list();
      if (all.length === 0) {
        flashToast('No routines saved. Teach me a workflow and I can save it as a routine.');
        return;
      }
      const tasks = all.filter((r) => r.id.startsWith('task-'));
      const routines = all.filter((r) => !r.id.startsWith('task-'));
      const lines: PendingInfo['lines'] = [];
      if (tasks.length > 0) {
        lines.push({
          text: `Tasks (${tasks.length}) — single-step, structured output:`,
          bold: true,
        });
        for (const r of tasks) {
          lines.push({ text: `  /${r.id} — ${r.name}: ${r.description}` });
        }
      }
      if (routines.length > 0) {
        if (tasks.length > 0) lines.push({ text: '' });
        lines.push({
          text: `Routines (${routines.length}) — multi-step workflows:`,
          bold: true,
        });
        for (const r of routines) {
          lines.push({ text: `  /${r.id} — ${r.name}: ${r.description}` });
        }
      }
      showInfo('Routines', lines);
      return;
    }

    if (text === '/specialists') {
      const all = stores.specialists.list();
      if (all.length === 0) {
        flashToast(
          'No specialist agents defined yet. Ask me to create one or use /create-specialist.',
        );
        return;
      }
      const builtinIds = getBuiltinSpecialistIds();
      const bundled = all.filter((s) => builtinIds.has(s.id));
      const user = all.filter((s) => !builtinIds.has(s.id));
      const lines: PendingInfo['lines'] = [];
      if (bundled.length > 0) {
        lines.push({ text: 'Bundled:', bold: true });
        for (const s of bundled) {
          lines.push({ text: `  ${s.id} — ${s.name}: ${s.description}` });
        }
      }
      if (user.length > 0) {
        if (bundled.length > 0) lines.push({ text: '' });
        lines.push({ text: 'Yours:', bold: true });
        for (const s of user) {
          lines.push({ text: `  ${s.id} — ${s.name}: ${s.description}` });
        }
      }
      showInfo(`Specialists (${all.length})`, lines);
      return;
    }

    if (text === '/candidates') {
      const pending = stores.candidates.listPending();
      if (pending.length === 0) {
        flashToast('No pending specialist suggestions.');
        return;
      }
      const lines: PendingInfo['lines'] = [];
      for (const c of pending) {
        const pct = Math.round(c.confidence * 100);
        const date = new Date(c.detectedAt).toLocaleDateString();
        lines.push({ text: `${c.name} (${c.draftId})`, bold: true });
        lines.push({ text: `  ${c.description}`, dim: true });
        lines.push({ text: `  Confidence: ${pct}% | Detected: ${date}`, dim: true });
        lines.push({ text: `  Reasoning: ${c.reasoning}`, dim: true });
        lines.push({ text: '' });
        stores.candidates.acknowledge(c.id);
      }
      lines.push({
        text: 'To accept or reject, tell Bernard conversationally (e.g., "accept the code-review candidate").',
        dim: true,
      });
      agent.setAlertContext(buildCandidateContextBlock(pending));
      showInfo(`Specialist Suggestions (${pending.length})`, lines);
      return;
    }

    if (text === '/create-routine' || text === '/create-task' || text === '/create-specialist') {
      const seed = CREATE_SEED_PROMPTS[text];
      await runAgentTurn(seed);
      return;
    }

    if (text === '/task' || text.startsWith('/task ')) {
      const description = text.slice('/task'.length).trim();
      if (!description) {
        flashToast('Usage: /task <description>', 'error');
        return;
      }
      await runTaskInk(description);
      return;
    }

    if (text === '/image' || text.startsWith('/image ')) {
      const argsText = text.slice('/image'.length).trim();
      if (!argsText) {
        flashToast('Usage: /image <path> [prompt]', 'error');
        return;
      }
      let imagePath: string;
      let userText: string;
      const quoteMatch = argsText.match(/^(["'])(.+?)\1(?:\s+(.*))?$/);
      if (quoteMatch) {
        imagePath = quoteMatch[2];
        userText = quoteMatch[3]?.trim() || 'Describe this image.';
      } else {
        const spaceIdx = argsText.indexOf(' ');
        imagePath = spaceIdx === -1 ? argsText : argsText.slice(0, spaceIdx);
        userText =
          spaceIdx === -1
            ? 'Describe this image.'
            : argsText.slice(spaceIdx + 1).trim() || 'Describe this image.';
      }
      if (!isVisionCapableModel(config.provider, config.model)) {
        flashToast(
          `Model "${config.model}" does not support image input. Switch with /model.`,
          'error',
        );
        return;
      }
      let attachment: ImageAttachment;
      try {
        attachment = loadImage(imagePath);
      } catch (err) {
        flashToast(err instanceof Error ? err.message : String(err), 'error');
        return;
      }
      flashToast(`Attaching ${attachment.path} → ${config.provider}/${config.model}`);
      await runAgentTurn(userText, [attachment]);
      return;
    }

    // Backwards-compat shims: standalone toggles that were consolidated into
    // /agent-options or /options in pre-Phase-D releases. Print a short
    // pointer so users typing the old name aren't silently dropped into the
    // agent turn.
    const legacyToggle: Record<string, string> = {
      '/react': 'Coordinator (ReAct) mode → /agent-options',
      '/tool-details': 'Tool-call details → /agent-options',
      '/debug': 'Debug logging → /options',
    };
    if (legacyToggle[text]) {
      flashToast(`This command moved. ${legacyToggle[text]}`, 'warning');
      return;
    }

    // Dynamic routine invocation: /{routine-id} [args...]
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const routineId = parts[0];
      const routine = stores.routines.get(routineId);
      if (routine) {
        const args = parts.slice(1).join(' ');
        if (routineId.startsWith('task-')) {
          await runTaskInk(routine.content, args || undefined);
          return;
        }
        let message = `Execute routine "${routine.name}" (/${routine.id}):\n${routine.description}\n\n## Routine Steps\n${routine.content}`;
        if (args) {
          message += `\n\n## Additional Context\n${args}`;
        }
        message +=
          "\n\nFollow this routine intelligently — adapt to the current situation, skip steps that don't apply, and explain any deviations.";
        await runAgentTurn(message);
        return;
      }
      // Unknown slash command — fall through to agent turn (legacy behavior).
    }

    // Inline-image detection on plain text turns.
    let inlineImages: ImageAttachment[] | undefined;
    const candidatePaths = extractImagePaths(text);
    if (candidatePaths.length > 0) {
      if (isVisionCapableModel(config.provider, config.model)) {
        const loaded: ImageAttachment[] = [];
        for (const p of candidatePaths) {
          const img = tryLoadImage(p);
          if (img) loaded.push(img);
        }
        if (loaded.length > 0) {
          for (const img of loaded) {
            flashToast(`Attaching ${img.path}`);
          }
          inlineImages = loaded;
        }
      } else {
        flashToast(
          `Image(s) detected but model "${config.model}" does not support vision.`,
          'warning',
        );
      }
    }

    await runAgentTurn(text, inlineImages);
  };

  type BooleanPrefKey = 'autoCreateSpecialists' | 'promptRewriter' | 'toolDetails' | 'conciseMode';

  async function toggleBooleanPref(
    key: BooleanPrefKey,
    label: string,
    onMsg: string,
    offMsg: string,
    onToggle?: (value: boolean) => void,
  ): Promise<void> {
    const entries: MenuEntry[] = [
      { label: 'On', active: config[key] === true, value: true },
      { label: 'Off', active: config[key] === false, value: false },
    ];
    const result = await requestMenu(entries, {
      title: `${label}: ${config[key] ? 'ON' : 'OFF'}`,
    });
    if (result.cancelled) return;
    const newVal = result.item.value as boolean;
    config[key] = newVal;
    savePreferences({
      ...loadPreferences(),
      provider: config.provider,
      model: config.model,
      [key]: newVal,
    });
    onToggle?.(newVal);
    flashToast(newVal ? onMsg : offMsg, 'success');
  }

  async function runCoordinatorModePrompt(): Promise<void> {
    const modes: Array<{ value: 'on' | 'off' | 'auto'; label: string; desc: string }> = [
      {
        value: 'auto',
        label: 'Auto (qualifier picks per turn)',
        desc: 'Classifier inspects each ask and chooses Normal or ReAct.',
      },
      { value: 'on', label: 'On (always coordinator)', desc: 'Every turn runs ReAct.' },
      { value: 'off', label: 'Off (always normal)', desc: 'Every turn runs single-shot Normal.' },
    ];
    const entries: MenuEntry[] = modes.map((m) => ({
      label: m.label,
      description: m.desc,
      active: config.coordinatorMode === m.value,
      value: m.value,
    }));
    const result = await requestMenu(entries, {
      title: `Coordinator mode: ${config.coordinatorMode.toUpperCase()}`,
    });
    if (result.cancelled) return;
    const chosen = result.item.value as 'on' | 'off' | 'auto';
    config.coordinatorMode = chosen;
    savePreferences({
      ...loadPreferences(),
      provider: config.provider,
      model: config.model,
      coordinatorMode: chosen,
    });
    flashToast(`Coordinator mode → ${chosen}`, 'success');
  }

  async function runModelModePrompt(): Promise<void> {
    const modes: Array<{
      value: 'optimize-tokens' | 'balanced' | 'optimize-performance';
      label: string;
      desc: string;
    }> = [
      {
        value: 'balanced',
        label: 'Balanced',
        desc: 'Premium main; mid sub-agents; cheap routing.',
      },
      {
        value: 'optimize-tokens',
        label: 'Optimize for token usage',
        desc: 'Aggressive cost-saving.',
      },
      {
        value: 'optimize-performance',
        label: 'Optimize for performance',
        desc: 'Strongest model everywhere.',
      },
    ];
    const entries: MenuEntry[] = modes.map((m) => ({
      label: m.label,
      description: m.desc,
      active: config.modelMode === m.value,
      value: m.value,
    }));
    const result = await requestMenu(entries, { title: `Model mode: ${config.modelMode}` });
    if (result.cancelled) return;
    const chosen = result.item.value as (typeof modes)[number]['value'];
    config.modelMode = chosen;
    savePreferences({
      ...loadPreferences(),
      provider: config.provider,
      model: config.model,
      modelMode: chosen,
    });
    logSiteModelSnapshot(config, 'model-mode-change');
    flashToast(`Model mode → ${chosen}`, 'success');
  }

  /** Toggle the #212 escape hatch: mutate live config, persist, toast. */
  function setSkipPermissions(enabled: boolean): void {
    config.skipPermissions = enabled;
    saveActiveSettings({ skipPermissions: enabled });
    flashToast(
      enabled
        ? '⚠ Permission checks and safeguards DISABLED for this profile.'
        : 'Permission checks re-enabled.',
      enabled ? 'error' : 'success',
    );
  }

  async function runToolModePrompt(): Promise<void> {
    const modes: Array<{ value: 'read-only' | 'write' | 'skip'; label: string; desc: string }> = [
      {
        value: 'read-only',
        label: 'Read-only (least privilege)',
        desc: 'Write tools blocked until explicitly enabled.',
      },
      {
        value: 'write',
        label: 'Write',
        desc: 'Every tool may run; confirm gate still prompts on risk.',
      },
      {
        value: 'skip',
        label: 'Run Without Permission Checks or Safeguards',
        desc: '⚠ No blocking, no confirmation prompts — every tool call runs unattended.',
      },
    ];
    const entries: MenuEntry[] = modes.map((m) => ({
      label: m.label,
      description: m.desc,
      active: m.value === 'skip' ? config.skipPermissions : !config.skipPermissions && config.toolMode === m.value,
      value: m.value,
    }));
    const current = config.skipPermissions ? 'unrestricted' : config.toolMode;
    const result = await requestMenu(entries, { title: `Tool mode: ${current}` });
    if (result.cancelled) return;
    const chosen = result.item.value as 'read-only' | 'write' | 'skip';
    if (chosen === 'skip') {
      setSkipPermissions(true);
      return;
    }
    // Picking a guarded mode always re-arms the safeguards.
    config.toolMode = chosen;
    config.skipPermissions = false;
    saveActiveSettings({ toolMode: chosen, skipPermissions: false });
    flashToast(`Tool mode → ${chosen}`, 'success');
  }

  async function runScratchThresholdPrompt(): Promise<void> {
    const val = await requestTextInput({
      label: 'New subject-change threshold (0-1, e.g. 0.15)',
    });
    if (val.cancelled) return;
    const parsed = parseFloat(val.raw);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
      flashToast('Threshold must be a number between 0 and 1 (e.g. 0.15)', 'error');
      return;
    }
    config.scratchSubjectThreshold = parsed;
    savePreferences({
      ...loadPreferences(),
      scratchSubjectThreshold: parsed,
      provider: config.provider,
      model: config.model,
    });
    flashToast(`Scratch subject-change threshold: ${parsed}`, 'success');
  }

  async function runMaxConcurrentPrompt(): Promise<void> {
    const val = await requestTextInput({
      label: `Max concurrent sub-agents (1-${MAX_CONCURRENT_AGENTS_LIMIT}, default 4)`,
    });
    if (val.cancelled) return;
    const raw = val.raw.trim();
    const parsed = Number.parseInt(raw, 10);
    if (
      !Number.isFinite(parsed) ||
      String(parsed) !== raw ||
      parsed < 1 ||
      parsed > MAX_CONCURRENT_AGENTS_LIMIT
    ) {
      flashToast(`Value must be an integer between 1 and ${MAX_CONCURRENT_AGENTS_LIMIT}.`, 'error');
      return;
    }
    const normalized = normalizeMaxConcurrentAgents(parsed);
    config.maxConcurrentAgents = normalized;
    setMaxConcurrentAgents(normalized);
    savePreferences({
      ...loadPreferences(),
      maxConcurrentAgents: normalized,
      provider: config.provider,
      model: config.model,
    });
    flashToast(`Max concurrent sub-agents: ${normalized}`, 'success');
  }

  async function runResponseStylePrompt(): Promise<void> {
    const entries: MenuEntry[] = RESPONSE_STYLE_IDS.map((id: ResponseStyle) => ({
      label: id,
      active: config.responseStyle === id,
      value: id,
    }));
    const result = await requestMenu(entries, {
      title: `Response style: ${config.responseStyle}`,
    });
    if (result.cancelled) return;
    const chosen = result.item.value as ResponseStyle;
    config.responseStyle = chosen;
    savePreferences({
      ...loadPreferences(),
      provider: config.provider,
      model: config.model,
      responseStyle: chosen,
    });
    flashToast(`Response style → ${chosen}`, 'success');
  }

  async function runThresholdPrompt(): Promise<void> {
    const val = await requestTextInput({ label: 'New threshold (0-100)' });
    if (val.cancelled) return;
    const parsed = parseFloat(val.raw);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
      flashToast('Threshold must be a number between 0 and 100 (e.g. 0.8 or 80)', 'error');
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
    flashToast(
      `Auto-create threshold: ${normalized} (${Math.round(normalized * 100)}%)`,
      'success',
    );
    if (config.autoCreateSpecialists) {
      promotePendingCandidates(
        stores.candidates,
        stores.specialists,
        config.autoCreateThreshold,
        config,
      );
    }
  }

  async function runAgentOptions(): Promise<void> {
    type MenuRow =
      | { kind: 'section'; title: string }
      | { kind: 'item'; item: MenuItem; action: () => void | Promise<void> };

    const toggleRow = (
      key: BooleanPrefKey,
      label: string,
      desc: string,
      onMsg: string,
      offMsg: string,
      onToggle?: (value: boolean) => void,
    ): MenuRow => ({
      kind: 'item',
      item: { label, annotation: `= ${config[key] ? 'on' : 'off'}`, description: desc },
      action: () => toggleBooleanPref(key, label, onMsg, offMsg, onToggle),
    });

    const rows: MenuRow[] = [
      { kind: 'section', title: 'System' },
      toggleRow(
        'autoCreateSpecialists',
        'Auto-create specialists',
        'Auto-promote pending candidates above the threshold.',
        'Auto-create specialists: on',
        'Auto-create specialists: off',
        (value) => {
          if (value) {
            promotePendingCandidates(
              stores.candidates,
              stores.specialists,
              config.autoCreateThreshold,
              config,
            );
          }
        },
      ),
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
          description: 'On = always coordinator; Off = always normal; Auto = per-turn qualifier.',
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
      {
        kind: 'item',
        item: {
          label: 'Tier lineup',
          annotation: `= ${resolveActiveLineup(loadLineups(), config.activeLineupId, config.provider).name}`,
          description:
            'Switch, edit, or create lineups that bind premium/mid/cheap tiers to specific (provider, model) pairs.',
        },
        action: () => handleSubmit('/lineups'),
      },
      {
        kind: 'item',
        item: {
          label: 'Tool mode',
          annotation: `= ${config.skipPermissions ? '⚠ unrestricted' : config.toolMode}`,
          description:
            'Read-only blocks write tools until enabled. Write lets every tool run subject to the confirm gate. Unrestricted skips all permission checks.',
        },
        action: runToolModePrompt,
      },
      toggleRow(
        'promptRewriter',
        `Prompt rewriter ${REWRITE_ICON}`,
        `Restructure your prompt for the active model family before each turn. Rewritten messages are tagged with ${REWRITE_ICON} next to the timestamp in the transcript.`,
        'Prompt rewriter: on',
        'Prompt rewriter: off',
      ),
      toggleRow(
        'toolDetails',
        'Tool details',
        'Show full tool call args and results in the transcript.',
        'Tool details: on',
        'Tool details: off',
        (value) => {
          setToolDetailsVisible(value);
          // <Thread> re-keys on historyVersion, so bumping it here forces a
          // remount that picks up the new toolDetails flag on the visible
          // transcript (not just future turns).
          setHistoryVersion((v) => v + 1);
        },
      ),
      toggleRow(
        'conciseMode',
        'Concise mode',
        'Default responses to the smallest sufficient size.',
        'Concise mode: on',
        'Concise mode: off',
      ),
      {
        kind: 'item',
        item: {
          label: 'Scratch subject-change threshold',
          annotation: `= ${config.scratchSubjectThreshold}`,
          description: 'Jaccard similarity (0-1) below which a new turn clears all scratch.',
        },
        action: runScratchThresholdPrompt,
      },
      {
        kind: 'item',
        item: {
          label: 'Response style',
          annotation: `= ${config.responseStyle}`,
          description:
            'Shape the model response (Detailed, Short, Step-by-Step, Simple, High-Level, Critical, Creative).',
        },
        action: runResponseStylePrompt,
      },
      {
        kind: 'item',
        item: {
          label: 'Max concurrent sub-agents',
          annotation: `= ${config.maxConcurrentAgents}`,
          description: `Cap on parallel agent/task/specialist runs (1-${MAX_CONCURRENT_AGENTS_LIMIT}). Default 4.`,
        },
        action: runMaxConcurrentPrompt,
      },
      { kind: 'section', title: 'User-created' },
      {
        kind: 'item',
        item: { label: 'Specialists', description: 'List bundled and user-created specialists.' },
        action: () => handleSubmit('/specialists'),
      },
      {
        kind: 'item',
        item: { label: 'Tasks & routines', description: 'List saved tasks and routines.' },
        action: () => handleSubmit('/routines'),
      },
    ];

    const topEntries: MenuEntry[] = rows.map((r) =>
      r.kind === 'section' ? { type: 'section', title: r.title } : r.item,
    );
    const itemActions = rows.flatMap((r) => (r.kind === 'item' ? [r.action] : []));

    const topResult = await requestMenu(topEntries, { title: 'Agent Options' });
    if (topResult.cancelled) return;
    const action = itemActions[topResult.index];
    if (action) await action();
  }

  function reapplyRuntimeSettings(cfg: BernardConfig): void {
    try {
      setTheme(cfg.theme);
    } catch {
      /* unknown theme — keep current */
    }
    setToolDetailsVisible(cfg.toolDetails);
  }

  async function runPreTurnPipeline(
    input: string,
    signal: AbortSignal,
  ): Promise<{ agentInput: string; resolvedEntries: ResolvedEntry[] }> {
    const pipelineStartedAt = Date.now();
    debugLog('pre-turn:start', { inputLen: input.length });
    // Per-turn RAG cache invalidation (#171). Must run before any resolver /
    // rewriter LLM call so they see only this turn's facts.
    stores.rag?.clearTurnCache();

    let resolvedEntries: ResolvedEntry[] = [];
    if (!shouldSkipResolver(input)) {
      const resolverInput = stripToolResolvableTokens(stripImagePaths(input));
      if (resolverInput.length > 0) {
        try {
          const hints = loadRewriterHints(stores.memory);
          const result = await resolveReferences(
            resolverInput,
            stores.memory,
            config,
            hints,
            signal,
            stores.rag,
            agent.getHistory(),
          );
          if (result.status === 'resolved') {
            resolvedEntries = result.entries;
            debugLog('app:resolved-references', { entries: resolvedEntries });
          }
          // ambiguous/unknown: degraded — the legacy disambiguation / save
          // menus haven't been ported to Ink yet (Phase E). Fall open so the
          // turn proceeds with the original prompt rather than blocking.
        } catch (err: unknown) {
          debugLog('app:resolve-references', err instanceof Error ? err.message : String(err));
        }
      }
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    let agentInput = input;
    if (config.promptRewriter) {
      try {
        const profile = getModelProfile(
          config.provider,
          config.model,
          config.customProviders?.[config.provider]?.sdk,
        );
        const result = await rewritePrompt(input, profile, resolvedEntries, config, signal);
        if (result.status === 'rewritten') {
          agentInput = result.text;
          debugLog('app:prompt-rewritten', {
            family: profile.family,
            original: input,
            rewritten: result.text,
          });
        }
      } catch (err: unknown) {
        debugLog('app:prompt-rewriter', err instanceof Error ? err.message : String(err));
      }
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    debugLog('pre-turn:end', {
      durationMs: Date.now() - pipelineStartedAt,
      rewritten: agentInput !== input,
      refCount: resolvedEntries.length,
    });
    return { agentInput, resolvedEntries };
  }

  async function runAgentTurn(input: string, images?: ImageAttachment[]): Promise<void> {
    // Drop a second Enter that arrives before the busy re-render has propagated
    // to <Prompt disabled={busy}>. Without this, two turns can run concurrently.
    if (submittingRef.current) return;
    submittingRef.current = true;
    // Clear the previous turn's stream events so the in-flight
    // <StreamingAssistantMessage> renders only this turn's deltas.
    messageStore.reset();
    setInterrupted(false);
    setBusy(true);
    const turnStartedAt = Date.now();
    let turnCompleted = false;
    const controller = new AbortController();
    turnAbortRef.current = controller;
    try {
      const { agentInput, resolvedEntries } = await runPreTurnPipeline(input, controller.signal);
      if (controller.signal.aborted) return;
      // `processInput` pushes the user message to `agent.history` synchronously
      // (before its first internal await), so by the time the returned promise
      // hits this microtask boundary the history already contains the new
      // entry. Bumping `historyVersion` here makes the static <Thread> re-read
      // and show the user message above the streaming assistant block instead
      // of after the turn finishes.
      const inflight = agent.processInput(agentInput, images, resolvedEntries);
      // Capture the original text (pre-rewrite) so <UserMessage> can display
      // it instead of the rewritten version that was dispatched to the model.
      // The push has already happened — record at the resulting last index.
      if (input !== agentInput) {
        const idx = agent.getHistory().length - 1;
        rewriteOriginalsRef.current.set(idx, input);
      }
      setHistoryVersion((v) => v + 1);
      await inflight;
      turnCompleted = !controller.signal.aborted;
    } catch (err) {
      // AbortError on user-cancel is expected; don't dump it to the console.
      const isAbort =
        err instanceof Error && (err.name === 'AbortError' || controller.signal.aborted);
      if (!isAbort) {
        console.error('agent error:', err);
        // When debug is on, also surface the error in the chat transcript so
        // hangs / silent failures are visible without having to grep logs.
        if (isDebugEnabled()) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error && err.stack ? err.stack : undefined;
          const cause =
            err instanceof Error && err.cause instanceof Error ? err.cause.stack : undefined;
          debugLog('error:turn', { message, stack, cause });
          const body = [`⚠ Agent error: ${message}`, stack, cause && `Caused by:\n${cause}`]
            .filter(Boolean)
            .join('\n\n');
          agent.getHistory().push({ role: 'assistant', content: body });
          setHistoryVersion((v) => v + 1);
        }
      }
    } finally {
      persistAgentState({ agent, historyStore, provenanceHistoryStore });
      submittingRef.current = false;
      turnAbortRef.current = null;
      setBusy(false);
      if (turnCompleted) {
        const endedAt = Date.now();
        const history = agent.getHistory();
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].role === 'assistant') {
            turnTimingsRef.current.set(i, {
              endedAt,
              durationMs: endedAt - turnStartedAt,
            });
            break;
          }
        }
      }
      setHistoryVersion((v) => v + 1);
    }
  }

  async function runTaskInk(description: string, context?: string): Promise<void> {
    const slot = acquireSlot();
    if (!slot) {
      flashToast(`Maximum concurrent agents (${getMaxConcurrentAgents()}) reached.`, 'error');
      return;
    }
    setInterrupted(false);
    setBusy(true);
    const ctx = agent.getContext();
    ctx.provenance.clear();
    try {
      const input: TaskInput = context
        ? { task: description, context, slotId: slot.id }
        : { task: description, slotId: slot.id };
      const { result, formatted } = await runDefinition(ctx, taskDefinition, input);
      if (result.finishReason === 'length') {
        const recommended = Math.ceil((config.maxTokens * 2) / 1024) * 1024;
        flashToast(
          `Task response truncated (hit ${config.maxTokens} tokens). Consider /options max-tokens ${recommended}`,
          'warning',
        );
      }
      const outputStr =
        typeof formatted.output === 'string'
          ? formatted.output
          : JSON.stringify(formatted.output, null, 2);
      const lines: PendingInfo['lines'] = outputStr.split('\n').map((l) => ({ text: l }));
      if (formatted.details) {
        lines.push({ text: '' });
        for (const l of String(formatted.details).split('\n')) {
          lines.push({ text: l, dim: true });
        }
      }
      showInfo(`Task: ${description.slice(0, 60)}${description.length > 60 ? '…' : ''}`, lines);
    } catch (err) {
      flashToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      releaseSlot();
      setBusy(false);
    }
  }

  // Overlay-request helpers — built locally and bridged to the pre-mount
  // `ToolOptions` callbacks in `src/index.ts` via `setInkHandlers`. The
  // `handlersRef.current` assignment below rewrites the slot every render so
  // the registered (stable) shim object always forwards to the latest
  // closures.
  handlersRef.current = {
    requestMenu,
    requestConfirm,
    requestBlock,
    requestTextInput,
    requestAskUser,
  };

  function requestMenu(
    entries: MenuEntry[],
    options?: MenuOptions,
  ): Promise<{ cancelled: true } | { cancelled: false; index: number; item: MenuItem }> {
    return new Promise((resolve) => {
      setPendingMenu({ entries, options, resolve });
      setActiveOverlay('menu');
    });
  }

  function requestGridMenu(
    items: string[],
    options?: { title?: string; footer?: string; initialIndex?: number; currentItem?: string },
  ): Promise<{ cancelled: true } | { cancelled: false; index: number }> {
    return new Promise((resolve) => {
      setPendingGrid({ items, options, resolve });
      setActiveOverlay('grid');
    });
  }

  /**
   * Persists an `allow`/`deny` grant under `key` in the active profile's
   * `toolPermissions` (#212). Mutates the live `config` reference (the augment
   * gates read it through `getToolPermissions` on every call) and writes the
   * active profile so the grant survives REPL restarts.
   */
  function persistToolPermission(key: string, value: ToolPermissionValue): void {
    config.toolPermissions = { ...config.toolPermissions, [key]: value };
    saveActiveSettings({ toolPermissions: config.toolPermissions });
  }

  /**
   * `/tool-permissions` (#212): inspect/remove the active profile's persisted
   * grants and toggle the global "Run Without Permission Checks or
   * Safeguards" escape hatch.
   */
  async function runToolPermissionsMenu(): Promise<void> {
    const skipOn = config.skipPermissions;
    const keys = Object.keys(config.toolPermissions).sort();
    const entries: MenuEntry[] = [
      {
        label: 'Run Without Permission Checks or Safeguards',
        annotation: skipOn ? 'ON' : 'off',
        description: skipOn
          ? 'Every tool call runs without prompts or read-only blocking. Select to turn back off.'
          : 'Disable the block gate and every confirmation prompt for this profile.',
        value: '__skip__',
      },
      ...(keys.length > 0
        ? [
            { type: 'section' as const, title: 'Profile grants:' },
            ...keys.map((k) => ({
              label: k,
              annotation: config.toolPermissions[k],
              value: k,
            })),
            { label: 'Reset all grants', value: '__reset__' },
          ]
        : [{ type: 'section' as const, title: 'No tool grants saved for this profile.' }]),
    ];
    const result = await requestMenu(entries, {
      title: `Tool permissions — profile grants persist across sessions`,
    });
    if (result.cancelled) return;
    const value = result.item.value as string;

    if (value === '__skip__') {
      setSkipPermissions(!skipOn);
      return;
    }

    if (value === '__reset__') {
      config.toolPermissions = {};
      saveActiveSettings({ toolPermissions: {} });
      flashToast('All profile tool grants removed.', 'success');
      return;
    }

    // Per-grant submenu.
    const current = config.toolPermissions[value];
    if (!current) return;
    const flipped: ToolPermissionValue = current === 'allow' ? 'deny' : 'allow';
    const sub = await requestMenu(
      [
        { label: 'Remove grant', value: 'remove' },
        { label: `Switch to ${flipped}`, value: 'switch' },
        { label: 'Cancel', value: 'cancel' },
      ],
      { title: `${value} — currently ${current}` },
    );
    if (sub.cancelled || sub.item.value === 'cancel') return;
    if (sub.item.value === 'remove') {
      const updated = { ...config.toolPermissions };
      delete updated[value];
      config.toolPermissions = updated;
      saveActiveSettings({ toolPermissions: updated });
      flashToast(`Removed grant for "${permissionKeyLabel(value)}".`, 'success');
      return;
    }
    persistToolPermission(value, flipped);
    flashToast(`"${permissionKeyLabel(value)}" switched to ${flipped}.`, 'success');
  }

  function requestConfirm(input: ConfirmActionInput, signal?: AbortSignal): Promise<boolean> {
    const key = `${input.toolName}:${stableHash(input.args)}`;
    if (confirmAllowSession.current.get(key)) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const onAbort = () => {
        setPendingDialog(null);
        setActiveOverlay(null);
        finish(false);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      setPendingDialog({
        kind: 'confirm',
        input,
        resolve: (allowed, scope) => {
          signal?.removeEventListener('abort', onAbort);
          if (allowed && scope === 'session') confirmAllowSession.current.set(key, true);
          if (allowed && scope === 'profile' && input.permissionKey) {
            persistToolPermission(input.permissionKey, 'allow');
          }
          finish(allowed);
        },
      });
      setActiveOverlay('confirm');
    });
  }

  function requestBlock(input: BlockActionInput, signal?: AbortSignal): Promise<BlockOutcome> {
    if (signal?.aborted) return Promise.resolve('deny' as BlockOutcome);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: BlockOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const onAbort = () => {
        setPendingDialog(null);
        setActiveOverlay(null);
        finish('deny');
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      setPendingDialog({
        kind: 'block',
        input,
        resolve: (outcome) => {
          signal?.removeEventListener('abort', onAbort);
          if (outcome === 'allow-tool-for-profile' && input.permissionKey) {
            persistToolPermission(input.permissionKey, 'allow');
          }
          finish(outcome);
        },
      });
      setActiveOverlay('confirm');
    });
  }

  function requestTextInput(options: ValuePromptOptions): Promise<ValueResult> {
    return new Promise((resolve) => {
      setPendingTextInput({ options, resolve });
      setActiveOverlay('text-input');
    });
  }

  async function requestAskUser(
    questions: AskUserQuestion[],
    signal?: AbortSignal,
  ): Promise<AskUserBatchResult> {
    const answers: string[] = [];
    for (const q of questions) {
      if (signal?.aborted) return { cancelled: true, answered: answers };

      // Free-text question (no choices) — prompt with TextInputOverlay.
      if (!q.choices || q.choices.length === 0) {
        const result = await requestTextInput({ label: q.question });
        if (result.cancelled) return { cancelled: true, answered: answers };
        answers.push(result.raw.trim());
        continue;
      }

      // Choice question; append an "Other" escape hatch if requested.
      // Models often include their own "Other" entry despite the tool
      // description (#230) — when they do, skip the duplicate and treat
      // the model's entry as the escape hatch instead.
      const otherLabel = q.otherLabel?.trim() || 'Other (type your own)';
      const entries: MenuEntry[] = q.choices.map((c) => ({ label: c }));
      const hasModelOther = q.choices.some((c) => OTHER_RE.test(c.trim()));
      const appendedHatch = q.allowOther && !hasModelOther;
      if (appendedHatch) entries.push({ label: otherLabel });
      const result = await requestMenu(entries, { title: q.question });
      if (result.cancelled) return { cancelled: true, answered: answers };

      const pickedHatch =
        (appendedHatch && result.index === entries.length - 1) ||
        OTHER_RE.test(result.item.label.trim());
      if (pickedHatch) {
        // User picked "Other" — gather free-form text.
        const free = await requestTextInput({ label: q.question });
        if (free.cancelled) return { cancelled: true, answered: answers };
        answers.push(free.raw.trim());
      } else {
        answers.push(result.item.label);
      }
    }
    return { answers };
  }

  return (
    <Box flexDirection="column" paddingX={2}>
      {bannerVisible && alertBanner && (
        <Box marginTop={1} borderStyle="single" borderColor={colors.warning} paddingX={1}>
          <Text color={colors.warning}>{alertBanner}</Text>
        </Box>
      )}
      <Thread
        key={historyVersion}
        history={agent.getHistory()}
        messageStore={messageStore}
        busy={busy}
        interrupted={interrupted}
        rewriteOriginals={rewriteOriginalsRef.current}
        turnTimings={turnTimingsRef.current}
        toolDetails={config.toolDetails}
      />
      {busy && (
        <Box marginTop={1}>
          <Spinner label="thinking…" />
        </Box>
      )}
      <PlanPanel agent={agent} />
      {toast && <Toast message={toast.message} variant={toast.variant} />}
      <Prompt
        disabled={busy || activeOverlay !== null}
        onSubmit={handleSubmit}
        onSlashActiveChange={setSlashActive}
      />
      <Box justifyContent="space-between">
        <HintBar busy={busy} overlayActive={activeOverlay !== null} slashActive={slashActive} />
        <StatusBar agent={agent} />
      </Box>
      {activeOverlay === 'status' && (
        <StatusViewer
          agent={agent}
          config={config}
          sessionAllowedCount={_sessionToolAllowlist.size}
        />
      )}
      {activeOverlay === 'sources' && <SourcesViewer agent={agent} />}
      {activeOverlay === 'menu' && pendingMenu && (
        <MenuOverlay
          entries={pendingMenu.entries}
          options={pendingMenu.options}
          onSelect={(index, item) => {
            pendingMenu.resolve({ cancelled: false, index, item });
            setPendingMenu(null);
            setActiveOverlay(null);
          }}
          onCancel={() => {
            pendingMenu.resolve({ cancelled: true });
            setPendingMenu(null);
            setActiveOverlay(null);
          }}
        />
      )}
      {activeOverlay === 'grid' && pendingGrid && (
        <ModelGridOverlay
          items={pendingGrid.items}
          title={pendingGrid.options?.title}
          footer={pendingGrid.options?.footer}
          initialIndex={pendingGrid.options?.initialIndex}
          currentItem={pendingGrid.options?.currentItem}
          onSelect={(index) => {
            pendingGrid.resolve({ cancelled: false, index });
            setPendingGrid(null);
            setActiveOverlay(null);
          }}
          onCancel={() => {
            pendingGrid.resolve({ cancelled: true });
            setPendingGrid(null);
            setActiveOverlay(null);
          }}
        />
      )}
      {activeOverlay === 'confirm' && pendingDialog && pendingDialog.kind === 'confirm' && (
        <ConfirmDialog
          kind="confirm"
          toolName={pendingDialog.input.toolName}
          reason={pendingDialog.input.reason}
          risk={pendingDialog.input.risk}
          permissionKey={pendingDialog.input.permissionKey}
          onResolve={(allowed, scope) => {
            pendingDialog.resolve(allowed, scope);
            setPendingDialog(null);
            setActiveOverlay(null);
          }}
          onCancel={() => {
            pendingDialog.resolve(false, 'once');
            setPendingDialog(null);
            setActiveOverlay(null);
          }}
        />
      )}
      {activeOverlay === 'help' && <HelpOverlay onClose={() => setActiveOverlay(null)} />}
      {activeOverlay === 'info' && pendingInfo && (
        <InfoOverlay
          title={pendingInfo.title}
          lines={pendingInfo.lines}
          onClose={() => {
            setPendingInfo(null);
            setActiveOverlay(null);
          }}
        />
      )}
      {activeOverlay === 'text-input' && pendingTextInput && (
        <TextInputOverlay
          options={pendingTextInput.options}
          onResolve={(result) => {
            pendingTextInput.resolve(result);
            setPendingTextInput(null);
            setActiveOverlay(null);
          }}
        />
      )}
      {activeOverlay === 'confirm' && pendingDialog && pendingDialog.kind === 'block' && (
        <ConfirmDialog
          kind="block"
          toolName={pendingDialog.input.toolName}
          reason={pendingDialog.input.reason}
          permissionKey={pendingDialog.input.permissionKey}
          onResolve={(outcome) => {
            pendingDialog.resolve(outcome);
            setPendingDialog(null);
            setActiveOverlay(null);
          }}
          onCancel={() => {
            pendingDialog.resolve('deny');
            setPendingDialog(null);
            setActiveOverlay(null);
          }}
        />
      )}
    </Box>
  );
}

type RequestMenuFn = (
  entries: MenuEntry[],
  options?: MenuOptions,
) => Promise<{ cancelled: true } | { cancelled: false; index: number; item: MenuItem }>;
type RequestTextInputFn = (options: ValuePromptOptions) => Promise<ValueResult>;
type FlashToastFn = (message: string, variant?: ToastVariant) => void;

async function pickWizardField(
  field: WizardFieldData,
  current: unknown,
  requestMenu: RequestMenuFn,
  requestTextInput: RequestTextInputFn,
): Promise<unknown> {
  const kind = field.field;
  if (kind.kind === 'list') {
    const entries: MenuEntry[] = kind.options.map((o) => ({
      label: o.label,
      description: o.description,
      active: current === o.value,
      value: o.value,
    }));
    const res = await requestMenu(entries, { title: field.label });
    if (res.cancelled) return undefined;
    return res.item.value;
  }
  if (kind.kind === 'boolean') {
    const entries: MenuEntry[] = [
      { label: 'On', active: current === true, value: true },
      { label: 'Off', active: current === false, value: false },
    ];
    const res = await requestMenu(entries, { title: field.label });
    if (res.cancelled) return undefined;
    return res.item.value;
  }
  const label =
    current !== undefined && current !== null
      ? `${field.label} [current: ${String(current)}]`
      : field.label;
  const val = await requestTextInput({ label });
  if (val.cancelled) return undefined;
  const trimmed = val.raw.trim();
  if (!trimmed) return undefined;
  if (kind.kind === 'int') {
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== trimmed) return undefined;
    if (parsed < kind.min || parsed > kind.max) return undefined;
    return parsed;
  }
  // float01
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return undefined;
  return parsed;
}

/**
 * Ink-native re-implementation of `runProfileWizard` from the deleted
 * `src/profiles-wizard.ts`. Same three-phase flow: name → per-category
 * Configure/Use-defaults/Skip → final save confirm. Returns
 * `{cancelled:true}` if the user aborts the name prompt or save confirm.
 */
async function runProfileWizardInk(
  requestMenu: RequestMenuFn,
  requestTextInput: RequestTextInputFn,
  _flashToast: FlashToastFn,
): Promise<{ cancelled: true } | { cancelled: false; name: string; settings: ProfileSettings }> {
  let name = '';
  for (let attempt = 0; attempt < 3 && !name; attempt += 1) {
    const val = await requestTextInput({ label: 'Profile name' });
    if (val.cancelled) return { cancelled: true };
    const raw = val.raw.trim();
    const err = validateProfileName(raw);
    if (!err) {
      name = raw;
      break;
    }
    _flashToast(err, 'error');
  }
  if (!name) return { cancelled: true };

  const draft: ProfileSettings = {};

  for (const category of WIZARD_CATEGORIES_DATA) {
    const res = await requestMenu(
      [
        { label: 'Configure', description: 'Step through each setting in this category.' },
        { label: 'Use defaults', description: 'Clear any draft values so Bernard defaults win.' },
        { label: 'Skip', description: 'Leave whatever is already in the draft (or unset).' },
      ],
      { title: `${category.title} — ${category.description}` },
    );
    const choice = res.cancelled
      ? 'skip'
      : (['configure', 'use-defaults', 'skip'] as const)[res.index];
    if (choice === 'configure') {
      for (const field of category.fields) {
        const chosen = await pickWizardField(
          field,
          draft[field.key],
          requestMenu,
          requestTextInput,
        );
        if (chosen !== undefined) {
          (draft as Record<string, unknown>)[field.key as string] = chosen;
        }
      }
    } else if (choice === 'use-defaults') {
      for (const field of category.fields) {
        delete (draft as Record<string, unknown>)[field.key as string];
      }
    }
  }

  const save = await requestMenu(
    [{ label: `Save profile "${name}"` }, { label: 'Cancel without saving' }],
    { title: 'Ready to save?' },
  );
  if (save.cancelled || save.index === 1) return { cancelled: true };
  return { cancelled: false, name, settings: draft };
}

function buildDebugReportLines(
  config: BernardConfig,
  agent: Agent,
  stores: AppStores,
): Array<{ text: string; dim?: boolean; bold?: boolean }> {
  const lines: Array<{ text: string; dim?: boolean; bold?: boolean }> = [];
  lines.push({ text: 'Runtime:', bold: true });
  lines.push({ text: `  Bernard version: ${getLocalVersion()}`, dim: true });
  lines.push({ text: `  Node.js version: ${process.version}`, dim: true });
  lines.push({
    text: `  OS: ${process.platform} ${process.arch} (${os.release()})`,
    dim: true,
  });

  lines.push({ text: '' });
  lines.push({ text: 'LLM:', bold: true });
  lines.push({ text: `  Provider: ${config.provider}`, dim: true });
  lines.push({ text: `  Model: ${config.model}`, dim: true });
  lines.push({ text: `  maxTokens: ${config.maxTokens}`, dim: true });
  lines.push({ text: `  shellTimeout: ${config.shellTimeout}ms`, dim: true });
  lines.push({ text: `  tokenWindow: ${config.tokenWindow || 'auto-detect'}`, dim: true });

  lines.push({ text: '' });
  lines.push({ text: 'API Keys:', bold: true });
  for (const { provider, hasKey } of getProviderKeyStatus()) {
    lines.push({ text: `  ${provider}: ${hasKey ? 'configured' : 'not set'}`, dim: true });
  }

  lines.push({ text: '' });
  lines.push({ text: 'MCP Servers:', bold: true });
  const statuses = stores.mcp?.getServerStatuses() ?? [];
  if (statuses.length === 0) {
    lines.push({ text: '  (none configured)', dim: true });
  } else {
    for (const s of statuses) {
      lines.push({
        text: s.connected
          ? `  ${s.name}: connected (${s.toolCount} tools)`
          : `  ${s.name}: failed — ${s.error}`,
        dim: true,
      });
    }
  }

  lines.push({ text: '' });
  lines.push({ text: 'RAG:', bold: true });
  lines.push({ text: `  Enabled: ${config.ragEnabled}`, dim: true });
  if (stores.rag) {
    lines.push({ text: `  Facts: ${stores.rag.count()}`, dim: true });
  }

  lines.push({ text: '' });
  lines.push({ text: 'Memory:', bold: true });
  lines.push({
    text: `  Persistent memories: ${stores.memory.listMemory().length}`,
    dim: true,
  });

  lines.push({ text: '' });
  lines.push({ text: 'Cron:', bold: true });
  lines.push({ text: `  Daemon: ${isDaemonRunning() ? 'running' : 'stopped'}`, dim: true });
  let cronJobCount = 0;
  try {
    cronJobCount = new CronStore().loadJobs().length;
  } catch {
    // jobs.json missing — leave 0
  }
  lines.push({ text: `  Jobs: ${cronJobCount}`, dim: true });

  lines.push({ text: '' });
  lines.push({ text: 'Conversation:', bold: true });
  lines.push({ text: `  Messages: ${agent.getHistory().length}`, dim: true });

  lines.push({ text: '' });
  lines.push({ text: 'Settings:', bold: true });
  lines.push({ text: `  Theme: ${getActiveThemeKey()}`, dim: true });
  lines.push({ text: `  Coordinator mode: ${config.coordinatorMode}`, dim: true });
  lines.push({ text: `  Tool details: ${config.toolDetails ? 'on' : 'off'}`, dim: true });
  lines.push({ text: `  Prompt rewriter: ${config.promptRewriter ? 'on' : 'off'}`, dim: true });
  const debugEnabled = process.env.BERNARD_DEBUG === 'true' || process.env.BERNARD_DEBUG === '1';
  lines.push({ text: `  Debug mode: ${debugEnabled ? 'on' : 'off'}`, dim: true });

  lines.push({ text: '' });
  lines.push({ text: 'Paths:', bold: true });
  if (process.env.BERNARD_HOME) {
    lines.push({ text: `  BERNARD_HOME: ${process.env.BERNARD_HOME}`, dim: true });
  }
  lines.push({ text: `  Config: ${CONFIG_DIR}`, dim: true });
  lines.push({ text: `  Data: ${DATA_DIR}`, dim: true });
  lines.push({ text: `  Cache: ${CACHE_DIR}`, dim: true });
  lines.push({ text: `  State: ${STATE_DIR}`, dim: true });

  return lines;
}

const CREATE_SEED_PROMPTS: Record<string, string> = {
  '/create-routine': `The user wants to create a new routine interactively. Guide them through the process:

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

Remember: routine content should be written as clear instructions that Bernard can follow. Think of it like writing a mini system prompt — specific, structured, and actionable.`,
  '/create-task': `The user wants to create a new saved task interactively. Saved tasks are routines whose ID is prefixed with "task-", but they execute differently from routines: tasks run in a single-step execution model (1 LLM call + tool use → structured JSON output). Guide them through the process:

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

Remember: task content should describe a single atomic operation with clear success criteria. Unlike routines (multi-step workflows), tasks must complete in one step.`,
  '/create-specialist': `The user wants to create a new specialist agent interactively. Guide them through the process:

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

Remember: the systemPrompt should read like a persona definition — who this specialist is, what they care about, how they work. Guidelines are individual rules that can be added/removed independently.`,
};

/**
 * 5-step add-custom-provider sequence: pick SDK → name → URL → model → key,
 * then `saveCustomProvider` + `saveProviderKey`. Cancellation at any step
 * (Esc) returns null without persisting.
 *
 * Phase D replacement for `runAddProviderWizard` in the deleted readline
 * REPL. Same validation rules (`validateProviderName`, `validateBaseURL`,
 * non-empty model and key) so the on-disk shape is identical.
 */
async function runAddProviderInk(
  requestMenu: (
    entries: MenuEntry[],
    options?: MenuOptions,
  ) => Promise<{ cancelled: true } | { cancelled: false; index: number; item: MenuItem }>,
  requestTextInput: (options: ValuePromptOptions) => Promise<ValueResult>,
  flashToast: (message: string, variant?: ToastVariant) => void,
): Promise<{ entry: ReturnType<typeof saveCustomProvider>; apiKey: string } | null> {
  const sdkEntries: MenuEntry[] = SUPPORTED_SDKS.map((s) => ({ label: s, value: s }));
  const sdkResult = await requestMenu(sdkEntries, { title: 'Which SDK to use?' });
  if (sdkResult.cancelled) return null;
  const sdk = sdkResult.item.value as SupportedSdk;

  const nameResult = await requestTextInput({
    label: 'Provider name (lowercase, e.g. "ollama")',
  });
  if (nameResult.cancelled) return null;
  const name = nameResult.raw;
  const nameErr = validateProviderName(name);
  if (nameErr) {
    flashToast(nameErr, 'error');
    return null;
  }

  const urlResult = await requestTextInput({
    label: 'Base URL (e.g. http://localhost:11434/v1)',
  });
  if (urlResult.cancelled) return null;
  const baseURL = urlResult.raw;
  const urlErr = validateBaseURL(baseURL);
  if (urlErr) {
    flashToast(urlErr, 'error');
    return null;
  }

  const modelResult = await requestTextInput({ label: 'Default model name' });
  if (modelResult.cancelled) return null;
  const defaultModel = modelResult.raw;
  if (!defaultModel) {
    flashToast('Default model cannot be empty.', 'error');
    return null;
  }

  const keyResult = await requestTextInput({
    label: 'API key (any non-empty token; some local servers ignore the value)',
  });
  if (keyResult.cancelled) return null;
  const apiKey = keyResult.raw;
  if (!apiKey) {
    flashToast('API key cannot be empty.', 'error');
    return null;
  }

  try {
    const entry = saveCustomProvider({ name, sdk, baseURL, defaultModel });
    saveProviderKey(name, apiKey);
    return { entry, apiKey };
  } catch (err: unknown) {
    flashToast(err instanceof Error ? err.message : String(err), 'error');
    return null;
  }
}

function formatCatalogFooter(): string {
  const source = getCatalogSource();
  const ageMs = getCatalogAgeMs();
  if (source === 'vendored' || ageMs == null) {
    return 'Model catalog: vendored fallback — /refresh-models to fetch live.';
  }
  const mins = Math.floor(ageMs / 60_000);
  const ageLabel =
    mins < 1
      ? 'just now'
      : mins < 60
        ? `${mins}m ago`
        : `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
  return `Model catalog: ${source}, refreshed ${ageLabel} — /refresh-models to fetch.`;
}

type RequestMenu = (
  entries: MenuEntry[],
  options?: MenuOptions,
) => Promise<{ cancelled: true } | { cancelled: false; index: number; item: MenuItem }>;
type RequestGridMenu = (
  items: string[],
  options?: { title?: string; footer?: string; initialIndex?: number; currentItem?: string },
) => Promise<{ cancelled: true } | { cancelled: false; index: number }>;
type RequestTextInput = (options: ValuePromptOptions) => Promise<ValueResult>;
type FlashToast = (message: string, variant?: ToastVariant) => void;

/**
 * Two-step picker for a lineup slot: provider first (filtered to those with
 * keys), then model (rendered in a multi-column grid). Esc from the model
 * step returns to the provider step; Esc from the provider step returns
 * `null` to the editor.
 *
 * Custom providers expose a final "+ Type a new model name…" cell so the
 * user can extend the remembered model list inline. The provider step ends
 * with "+ Add custom provider…" which round-trips through `runAddProviderInk`
 * and re-renders the step with the new provider appended.
 */
async function pickLineupSlotInk(
  config: BernardConfig,
  tier: LineupTier,
  current: LineupSlot,
  requestMenu: RequestMenu,
  requestGridMenu: RequestGridMenu,
  requestTextInput: RequestTextInput,
  flashToast: FlashToast,
): Promise<LineupSlot | null> {
  const providerDisplayName = (name: string): string => {
    if (Object.hasOwn(PROVIDER_DISPLAY_NAMES, name)) {
      return PROVIDER_DISPLAY_NAMES[name as keyof typeof PROVIDER_DISPLAY_NAMES];
    }
    return name;
  };

  const modelsForProvider = (name: string): string[] => {
    if (Object.hasOwn(PROVIDER_MODELS, name)) return PROVIDER_MODELS[name];
    const custom = (config.customProviders ?? {})[name];
    if (!custom) return [];
    const models = [...custom.models];
    if (custom.defaultModel && !models.includes(custom.defaultModel)) {
      models.unshift(custom.defaultModel);
    }
    return models;
  };

  while (true) {
    const customProviders = config.customProviders ?? {};
    const available = getAvailableProviders(config);

    if (available.length === 0) {
      flashToast('No providers with API keys configured. Add one via /provider first.', 'error');
      return null;
    }

    const builtin = available.filter((p) => Object.hasOwn(PROVIDER_MODELS, p));
    const custom = available.filter((p) => Object.hasOwn(customProviders, p));

    const entries: MenuEntry[] = [];
    for (const provider of builtin) {
      const count = PROVIDER_MODELS[provider].length;
      entries.push({
        label: providerDisplayName(provider),
        annotation: `(${count} model${count === 1 ? '' : 's'})${
          provider === current.provider ? ' · current' : ''
        }`,
        active: provider === current.provider,
        value: { kind: 'provider', provider } as const,
      });
    }
    if (custom.length > 0) {
      entries.push({ type: 'section', title: 'Custom' });
      for (const provider of custom) {
        const entry = customProviders[provider];
        const count = entry.models.length > 0 ? entry.models.length : 1;
        entries.push({
          label: provider,
          annotation: `(${entry.sdk} → ${entry.baseURL})${
            provider === current.provider ? ' · current' : ''
          }`,
          active: provider === current.provider,
          description: `${count} model${count === 1 ? '' : 's'} remembered`,
          value: { kind: 'provider', provider } as const,
        });
      }
    }
    entries.push({ type: 'section', title: '' });
    entries.push({ label: '+ Add custom provider…', value: { kind: 'add-custom' } as const });

    const pick = await requestMenu(entries, {
      title: `Pick provider for ${tier.toUpperCase()} slot`,
      headerLines: [formatCatalogFooter()],
    });
    if (pick.cancelled) return null;
    const choice = pick.item.value as
      | { kind: 'provider'; provider: string }
      | { kind: 'add-custom' };

    if (choice.kind === 'add-custom') {
      const added = await runAddProviderInk(requestMenu, requestTextInput, flashToast);
      if (added) {
        config.customProviders = {
          ...(config.customProviders ?? {}),
          [added.entry.name]: added.entry,
        };
        config.apiKeys = { ...(config.apiKeys ?? {}), [added.entry.name]: added.apiKey };
      }
      continue;
    }

    const provider = choice.provider;
    const isCustom = Object.hasOwn(customProviders, provider);
    const models = modelsForProvider(provider);
    const FREE_TYPE = '+ Type a new model name…';
    const items: string[] = [...models];
    if (isCustom) items.push(FREE_TYPE);

    if (items.length === 0) {
      flashToast(`No models known for provider "${provider}".`, 'error');
      continue;
    }

    const currentModelForProvider =
      provider === current.provider ? current.model : undefined;
    const initialIndex =
      currentModelForProvider && models.includes(currentModelForProvider)
        ? models.indexOf(currentModelForProvider)
        : 0;

    const result = await requestGridMenu(items, {
      title: `Pick ${providerDisplayName(provider)} model for ${tier.toUpperCase()} slot`,
      footer: formatCatalogFooter(),
      initialIndex,
      currentItem: currentModelForProvider,
    });
    if (result.cancelled) continue; // back to provider step

    const picked = items[result.index];
    if (picked === FREE_TYPE) {
      const modelRes = await requestTextInput({ label: `New model name for ${provider}` });
      if (modelRes.cancelled || !modelRes.raw.trim()) continue;
      const model = modelRes.raw.trim();
      rememberCustomModel(provider, model);
      config.customProviders = loadCustomProviders();
      return { provider, model };
    }
    return { provider, model: picked };
  }
}

/**
 * Read-only catalog of every (provider, model) Bernard knows. Used by
 * `/provider` and `/models` — these are now management surfaces only;
 * tier→model selection lives in `/lineup`. Last entry runs the add-custom-
 * provider wizard.
 */
async function runModelsCatalogInk(
  config: BernardConfig,
  requestMenu: RequestMenu,
  requestTextInput: RequestTextInput,
  flashToast: FlashToast,
): Promise<void> {
  const customProviders = config.customProviders ?? {};
  const customNames = Object.keys(customProviders);

  const entries: MenuEntry[] = [
    { label: 'View catalog', description: 'Show all known (provider, model) pairs' },
    { label: '+ Add custom provider…' },
    { label: 'Done' },
  ];
  const pick = await requestMenu(entries, { title: 'Model catalog' });
  if (pick.cancelled || pick.index === 2) return;
  if (pick.index === 0) {
    // Showing the info overlay requires access to setPendingInfo via the
    // App scope; surface as a toast list instead. Each line emitted as a
    // single toast would spam — collapse to one summary toast with counts.
    const builtinCount = Object.values(PROVIDER_MODELS).reduce((a, b) => a + b.length, 0);
    const customCount = Object.values(customProviders).reduce(
      (a, b) => a + (b.models.length > 0 ? b.models.length : 1),
      0,
    );
    flashToast(
      `Catalog: ${builtinCount} built-in models across ${Object.keys(PROVIDER_MODELS).length} providers · ${customCount} custom models across ${customNames.length} providers. Open /lineup to bind them.`,
      'info',
    );
    return;
  }
  if (pick.index === 1) {
    const added = await runAddProviderInk(requestMenu, requestTextInput, flashToast);
    if (added) {
      config.customProviders = {
        ...(config.customProviders ?? {}),
        [added.entry.name]: added.entry,
      };
      config.apiKeys = { ...(config.apiKeys ?? {}), [added.entry.name]: added.apiKey };
      flashToast(`Added "${added.entry.name}". Bind it via /lineup.`, 'success');
    }
  }
}

/**
 * Editor for one lineup. Shows three rows (premium / mid / cheap) plus
 * rename and either "Save" (existing) or "Save as new" (draft). Returns
 * the persisted lineup on save, or `null` on cancel.
 */
async function runLineupEditorInk(
  initial: Lineup,
  config: BernardConfig,
  requestMenu: RequestMenu,
  requestGridMenu: RequestGridMenu,
  requestTextInput: RequestTextInput,
  flashToast: FlashToast,
  opts: { isNew?: boolean } = {},
): Promise<Lineup | null> {
  let draft: Lineup = { ...initial };
  while (true) {
    const tierRows: MenuEntry[] = LINEUP_TIERS.map((tier) => ({
      label: `${tier.toUpperCase()}`,
      annotation: `→ ${draft[tier].provider} / ${draft[tier].model}`,
      value: { kind: 'tier', tier },
    }));
    const entries: MenuEntry[] = [
      ...tierRows,
      { type: 'section', title: '' },
      { label: 'Rename lineup', value: { kind: 'rename' } },
      ...(opts.isNew
        ? [{ label: 'Save as new lineup', value: { kind: 'save-new' } } as MenuEntry]
        : [
            { label: 'Save changes', value: { kind: 'save' } } as MenuEntry,
            { label: 'Save as new lineup', value: { kind: 'save-new' } } as MenuEntry,
            { label: 'Delete lineup', value: { kind: 'delete' } } as MenuEntry,
          ]),
      { label: 'Cancel', value: { kind: 'cancel' } },
    ];
    const pick = await requestMenu(entries, {
      title: `Lineup: ${draft.name}${opts.isNew ? ' (draft)' : ''}`,
    });
    if (pick.cancelled) return null;
    const value = pick.item.value as
      | { kind: 'tier'; tier: LineupTier }
      | { kind: 'rename' | 'save' | 'save-new' | 'delete' | 'cancel' };
    if (value.kind === 'cancel') return null;
    if (value.kind === 'tier') {
      const next = await pickLineupSlotInk(
        config,
        value.tier,
        draft[value.tier],
        requestMenu,
        requestGridMenu,
        requestTextInput,
        flashToast,
      );
      if (next) draft = { ...draft, [value.tier]: next };
      continue;
    }
    if (value.kind === 'rename') {
      const res = await requestTextInput({
        label: 'New name',
        initialValue: draft.name,
      });
      if (res.cancelled || !res.raw.trim()) continue;
      const err = validateLineupName(res.raw);
      if (err) {
        flashToast(err, 'error');
        continue;
      }
      draft = { ...draft, name: res.raw.trim() };
      continue;
    }
    if (value.kind === 'save') {
      try {
        const saved = saveLineup({
          id: draft.id,
          name: draft.name,
          premium: draft.premium,
          mid: draft.mid,
          cheap: draft.cheap,
        });
        return saved;
      } catch (err) {
        flashToast(`Failed to save: ${(err as Error).message}`, 'error');
        continue;
      }
    }
    if (value.kind === 'save-new') {
      try {
        const saved = saveLineup({
          // omit id so saveLineup slugs from name
          name: draft.name,
          premium: draft.premium,
          mid: draft.mid,
          cheap: draft.cheap,
        });
        return saved;
      } catch (err) {
        flashToast(`Failed to save: ${(err as Error).message}`, 'error');
        continue;
      }
    }
    if (value.kind === 'delete') {
      const confirm = await requestMenu(
        [
          { label: `Delete "${draft.name}"`, description: 'This cannot be undone.' },
          { label: 'Cancel' },
        ],
        { title: 'Confirm deletion' },
      );
      if (confirm.cancelled || confirm.index === 1) continue;
      try {
        deleteLineup(draft.id);
        flashToast(`Deleted lineup "${draft.name}".`, 'success');
        return null;
      } catch (err) {
        flashToast(`Cannot delete: ${(err as Error).message}`, 'error');
        continue;
      }
    }
  }
}

/**
 * Sort-keys-first JSON so `{a:1,b:2}` and `{b:2,a:1}` produce the same string.
 * Mirrors `stableStringify` at `src/repl.ts:1122` — keeps the confirm-allow
 * session memo stable across re-renders that reshuffle object key order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** djb2 over the stable-JSON form. Matches `stableHash` at `src/repl.ts:1113`. */
function stableHash(value: unknown): string {
  let json: string;
  try {
    json = stableStringify(value);
  } catch {
    json = String(value);
  }
  let h = 5381;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) + h + json.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}
