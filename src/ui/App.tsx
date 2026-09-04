import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import {
  loadCatalog,
  getCatalogAgeMs,
  getCatalogSource,
  refreshCatalogWithDiff,
  vendoredProviderCounts,
} from '../providers/catalog.js';
import { catalogRefreshNotice } from '../catalog-notice.js';
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
  type RoleSlots,
  loadLineups,
  resolveActiveLineup,
  saveLineup,
  deleteLineup,
  listLineups,
  validateLineupName,
  PROVIDER_DISPLAY_NAMES,
} from '../lineups.js';
import { MODEL_ROLES, getRole, type RoleId } from '../model-roles.js';
import { validateLineup, formatLineupValidation } from '../model-validate.js';
import type { SupportedSdk } from '../providers/types.js';
import { THEMES, getThemeKeys, getActiveThemeKey, setTheme, getThemeColors } from '../theme.js';
import type { HistoryStore } from '../history.js';
import type { ProvenanceHistoryStore } from '../provenance-history.js';
import type { TurnContextStore } from '../turn-context.js';
import type { MemoryStore } from '../memory.js';
import type { RoutineStore, Routine } from '../routines.js';
import type { SpecialistStore, Specialist } from '../specialists.js';
import type { CandidateStore } from '../specialist-candidates.js';
import type { RAGStore, RAGSearchResult } from '../rag.js';
import type { MCPManager } from '../mcp.js';
import { CronStore } from '../cron/store.js';
import { CronLogStore } from '../cron/log-store.js';
import { isDaemonRunning, startDaemon, stopDaemon } from '../cron/client.js';
import { getDomain, getDomainIds } from '../domains.js';
import { MCP_CONFIG_PATH } from '../paths.js';
import { interactiveUpdate } from '../update.js';
import { getBuiltinSpecialistIds } from '../specialists.js';
import { promotePendingCandidates } from '../candidate-bootstrap.js';
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
import { ruleLabel, type PermissionRule, type ToolPermissionEffect } from '../tool-permissions.js';
import type { BreadthOption } from '../permissions/breadth.js';
import { applyProfileToConfig } from '../config.js';
import { setToolDetailsVisible, formatFriendlyTimestamp } from '../output.js';
import { noPromptCacheHint } from '../cost-guardrail.js';
import { makeUsageRecorder, makeOutOfTurnUsageRecorder } from '../framework/hooks/token-stats.js';
import { truncate } from '../text.js';
import { WIZARD_CATEGORIES_DATA, type WizardFieldData } from '../profiles-wizard-data.js';
import { loadImage, tryLoadImage, extractImagePaths, type ImageAttachment } from '../image.js';
import { runDefinition } from '../framework/agents/run.js';
import { taskDefinition, type TaskInput } from '../framework/agents/task.js';
import { renderTaskText } from '../framework/agents/user-message.js';
import type { CoreMessage } from 'ai';
import {
  resolveMainModel,
  mainVisionCapable,
  logSiteModelSnapshot,
  providersInUse,
} from '../model-policy.js';
import {
  serializeMessages,
  extractDomainFacts,
  extractText,
  MIN_HISTORY_FOR_FACTS,
} from '../context.js';
import { isSessionScaffolding } from '../session-markers.js';
import { detectSpecialistCandidate } from '../specialist-detector.js';
import { promoteCandidate } from '../candidate-bootstrap.js';
import {
  resolveReferences,
  stripToolResolvableTokens,
  shouldSkipResolver,
  type ResolvedEntry,
} from '../reference-resolver.js';
import { rewritePrompt } from '../prompt-rewriter.js';
import { recallFilter } from '../recall-filter.js';
import { loadRewriterHints } from '../memory.js';
import { stripImagePaths } from '../image.js';
import { getModelProfile } from '../providers/index.js';
import {
  describeModelParams,
  validateModelParams,
  type ModelParams,
  type ParamId,
  type ParamDescriptor,
} from '../providers/model-params.js';
import { debugLog, getSessionId, getSessionLogPath, isDebugEnabled } from '../logger.js';
import { SessionTelemetry } from '../session-telemetry.js';
import { withSlot, getMaxConcurrentAgents, getActiveCount } from '../tools/agent-pool.js';
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
import { Thread, REWRITE_ICON, formatDuration, type StaticItem } from './Thread.js';
import { TranscriptViewport } from './TranscriptViewport.js';
import { useDimensionsCtx } from './DimensionsContext.js';
import { formatAgentError, type ErrorPanelData } from './error-format.js';
import { Prompt } from './Prompt.js';
import type { SlashCommand } from './SlashHints.js';
import type { DispatchedCommand } from './slash-commands.js';
import { Spinner } from './Spinner.js';
import { StatusBar } from './StatusBar.js';
import { HintBar } from './HintBar.js';
import { PlanPanel } from './PlanPanel.js';
import { MenuOverlay } from './overlays/MenuOverlay.js';
import { ModelGridOverlay } from './overlays/ModelGridOverlay.js';
import { ConfirmDialog } from './overlays/ConfirmDialog.js';
import { StatusViewer } from './overlays/StatusViewer.js';
import { SourcesViewer } from './overlays/SourcesViewer.js';
import { ContextViewer } from './overlays/ContextViewer.js';
import { UsageViewer } from './overlays/UsageViewer.js';
import { HelpOverlay } from './overlays/HelpOverlay.js';
import { TextInputOverlay } from './overlays/TextInputOverlay.js';
import { InfoOverlay } from './overlays/InfoOverlay.js';
import { SettingsOverlay, type SettingsTab } from './overlays/SettingsOverlay.js';
import { Toast, type ToastVariant } from './Toast.js';
import { persistAgentState } from './save.js';
import { MessageStore } from './message-store.js';
import { setOutputSink } from '../framework/hooks/output-sink.js';
import { setInkHandlers, type MenuResult } from './ink-handlers.js';
import { injectAskUserHistoryMessages } from '../tools/ask-user-history.js';
import {
  VoiceService,
  resolveBackend,
  resolveWarmupPlayer,
  VOICE_BACKEND_VALUES,
  type VoiceBackend,
  type ResolvedBackend,
} from '../voice-service.js';
import { toSpokenForm } from '../speech-normalizer.js';
import { toLiteralSpeech } from '../speech-text.js';
import { AppRegistry, bundledAppIds } from '../apps/registry.js';
import { AppletCandidateStore, type AppletCandidate } from '../applet-candidates.js';
import { buildAppletRequest } from '../applet-detector.js';
import { notAskedLine, type PendingPermission } from '../apps/permission-consent.js';
import type { PermissionConsentRequest } from '../tools/types.js';

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
  turnContextStore: TurnContextStore;
  stores: AppStores;
  /** Per-REPL-session allowlist (#179). Owned by the caller so it survives mount. */
  sessionToolAllowlist: Set<string>;
  /** Called when the user requests exit (Ctrl-C or `/exit`). */
  onExit: () => Promise<void> | void;
  /**
   * Whether the REPL is rendering in the alternate screen buffer (full-screen).
   * Set by `src/index.ts` (true only on a TTY with `BERNARD_FULLSCREEN` on).
   * Drives the fixed-height root frame + the in-app scrollable transcript; when
   * false the layout falls back to the legacy natural-flow column.
   */
  fullScreen?: boolean;
  /**
   * Pre-built welcome-splash lines (ANSI strings) rendered at the top of the
   * transcript in full-screen. The splash is normally printed to the normal
   * screen pre-render, but the alt buffer hides that — so in full-screen
   * `src/index.ts` passes the lines here to render them inside the Ink tree.
   */
  welcomeLines?: string[];
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
  /**
   * One-time transcript notice (#264 follow-up). Set by `src/index.ts` when the
   * stored `activeLineupId` pointed at a lineup that no longer exists and was
   * auto-switched to a valid one. Rendered as a synthetic assistant message at
   * the top of the transcript on mount — UI-only, never pushed into the agent's
   * LLM history.
   */
  startupNotice?: string;
}

type Overlay =
  | 'status'
  | 'sources'
  | 'context'
  | 'usage'
  | 'menu'
  | 'multi-menu'
  | 'grid'
  | 'confirm'
  | 'help'
  | 'text-input'
  | 'info'
  | 'settings';

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
  resolve: (result: MenuResult) => void;
}

/** Multi-select's result shape — the sibling of {@link MenuResult} (#231). */
export type MultiMenuResult = { cancelled: true } | { cancelled: false; items: MenuItem[] };

/**
 * Multi-select counterpart of {@link PendingMenu} (#231). Kept separate so the
 * heavily-used single-select `requestMenu`/`PendingMenu` contract stays
 * untouched; only the `ask_user` multi-select path uses this. Resolves with the
 * checked items in row order.
 */
interface PendingMultiMenu {
  entries: MenuEntry[];
  options?: MenuOptions;
  resolve: (result: MultiMenuResult) => void;
}

interface PendingGrid {
  items: string[];
  options?: { title?: string; footer?: string; initialIndex?: number; currentItem?: string };
  resolve: (result: { cancelled: true } | { cancelled: false; index: number }) => void;
}

/**
 * The tabbed settings screen (`/options` + `/agent-options`). Both tabs' entries
 * are supplied up front so Shift+Tab cycles between them in-place without a loop
 * re-entry; the caller (`runSettings`) re-shows on the resolved tab after an
 * item's action runs so annotations refresh from the mutated config.
 */
interface PendingSettings {
  initialTab: SettingsTab;
  initialIndex: number;
  optionsEntries: MenuEntry[];
  agentEntries: MenuEntry[];
  resolve: (
    result:
      | { cancelled: true }
      | { cancelled: false; tab: SettingsTab; index: number; item: MenuItem },
  ) => void;
}

interface PendingConfirm {
  kind: 'confirm';
  input: ConfirmActionInput;
  resolve: (
    allowed: boolean,
    scope: 'once' | 'session' | 'profile',
    breadth: BreadthOption | undefined,
  ) => void;
}

interface PendingBlock {
  kind: 'block';
  input: BlockActionInput;
  resolve: (outcome: BlockOutcome, breadth: BreadthOption | undefined) => void;
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
 * Module-level voice service singleton. Created lazily on first use and
 * re-used across turns. The backend is resolved from config at creation time;
 * a null backend means TTS is unavailable on this platform/install.
 */
let _voiceService: VoiceService | null = null;

function getVoiceService(cfg: import('../config.js').BernardConfig): VoiceService {
  if (!_voiceService) {
    const resolved = resolveBackend(process.platform, cfg.voiceBackend);
    const warmup = { player: resolveWarmupPlayer(process.platform), ms: cfg.voiceWarmupMs };
    _voiceService = new VoiceService(resolved, warmup);
  }
  return _voiceService;
}

/**
 * Cancels a readback that is still inside its speech-normalization LLM pass
 * (#432).
 *
 * `VoiceService`'s own `_epoch` guard covers only the warmup window *inside*
 * `speak()`; it cannot touch work that has not reached `speak()` yet. Without
 * this, starting a new turn — or `/voice off`, or a profile switch — while the
 * previous reply is still being normalized speaks that previous reply
 * afterwards.
 *
 * An `AbortController` rather than a generation counter, because the signal has
 * to reach `generateText` to actually stop the round trip rather than merely
 * make us discard its result.
 */
let _speechAbort: AbortController | null = null;

/**
 * Carries a URL, a phone number and a small table, so toggling "Natural
 * speech" and pressing Preview again is audibly different. That is the only
 * way a user can hear what the setting does — `/voice test` is deliberately
 * literal, being an "is my audio working" check over text they typed.
 */
const VOICE_SAMPLE = [
  'Bernard finished the catalog refresh in 4200ms.',
  '',
  '| Provider | Models |',
  '| --- | --- |',
  '| anthropic | 12 |',
  '| openai | 34 |',
  '',
  'Full pricing is at https://www.anthropic.com/pricing — questions to 206-555-0198.',
].join('\n');

/** The one spelling of a resolved backend. Three call sites had already drifted
 *  between "none available" and "no backend available". */
function describeBackend(resolved: ResolvedBackend | null): string {
  return resolved ? `${resolved.backend} (${resolved.bin})` : 'none available';
}

/** Aborts a pending normalization. Deliberately does NOT tear down the service. */
function cancelPendingSpeech(): void {
  _speechAbort?.abort();
  _speechAbort = null;
}

function resetVoiceService(): void {
  // Kept separate from `cancelPendingSpeech` so a new turn can supersede a
  // pending readback without also paying for backend re-resolution (`which`
  // probes) on the next utterance.
  cancelPendingSpeech();
  if (_voiceService) {
    _voiceService.stop();
    _voiceService = null;
  }
}

/**
 * Extracts plain text from an assistant message content, handling both string
 * content and array content (filter type === 'text').
 */
function extractTextFromContent(content: import('ai').CoreMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
  }
  return '';
}

/**
 * A model-written question is a *header*, not a field label (#354). Passing it
 * as `label` put a full sentence on the input's own row; the choice path
 * already does the right thing with `requestMenu(entries, { title: q.question })`.
 *
 * `headerLines` entries render as plain `<Text>` in a column, which Ink
 * soft-wraps on its own — so no explicit wrapping is needed here.
 */
function askUserPrompt(question: string): ValuePromptOptions {
  return { label: 'Your answer', headerLines: [question] };
}

/**
 * Builds the menu entries for an `ask_user` choice question and a predicate for
 * whether a selected item is the "Other" escape hatch. Shared by the single-
 * and multi-select paths of `requestAskUser` so the #230 dedup rule lives in
 * one place: append a hatch row only when the model didn't already supply an
 * "Other"-shaped choice, and treat either the appended row (by identity — its
 * label may be custom via `otherLabel`) or any `OTHER_RE`-matching label as the
 * hatch. The matching selection routes to a free-text follow-up.
 */
function buildChoiceMenu(q: AskUserQuestion): {
  entries: MenuEntry[];
  isHatch: (item: MenuItem) => boolean;
} {
  const otherLabel = q.otherLabel?.trim() || 'Other (type your own)';
  const entries: MenuEntry[] = (q.choices ?? []).map((c) => ({ label: c }));
  const hasModelOther = (q.choices ?? []).some((c) => OTHER_RE.test(c.trim()));
  const appendedHatch = q.allowOther && !hasModelOther;
  if (appendedHatch) entries.push({ label: otherLabel });
  const hatchRow = appendedHatch ? entries[entries.length - 1] : undefined;
  return {
    entries,
    isHatch: (item) => item === hatchRow || OTHER_RE.test(item.label.trim()),
  };
}

/** Per-message character cap for the resume replay — long tool-heavy answers are
 *  truncated for readability, matching the documented behavior in README.md. */
const RESUME_REPLAY_MAX_CHARS = 2000;

/**
 * Rows the alert banner occupies when visible: its `marginTop` plus a
 * single-line bordered box (top rule, one line of text, bottom rule).
 */
const BANNER_ROWS = 4;

/**
 * Rows the live prompt chrome occupies in legacy (non-full-screen) mode, where
 * an overlay is appended BELOW it rather than replacing it: the bordered prompt
 * box (3) plus the hint/status row, with one row of slack for the toast or
 * spinner that can appear above the prompt. An estimate by construction — the
 * chrome is content-sized there — and deliberately generous, since over-
 * reserving costs one list row while under-reserving overflows the screen,
 * which is the defect being fixed.
 */
const LEGACY_INLINE_CHROME_ROWS = 5;

/**
 * Builds the transcript seed shown after `bernard -r`.
 *
 * The Ink cutover dropped the old `printConversationReplay` call and left an
 * empty stub, so resume restored the model's context but rendered nothing —
 * indistinguishable from a cold start. This rebuilds the replay against the
 * `<Static>`/`StaticItem` path so there is no second render path to drift.
 *
 * Only real conversation survives: `tool` messages and tool-call parts are the
 * bulk of a resumed history and are noise in a recap, and the seams Bernard
 * injects itself (context summaries, truncation notices, the session boundary
 * pair) would otherwise render as if the user or the model had said them. Keys
 * are namespaced so they can never collide with the numeric `itemKeyRef`
 * counter that drives live turns.
 */
export function buildResumeSeed(history: CoreMessage[], toolDetails: boolean): StaticItem[] {
  const items: StaticItem[] = [];
  for (const message of history) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = extractText(message)?.trim();
    if (!text || isSessionScaffolding(text)) continue;
    items.push({
      key: `resume-${items.length}`,
      message: { role: message.role, content: truncate(text, RESUME_REPLAY_MAX_CHARS) },
      toolDetails,
    });
  }
  return items;
}

/**
 * Top-level Ink component. Owns the lifecycle of a Bernard REPL session:
 * turn submission, history versioning, overlay queueing, Shift-Tab cycling,
 * and Esc handling. Ctrl-C is *not* handled here: Ink's `exitOnCtrlC` default
 * unmounts on it before any `useInput` runs (#360), which reaches `onExit` via
 * the unmount effect below.
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
/**
 * Opens a modal overlay as a promise that settles exactly once, whether the
 * user answers it or the caller's `AbortSignal` fires first (#266).
 *
 * Every overlay request needs the same five things: a synchronous pre-check so
 * an already-aborted signal never mounts anything, a `settled` latch so an
 * abort racing a keystroke resolves once, an `onAbort` that tears the overlay
 * DOWN before resolving (otherwise the frame keeps a dialog nobody can answer),
 * `{ once: true }`, and `removeEventListener` on the normal path so a
 * long-lived signal does not retain the closure.
 *
 * That was written out five times — and the previous comment here *described*
 * the five copies as "shared verbatim", which is the tell. The parameterised
 * parts are only which pending slot to clear and what "cancelled" means for
 * this result type; `install` runs any per-overlay work (a session-allowlist
 * write, a persisted permission rule) before calling `settle`. Collapsing them
 * puts overlay teardown in ONE place, which is what stops the sixth overlay
 * from forgetting `setActiveOverlay(null)`.
 */
function openOverlay<T>(
  signal: AbortSignal | undefined,
  cancelled: T,
  close: () => void,
  install: (settle: (value: T) => void) => void,
): Promise<T> {
  if (signal?.aborted) return Promise.resolve(cancelled);
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const onAbort = () => {
      close();
      finish(cancelled);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    install((value) => {
      signal?.removeEventListener('abort', onAbort);
      finish(value);
    });
  });
}

/**
 * The two shapes every slash branch in `handleSubmit` tests, typed so the
 * command literal must be a member of `DISPATCHED_COMMANDS` (#393).
 *
 * They look like ceremony around `===` and `startsWith`, and deleting them
 * would silently gut the guarantee they exist for — so: `DISPATCHED_COMMANDS`
 * is the list `__tests__/slash-catalogue.test.ts` reconciles against the
 * documented catalogue, and **these helpers are the only thing making that
 * list true**. Written as bare literals the branches agree with the array by
 * nobody's decision; routed through `DispatchedCommand`, `is(text, '/foo')`
 * does not compile until `/foo` is in the array. That is the historical failure
 * — `/session-log` shipped dispatched and documented nowhere — caught at the
 * branch, before a test runs.
 *
 * The helpers can only do that when they are actually used: a bare
 * `text === '/foo'` type-checks perfectly well, so the type alone would leave
 * the guarantee resting on whoever writes the next branch remembering the
 * house style. `eslint.config.mjs` closes that with a `no-restricted-syntax`
 * rule scoped to this file, banning the raw comparison outright so the helper
 * is the only way to write it. Delete the rule and these comments become
 * aspirational rather than true.
 *
 * Conditions only. Branch bodies read `text` directly (they slice args off it),
 * which is why these take the raw string rather than owning the parse.
 */
const is = (text: string, command: DispatchedCommand): boolean => text === command;

/**
 * Prefix form, for the four commands that take arguments. The trailing space is
 * part of the test: `/task` must not swallow a routine named `/taskboard`.
 */
const startsWithCmd = (text: string, command: DispatchedCommand): boolean =>
  text.startsWith(`${command} `);

/**
 * Standalone toggles consolidated into `/agent-options` or `/options` in
 * pre-Phase-D releases, mapped to the pointer each one flashes.
 *
 * Module scope rather than a per-submit object literal, and keyed on
 * `DispatchedCommand`: these three dispatch by lookup instead of by an `if`, so
 * without the key type they would be the one part of the chain the compile-time
 * check above could not see — precisely the invisible-shape problem #393 exists
 * to remove.
 */
const LEGACY_TOGGLE_POINTERS: Readonly<Record<string, string | undefined>> = {
  '/react': 'Coordinator (ReAct) mode → /agent-options',
  '/tool-details': 'Tool-call details → /agent-options',
  '/debug': 'Debug logging → /options',
} satisfies Partial<Record<DispatchedCommand, string>>;

export function App({
  agent,
  config,
  historyStore,
  provenanceHistoryStore,
  turnContextStore,
  stores,
  sessionToolAllowlist: _sessionToolAllowlist,
  onExit,
  alertBanner,
  isFreshInstall,
  startupNotice,
  fullScreen = false,
  welcomeLines,
}: AppProps) {
  const { exit } = useApp();
  const { rows } = useDimensionsCtx();
  const [activeOverlay, setActiveOverlay] = useState<Overlay | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether the input line is currently empty — drives the transcript's Home/End
  // jump gating (full-screen). Flipped by `<Prompt onEmptyChange>` only when the
  // boolean changes, so it doesn't re-render `<App>` on every keystroke.
  const [promptEmpty, setPromptEmpty] = useState(true);
  // Mouse-wheel transcript scrolling is on when full-screen and not opted out.
  const mouseEnabled = fullScreen && config.mouse;
  // Append-only log of finalized turns, rendered through Ink's `<Static>` so
  // each entry becomes terminal scrollback that is never repainted (#232).
  // `<App>` commits to this at turn boundaries; the streaming message and the
  // rest of the UI stay in the dynamic region.
  // History already in the agent at mount — non-empty only when `--resume`
  // restored a prior session (`src/index.ts` seeds `initialHistory`). Read once:
  // the transcript seed and both commit cursors below must agree on it, and
  // three independent reads of a live array is the fragile way to do that.
  const restoredHistory = useRef(agent.getHistory()).current;
  // Seeded from the restored history so the user can see what came back; a cold
  // start yields `[]`. Lazy initializer — runs once, at mount.
  const [staticItems, setStaticItems] = useState<StaticItem[]>(() =>
    buildResumeSeed(restoredHistory, config.toolDetails),
  );
  // Bumped only by /clear to remount <Thread> and reset <Static>'s internal
  // high-water cursor (Static only appends — it cannot un-print, so the reset
  // has to come from a fresh mount). Normal turns never touch this, so they no
  // longer remount the whole transcript the way the old historyVersion key did.
  const [staticEpoch, setStaticEpoch] = useState(0);
  // Number of `agent.getHistory()` messages already committed to `staticItems`.
  // Each commit appends `history.slice(committedLen)` and advances this. On
  // resume it starts at the restored length: `buildResumeSeed` above already
  // rendered that history, and leaving the cursor at 0 would make the first
  // commit re-emit the entire backlog — including every raw tool-result
  // message — the moment the user types their first line.
  const committedLenRef = useRef(restoredHistory.length);
  // The history ARRAY reference we last committed against. Normal appends mutate
  // the same array in place (push), so the reference is stable; but
  // `Agent.processInput` REASSIGNS `this.history` to a new, shorter array when
  // automatic context compression / emergency truncation fires mid-turn. When
  // that happens the length cursor above is meaningless for the new array, so
  // we re-anchor against this turn's user message instead of slicing blindly.
  // Anchored to the restored array on resume so the re-anchor guard in
  // `commitNewHistory` doesn't mistake the seeded cursor for a first-ever commit.
  const historyRef = useRef<CoreMessage[] | null>(
    restoredHistory.length > 0 ? restoredHistory : null,
  );
  // Monotonic source for `StaticItem.key`. Deliberately NOT the history index:
  // /compact shrinks history, so index-based keys would collide with already
  // emitted items. A counter never repeats.
  const itemKeyRef = useRef(0);
  const [pendingMenu, setPendingMenu] = useState<PendingMenu | null>(null);
  const [pendingMultiMenu, setPendingMultiMenu] = useState<PendingMultiMenu | null>(null);
  const [pendingGrid, setPendingGrid] = useState<PendingGrid | null>(null);
  const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null);
  const [pendingTextInput, setPendingTextInput] = useState<PendingTextInput | null>(null);
  const [pendingInfo, setPendingInfo] = useState<PendingInfo | null>(null);
  const [pendingSettings, setPendingSettings] = useState<PendingSettings | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [bannerVisible, setBannerVisible] = useState<boolean>(!!alertBanner);
  const [interrupted, setInterrupted] = useState(false);
  // Sub-dispatches alive at the moment Esc was pressed (#403). Sampled in the
  // key handler, not in the turn's `finally`: by the time the abort has
  // unwound, every `withSlot` / `withUncappedSlot` has run its release in a
  // `finally` and the count reads 0 — so the one place the number is true is
  // the keystroke that killed them.
  const interruptInFlightRef = useRef(0);
  const [slashActive, setSlashActive] = useState(false);
  const colors = getThemeColors();

  // Session input history for the Prompt's ↑/↓ recall. A stable array the Prompt
  // reads live; appended on each user submit. Lives here (not in Prompt) so it
  // survives the Prompt unmounting while a Shift-Tab viewer is open.
  const inputHistory = useRef<string[]>([]).current;
  const recordInput = (text: string) => {
    if (inputHistory[inputHistory.length - 1] !== text) inputHistory.push(text);
    if (inputHistory.length > 200) inputHistory.splice(0, inputHistory.length - 200);
  };

  // Saved routines + tasks, surfaced as `/<id>` slash-command completions so the
  // user can autocomplete and invoke them like any built-in command. Read live
  // from the store (stable getter) so newly-created routines appear immediately.
  const getDynamicCommands = useCallback(
    (): SlashCommand[] =>
      stores.routines.list().map((r) => ({
        name: `/${r.id}`,
        description: `${r.id.startsWith('task-') ? 'task' : 'routine'} · ${r.name}`,
      })),
    [stores.routines],
  );

  // Applet suggestions (#430). Not threaded through `AppStores`: it is read by
  // exactly one slash command and written by a detached exit worker that
  // constructs its own, so a shared instance would buy nothing and add a
  // constructor to every test that builds the prop.
  const appletCandidates = useMemo(() => new AppletCandidateStore(), []);

  // Confirm-action session memo: `${toolName}:${stableHash(args)}` → true.
  // Mirrors the legacy REPL's confirm-allow-for-session map.
  const confirmAllowSession = useRef<Map<string, boolean>>(new Map());
  // One-shot guard so onExit runs exactly once whether the user types
  // `/exit` (handleSubmit) or the Ink tree unmounts (useEffect cleanup).
  const exitedRef = useRef(false);
  // Cost guardrail (#298): latches true the first time we warn about a large
  // prefix re-billed on a non-caching provider, so the hint fires once/session.
  const noCacheWarnedRef = useRef(false);
  // Speech normalization (#432) is on by default, so the first time it actually
  // changes what a listener hears, say so — once per session. Latched on a real
  // `'normalized'` outcome rather than on the setting, so nobody who wouldn't
  // notice a difference gets told.
  const speechNoticeShownRef = useRef(false);
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

  // Gate the App-level useInput so it never fires concurrently with an
  // overlay's own useInput. Every overlay — modal (menu, confirm, help,
  // text-input) AND viewer (status, sources) — owns its own keystream now;
  // the viewers handle Esc/Shift-Tab/scroll inside <ScrollableOverlay> and
  // forward close/cycle back via callbacks. App's useInput only runs when no
  // overlay is open: Shift-Tab opens the first viewer tab, Esc interrupts a
  // busy turn.
  const appInputActive = activeOverlay === null;
  // A Shift-Tab viewer tab takes over the screen: while one is open the live
  // chrome (spinner, plan panel, toast, prompt, hint/status bars) is hidden so
  // the viewer reads as a replacement for the thread, not an addition below it.
  // <Thread> itself stays mounted (unmounting it reprints <Static> scrollback).
  //
  // 'help' is in this list despite not being a Shift-Tab tab (#392): the flag
  // decides whether the overlay REPLACES the chrome or is appended under it,
  // and in legacy inline mode help was landing below the whole prompt box —
  // five more rows on a surface that already overflowed the frame. Full-screen
  // was never affected; it branches on `activeOverlay !== null` instead.
  const viewerActive =
    activeOverlay === 'help' ||
    activeOverlay === 'status' ||
    activeOverlay === 'sources' ||
    activeOverlay === 'context' ||
    activeOverlay === 'usage' ||
    activeOverlay === 'settings';

  useInput(
    (_input, key) => {
      // Shift-Tab opens the first viewer tab (Agent Status) while idle; the
      // viewer itself cycles to Sources and back to the thread.
      if (key.shift && key.tab) {
        if (busy) return;
        setActiveOverlay('status');
        return;
      }
      if (key.escape) {
        // This handler only runs when no overlay is open (isActive gate), so
        // Esc here can only mean "interrupt the in-flight turn". Each overlay
        // owns its own Esc-to-close via its own useInput.
        debugLog('app:esc', { busy, hasTurnAbort: !!turnAbortRef.current });
        // Esc silences the voice, busy or not (#432). Previously it aborted the
        // turn and left the utterance playing — and the readback itself starts
        // *after* `busy` clears, so the not-busy branch is the one that matters.
        // Both are no-ops when nothing is speaking or pending.
        cancelPendingSpeech();
        // The bare singleton, not `getVoiceService(config)`: that constructs on
        // first use, forking up to six `which` probes (~8 ms) inside a keystroke
        // handler — to stop a service that, never having been constructed,
        // cannot be speaking.
        _voiceService?.stop();
        if (busy) {
          interruptInFlightRef.current = getActiveCount();
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
    // Deps intentionally limited to [agent]: session boundaries are per-mount, not per-config-change.
  }, [agent]);

  // Attach a persistent SpinnerStats object that the framework's token-stats
  // hooks mutate in place. <StatusBar> polls this for the pinned bottom-right readout.
  // We never null it out — the object lives for the whole session; its per-turn
  // ↑/↓ odometer (`turnPromptTokens`/`turnCompletionTokens`) is reset at the top
  // of every turn by `Agent.processInput` (#234). Seeded in a mount-time effect
  // (StrictMode-safe; render-body side effects double-fire and would re-overwrite
  // the object on every re-render including the StatusBar tick).
  useEffect(() => {
    if (!agent.spinnerStats) {
      agent.setSpinnerStats({
        startTime: Date.now(),
        turnPromptTokens: 0,
        turnCompletionTokens: 0,
        latestPromptTokens: 0,
        turnCacheReadTokens: 0,
        turnCacheWriteTokens: 0,
        model: resolveMainModel(config),
        contextWindowOverride: config.tokenWindow || undefined,
        turnLedger: new Map(),
        sessionCostUsd: 0,
        sessionCostPartial: false,
        // Durable, cross-turn LLM telemetry (#session-telemetry). Shares the
        // debug logger's session id so telemetry lines correlate with the
        // session debug JSONL. Persists to its own per-session file (opt-out via
        // BERNARD_TELEMETRY).
        sessionTelemetry: new SessionTelemetry(getSessionId()),
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
    requestPermissionConsent: typeof requestPermissionConsent;
  } | null>(null);
  useEffect(() => {
    setInkHandlers({
      // Forwards `signal` — the shim used to take only two parameters, so a
      // signal handed to `getInkHandlers().requestMenu` was silently dropped
      // one frame short of the overlay (#266).
      requestMenu: (entries, options, signal) =>
        handlersRef.current!.requestMenu(entries, options, signal),
      requestConfirm: (input, signal) => handlersRef.current!.requestConfirm(input, signal),
      requestBlock: (input, signal) => handlersRef.current!.requestBlock(input, signal),
      requestTextInput: (options, signal) => handlersRef.current!.requestTextInput(options, signal),
      requestAskUser: (questions, signal) => handlersRef.current!.requestAskUser(questions, signal),
      requestPermissionConsent: (request, signal) =>
        handlersRef.current!.requestPermissionConsent(request, signal),
      requestConfirmDangerous: async (command, signal) => {
        // The signal now reaches the overlay, so an abort while the menu is on
        // screen tears it down. The two `signal?.aborted` polls this replaces
        // bracketed an await that could not be interrupted: they could only
        // observe an abort that happened before the menu opened or after the
        // user had already answered it.
        const result = await handlersRef.current!.requestMenu(
          [{ label: 'Allow once' }, { label: 'Cancel' }],
          { title: `⚠ Dangerous command: ${command}` },
          signal,
        );
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

  // Startup model-catalog refresh (#264 follow-up, extended by #306). Every
  // launch force-fetches the live gateway catalog in the background and reports
  // what changed. Non-blocking and fail-silent — an offline gateway just leaves
  // the cached/vendored catalog in place.
  //
  // The decision of *what* is worth saying lives in `catalogRefreshNotice`
  // (pure, unit-tested); this hook only surfaces it. Removals used to be
  // discarded here, which is how a whole provider vanishing produced no signal
  // at all (#306). A wiped provider goes into the transcript rather than a
  // toast: toasts are cleared by the next submit, and "your cost and context
  // numbers are now wrong" must outlive a keystroke.
  const catalogRefreshRanRef = useRef(false);
  useEffect(() => {
    if (catalogRefreshRanRef.current) return;
    catalogRefreshRanRef.current = true;
    void (async () => {
      try {
        const diff = await refreshCatalogWithDiff();
        const notice = catalogRefreshNotice(diff, {
          providersInUse: providersInUse(config),
          vendoredByProvider: vendoredProviderCounts(),
        });
        switch (notice.kind) {
          // Both go to the transcript rather than a toast: `handleSubmit`
          // clears toasts on the next keystroke, and "your cost and context
          // numbers are wrong" has to outlive that.
          case 'provider-empty':
          case 'provider-wiped':
            pushAssistantNotice(notice.message);
            break;
          case 'removed':
            flashToast(notice.message, 'warning');
            break;
          case 'added':
            flashToast(notice.message, 'success');
            break;
          case 'none':
            break;
        }
      } catch {
        // Never block or crash startup over a catalog refresh.
      }
    })();
    // Intentionally run once on mount (deps omitted).
  }, []);

  // One-time lineup-correction notice (#264 follow-up). When `src/index.ts`
  // auto-switched a dangling `activeLineupId`, surface a synthetic assistant
  // message at the top of the transcript so the silent fallback is visible.
  // UI-only: it goes straight into `staticItems`, never into `agent.history`,
  // so it isn't persisted to conversation-history.json or replayed on resume.
  // Does NOT advance `committedLenRef` (that cursor tracks the agent's real
  // history slice); a synthetic item carries no backing history message.
  const startupNoticeRanRef = useRef(false);
  useEffect(() => {
    if (startupNoticeRanRef.current || !startupNotice) return;
    startupNoticeRanRef.current = true;
    setStaticItems((prev) => [
      ...prev,
      {
        key: String(itemKeyRef.current++),
        message: { role: 'assistant', content: startupNotice },
        toolDetails: false,
      },
    ]);
    // Intentionally run once on mount (deps omitted).
  }, []);

  const flashToast = (message: string, variant: ToastVariant = 'info') => {
    setToast({ message, variant });
  };

  // Push a UI-only assistant notice into the transcript (same mechanism as the
  // startup lineup-correction notice): straight into `staticItems`, never into
  // `agent.history`, so it isn't persisted or replayed.
  const pushAssistantNotice = (content: string) => {
    setStaticItems((prev) => [
      ...prev,
      {
        key: String(itemKeyRef.current++),
        message: { role: 'assistant', content },
        toolDetails: false,
      },
    ]);
  };

  // Warn-only lineup validation (#264 follow-up). After a save/switch we
  // live-probe the lineup's models in the background and, IF any are
  // unreachable, surface a notice. Never blocks the save and fails open — a
  // probe-layer error or offline gateway just skips the warning.
  const warnValidateLineup = (lineup: Lineup) => {
    void (async () => {
      try {
        const v = await validateLineup(config, lineup);
        if (v.ok) return;
        pushAssistantNotice(
          `⚠ Lineup "${v.lineupName}" was saved, but ${v.failures} of ${v.results.length} model(s) failed a live check:\n\n` +
            formatLineupValidation(v) +
            `\n\nFix the names with /lineup, or switch with /lineups. (A reachable model can still be too weak for a task — this only checks access.)`,
        );
      } catch {
        // fail open — never let validation noise block or crash the REPL
      }
    })();
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
    if (is(text, '/exit') || is(text, '/quit')) {
      if (exitedRef.current) return;
      exitedRef.current = true;
      await onExit();
      exit();
      return;
    }
    if (is(text, '/clear') || startsWithCmd(text, '/clear')) {
      const clearArgs = text.slice('/clear'.length).trim();
      const shouldSave = clearArgs === '--save' || clearArgs === '-s';
      if (clearArgs && !shouldSave) {
        flashToast('Usage: /clear [--save|-s]', 'error');
        return;
      }
      if (shouldSave) {
        const history = agent.getHistory();
        // MIN_HISTORY_FOR_FACTS = 2 (one user + one assistant);
        // matches the exit-path threshold in src/index.ts.
        if (history.length < MIN_HISTORY_FOR_FACTS) {
          flashToast('Not enough conversation to summarize.', 'warning');
        } else {
          setBusy(true);
          try {
            const serialized = serializeMessages(history);
            // Route these off-loop /clear --save LLM calls (fact extraction,
            // specialist detection) through the session telemetry sink so they
            // aren't an accounting hole (#session-telemetry).
            const recordSaveUsage = makeUsageRecorder(agent);
            // Cap fact extraction at 60 s to prevent a hung LLM call from
            // freezing the REPL. Fails open: timeout → empty domain facts.
            // AbortSignal.timeout auto-cancels without manual teardown.
            const extractSignal = AbortSignal.timeout(60_000);
            // No prose summary here (#307): `extractDomainFacts` already routes
            // this transcript to RAG, including the `conversations` domain.
            //
            // Do NOT "fix" that by passing a prose summary to `addFacts`: the
            // embedder (Xenova/all-MiniLM-L6-v2) truncates at 512 tokens with no
            // guard, so a multi-paragraph summary would be silently cut, and its
            // mean-pooled vector would rarely clear the retrieval threshold.
            const [domainFacts, candidateResult] = await Promise.all([
              extractDomainFacts(serialized, config, recordSaveUsage, extractSignal),
              detectSpecialistCandidate(
                serialized,
                config,
                stores.specialists.list(),
                stores.candidates.listPending(),
                recordSaveUsage,
              ).catch(() => null),
            ]);
            if (stores.rag && domainFacts.length > 0) {
              const results = await Promise.allSettled(
                domainFacts.map((df) => stores.rag!.addFacts(df.facts, 'clear-save', df.domain)),
              );
              let storedFacts = 0;
              let failedDomains = 0;
              results.forEach((r) => {
                if (r.status === 'fulfilled') {
                  // addFacts returns the number of new facts actually stored
                  // (after dedup), not the input count.
                  storedFacts += r.value;
                } else {
                  failedDomains++;
                }
              });
              if (storedFacts > 0) {
                debugLog('app:clear-save:rag', { storedFacts });
              }
              if (failedDomains > 0) {
                flashToast(
                  `Warning: ${failedDomains} domain(s) failed to save to RAG memory.`,
                  'warning',
                );
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
      turnContextStore.clear();
      agent.clearHistory();
      setInterrupted(false);
      // Reset the append-only log and remount <Thread> (via the epoch bump).
      // In legacy <Static> mode this resets Static's internal high-water cursor
      // (Static only appends — an empty `items` array alone can't un-print).
      // In full-screen mode the epoch bump remounts <TranscriptViewport>,
      // resetting its scroll offset; the dynamic frame repaints empty on its
      // own, so the physical-wipe escape that legacy mode needed is gone.
      setStaticItems([]);
      committedLenRef.current = 0;
      // clearHistory() reassigns this.history to a fresh []; track the new
      // reference so the next commit doesn't mistake it for a mid-turn replace.
      historyRef.current = agent.getHistory();
      if (!fullScreen) process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
      setStaticEpoch((e) => e + 1);
      flashToast('Conversation history cleared.', 'success');
      return;
    }
    if (is(text, '/help')) {
      setActiveOverlay('help');
      return;
    }
    if (is(text, '/session-log')) {
      flashToast(
        isDebugEnabled()
          ? `Session log: ${getSessionLogPath()}`
          : 'Session log is disabled. Start Bernard with BERNARD_DEBUG=1 to record one.',
      );
      return;
    }
    if (is(text, '/refresh-models')) {
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
    if (is(text, '/memory')) {
      const keys = stores.memory.listMemory();
      flashToast(
        keys.length === 0
          ? 'No persistent memories stored.'
          : `Persistent memories (${keys.length}): ${keys.join(', ')}`,
      );
      return;
    }
    if (is(text, '/scratch')) {
      const keys = stores.memory.listScratch();
      flashToast(
        keys.length === 0
          ? 'No scratch notes in this session.'
          : `Scratch notes (${keys.length}): ${keys.join(', ')}`,
      );
      return;
    }
    if (is(text, '/compact')) {
      const history = agent.getHistory();
      if (history.length < MIN_HISTORY_FOR_FACTS) {
        flashToast('Not enough conversation to compact.', 'warning');
        return;
      }
      setBusy(true);
      try {
        const result = await agent.compactHistory();
        if (!result.compacted) {
          flashToast('Nothing to compact — conversation is already short enough.');
        } else {
          // Compaction reassigns this.history to a new, shorter array; resync
          // the commit boundary to its length AND track the new reference so
          // the next commit doesn't re-anchor as if it were a mid-turn replace.
          // The already-printed transcript stays in scrollback (it genuinely
          // happened) and Static keeps appending below — monotonic item keys
          // can't collide even though history indices shifted, so no remount.
          committedLenRef.current = agent.getHistory().length;
          historyRef.current = agent.getHistory();
          const pct = Math.round(
            ((result.tokensBefore - result.tokensAfter) / result.tokensBefore) * 100,
          );
          flashToast(
            `Compacted: ~${result.tokensBefore} → ~${result.tokensAfter} tokens (${pct}% reduction)`,
            'success',
          );
        }
        persistAgentState({ agent, historyStore, provenanceHistoryStore, turnContextStore });
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

    if (is(text, '/policy')) {
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

    if (is(text, '/usage') || is(text, '/cost')) {
      // Opens the scrollable Usage & Cost viewer (#258) — the same tab reachable
      // via Shift-Tab. Shows the last turn's per-tier/model token + cost breakdown.
      setActiveOverlay('usage');
      return;
    }

    if (is(text, '/mcp')) {
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
      // Grouped by server and shown as the tool's own name. Since #413 the
      // registry key is `<server>_<hash>__<tool>`, so one flat comma-joined
      // list would repeat the same prefix on every entry and bury the part the
      // user is actually looking for.
      // Raw names straight from the manager. Re-deriving them from the
      // namespaced registry key would be lossy (`sanitize` rewrites `.` to `_`,
      // and the last truncation rung is not invertible), and would also run the
      // whole tool conversion just to read keys.
      for (const [server, names] of Object.entries(stores.mcp.getServerToolNames())) {
        if (names.length === 0) continue;
        lines.push({ text: '' });
        lines.push({ text: `${server}: ${names.join(', ')}`, dim: true });
      }
      showInfo('MCP servers', lines);
      return;
    }

    if (is(text, '/cron')) {
      const store = new CronStore();
      // Start/stop the daemon to match whether any job is enabled — mirrors the
      // ensureDaemon / stopIfNoEnabledJobs side-effects of the cron tools.
      const syncDaemon = () => {
        try {
          const anyEnabled = store.loadJobs().some((j) => j.enabled);
          const running = isDaemonRunning();
          if (anyEnabled && !running) startDaemon();
          else if (!anyEnabled && running) stopDaemon();
        } catch (err) {
          // startDaemon/stopDaemon can throw (e.g. the compiled daemon script is
          // missing in a dev/test checkout). Surface it instead of letting the
          // exception bubble out of the /cron menu and crash the UI — mirrors how
          // the cron tools' ensureDaemon() path catches and reports.
          flashToast(
            `Daemon control failed: ${err instanceof Error ? err.message : String(err)}`,
            'error',
          );
        }
      };
      let firstPass = true;
      let listIndex = 0;
      for (;;) {
        const jobs = store.loadJobs();
        if (jobs.length === 0) {
          if (firstPass) flashToast('No cron jobs configured. Ask me to schedule one.');
          return;
        }
        firstPass = false;
        const byId = new Map(jobs.map((j) => [j.id, j]));
        const entries: MenuEntry[] = jobs.map((j) => ({
          label: j.name,
          annotation: j.enabled ? 'enabled' : 'disabled',
          description: `${j.schedule} — ${
            j.lastRun
              ? `last: ${new Date(j.lastRun).toLocaleString()} (${j.lastRunStatus || 'unknown'})`
              : 'never run'
          }`,
          value: j.id,
        }));
        const pick = await requestMenu(entries, {
          title: 'Cron jobs — select one',
          headerLines: [`Daemon: ${isDaemonRunning() ? 'running' : 'stopped'}`],
          initialIndex: listIndex,
        });
        if (pick.cancelled) return; // Esc on the list → exit
        listIndex = pick.index;
        const job = byId.get(pick.item.value as string);
        if (!job) continue;
        const action = await requestMenu(
          [
            { label: job.enabled ? 'Disable' : 'Enable' },
            { label: 'View logs' },
            { label: 'Delete' },
            { label: 'Back' },
          ],
          { title: `"${job.name}" — ${job.schedule}` },
        );
        if (action.cancelled || action.index === 3) continue; // Back / Esc → list
        if (action.index === 0) {
          store.updateJob(job.id, { enabled: !job.enabled });
          syncDaemon();
          flashToast(`"${job.name}" ${job.enabled ? 'disabled' : 'enabled'}.`, 'success');
          continue; // back to the refreshed list
        }
        if (action.index === 1) {
          // View logs opens an InfoOverlay → exit the loop (it would otherwise
          // be replaced by the next menu immediately).
          const log = new CronLogStore().getEntries(job.id, 10);
          if (log.length === 0) {
            showInfo(`Logs — ${job.name}`, [{ text: 'No runs recorded yet.', dim: true }]);
            return;
          }
          const lines: PendingInfo['lines'] = [];
          for (const e of log) {
            lines.push({
              text: `${new Date(e.startedAt).toLocaleString()} — ${e.success ? 'success' : 'error'} (${e.durationMs}ms)`,
              bold: true,
            });
            lines.push({
              text: `  ${truncate((e.error || e.finalOutput || '').replace(/\s+/g, ' '), 120)}`,
              dim: true,
            });
          }
          showInfo(`Logs — ${job.name}`, lines);
          return;
        }
        // Delete path — confirm, then remove the job + its logs.
        if (!(await confirmDeletion(requestMenu, job.name))) continue; // back to list
        store.deleteJob(job.id);
        new CronLogStore().deleteJobLogs(job.id);
        syncDaemon();
        flashToast(`Deleted ${job.name}.`, 'success');
        continue;
      }
    }

    if (is(text, '/rag')) {
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

    if (is(text, '/facts')) {
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

    if (is(text, '/update')) {
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

    if (is(text, '/theme')) {
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

    if (is(text, '/tool-permissions')) {
      await runToolPermissionsMenu();
      return;
    }

    if (is(text, '/voice') || startsWithCmd(text, '/voice')) {
      const arg = text.slice('/voice'.length).trim();

      // `/voice test [text]` — speak a phrase immediately, regardless of on/off.
      // Deliberately literal: the user typed these words and is checking that
      // audio works at all. Routing it through the normalizer would turn a
      // one-subsystem check into a two-subsystem, non-deterministic one. The
      // deterministic pass still runs — it is free and bounds the length.
      if (arg === 'test' || arg.startsWith('test ')) {
        const phrase = arg.slice('test'.length).trim() || 'Hello from Bernard.';
        const svc = getVoiceService(config);
        if (!svc.backend) {
          flashToast('No TTS backend available on this system.', 'error');
          return;
        }
        void svc
          .speak(toLiteralSpeech(phrase), { voice: config.voiceVoice, rate: config.voiceRate })
          .catch(() => {
            // Fail silently — TTS errors must never crash the REPL.
          });
        flashToast(`Speaking: "${phrase}"`, 'info');
        return;
      }

      if (arg === 'status') {
        showVoiceStatus();
        return;
      }

      // `/voice on` / `/voice off` — direct enable/disable, no menu.
      if (arg === 'on' || arg === 'off') {
        config.voiceTts = arg === 'on';
        // Disabling stops any in-flight speech and tears down the singleton.
        if (!config.voiceTts) resetVoiceService();
        persistVoice();
        flashToast(
          `Voice TTS ${config.voiceTts ? 'enabled' : 'disabled'} (backend: ${config.voiceBackend}).`,
          'success',
        );
        return;
      }

      // Bare `/voice` (or any unrecognized argument) — the settings menu.
      await runVoiceMenu();
      return;
    }

    if (is(text, '/provider') || is(text, '/models')) {
      await runModelsCatalogInk(config, requestMenu, requestTextInput, flashToast);
      return;
    }

    if (is(text, '/model')) {
      flashToast(
        'Model selection is now per-tier. Use /lineup to edit the active lineup, or /lineups to switch.',
        'info',
      );
      return;
    }

    if (is(text, '/lineup')) {
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
        warnValidateLineup(edited);
      }
      return;
    }

    if (is(text, '/lineups')) {
      const all = listLineups();
      // Resolve once so a stale `config.activeLineupId` (e.g. pointing at a
      // lineup the user deleted) falls through to whatever resolveActiveLineup
      // picks instead of leaving every row marked as not-active.
      const activeId = resolveActiveLineup(
        loadLineups(),
        config.activeLineupId,
        config.provider,
      ).id;
      const primaryRole = MODEL_ROLES[0];
      const entries: MenuEntry[] = all.map((l) => ({
        label: l.name,
        annotation: `(${l.id})`,
        active: l.id === activeId,
        description: `${primaryRole.id} — ${summarizeRoleSlots(l.roles[primaryRole.id])}`,
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
          warnValidateLineup(created);
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
          warnValidateLineup(edited);
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
      warnValidateLineup(target);
      return;
    }

    if (is(text, '/agent-options')) {
      await runSettings('agent-options');
      return;
    }

    if (is(text, '/profiles')) {
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

    if (is(text, '/manage-profiles')) {
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
      if (!(await confirmDeletion(requestMenu, target.name))) return;
      try {
        deleteProfile(target.id);
        flashToast(`Deleted profile "${target.name}".`, 'success');
      } catch (err) {
        flashToast(`Cannot delete: ${(err as Error).message}`, 'error');
      }
      return;
    }

    if (is(text, '/options')) {
      await runSettings('options');
      return;
    }

    if (is(text, '/routines')) {
      let firstPass = true;
      let listIndex = 0;
      for (;;) {
        const all = stores.routines.list();
        if (all.length === 0) {
          if (firstPass) {
            flashToast('No routines saved. Teach me a workflow and I can save it as a routine.');
          }
          return;
        }
        firstPass = false;
        const byId = new Map(all.map((r) => [r.id, r]));
        const entries: MenuEntry[] = [];
        const pushGroup = (title: string, list: Routine[]) => {
          if (list.length === 0) return;
          entries.push({ type: 'section', title });
          for (const r of list) {
            entries.push({
              label: r.name,
              annotation: `/${r.id}`,
              description: truncate(r.description, 100),
              value: r.id,
            });
          }
        };
        pushGroup(
          'Tasks',
          all.filter((r) => r.id.startsWith('task-')),
        );
        pushGroup(
          'Routines',
          all.filter((r) => !r.id.startsWith('task-')),
        );
        const pick = await requestMenu(entries, {
          title: 'Routines — select one',
          initialIndex: listIndex,
        });
        if (pick.cancelled) return; // Esc on the list → exit
        listIndex = pick.index;
        const r = byId.get(pick.item.value as string);
        if (!r) continue;
        const action = await requestMenu(
          [{ label: 'Run' }, { label: 'Edit' }, { label: 'Delete' }, { label: 'Back' }],
          { title: `"${r.name}" (/${r.id})` },
        );
        if (action.cancelled || action.index === 3) continue; // Back / Esc → list
        if (action.index === 0) {
          await runRoutine(r); // hand off → exit
          return;
        }
        if (action.index === 1) {
          await runAgentTurn(buildRoutineEditSeed(r)); // hand off to chat → exit
          return;
        }
        // Delete path — confirm with the standard two-item menu.
        if (!(await confirmDeletion(requestMenu, r.name))) continue; // back to list
        stores.routines.delete(r.id);
        flashToast(`Deleted ${r.name}.`, 'success');
        continue;
      }
    }

    if (is(text, '/specialists')) {
      const builtinIds = getBuiltinSpecialistIds();
      // Loop so Back / Esc in an action menu returns to the (refreshed) list;
      // only Esc on the list itself, or a hand-off action (Edit), exits.
      // `listIndex` restores the cursor onto the item the user drilled into.
      let firstPass = true;
      let listIndex = 0;
      for (;;) {
        const all = stores.specialists.list();
        if (all.length === 0) {
          if (firstPass) {
            flashToast(
              'No specialist agents defined yet. Ask me to create one or use /create-specialist.',
            );
          }
          return;
        }
        firstPass = false;
        const byId = new Map(all.map((s) => [s.id, s]));
        const entries: MenuEntry[] = [];
        const pushGroup = (title: string, list: Specialist[]) => {
          if (list.length === 0) return;
          entries.push({ type: 'section', title });
          for (const s of list) {
            const locked = builtinIds.has(s.id);
            entries.push({
              label: s.name,
              annotation: locked
                ? `🔒 ${s.kind ?? 'persona'}`
                : s.disabled
                  ? '(disabled)'
                  : (s.kind ?? 'persona'),
              description: truncate(s.description, 100),
              value: s.id,
            });
          }
        };
        pushGroup(
          'Bundled',
          all.filter((s) => builtinIds.has(s.id)),
        );
        pushGroup(
          'Yours',
          all.filter((s) => !builtinIds.has(s.id)),
        );
        const pick = await requestMenu(entries, {
          title: 'Specialists — select one',
          initialIndex: listIndex,
        });
        if (pick.cancelled) return; // Esc on the list → exit
        listIndex = pick.index; // remember for the next loop (Back restores it)
        const s = byId.get(pick.item.value as string);
        if (!s) continue;
        // Bundled specialists are protected (read-only) — offer no mutating
        // actions. The store would refuse anyway; this keeps the UI honest.
        if (builtinIds.has(s.id)) {
          flashToast(
            `🔒 "${s.name}" is a bundled specialist — read-only. It can't be edited, disabled, or deleted.`,
          );
          continue;
        }
        const action = await requestMenu(
          [
            { label: 'Edit' },
            { label: s.disabled ? 'Enable' : 'Disable' },
            { label: 'Delete' },
            { label: 'Back' },
          ],
          { title: `"${s.name}" (${s.id})` },
        );
        if (action.cancelled || action.index === 3) continue; // Back / Esc → list
        if (action.index === 0) {
          await runAgentTurn(buildSpecialistEditSeed(s)); // hand off to chat → exit
          return;
        }
        if (action.index === 1) {
          stores.specialists.update(s.id, { disabled: !s.disabled });
          flashToast(`${s.name} ${s.disabled ? 'enabled' : 'disabled'}.`, 'success');
          continue; // back to the refreshed list
        }
        // Delete path — confirm with the standard two-item menu (house style).
        if (!(await confirmDeletion(requestMenu, s.name))) continue; // back to list
        stores.specialists.delete(s.id);
        flashToast(`Deleted ${s.name}.`, 'success');
        continue;
      }
    }

    if (is(text, '/applets')) {
      // Both halves in one menu: what exists, and what Bernard thinks should.
      // Splitting them into `/applets` and `/applet-candidates` would put the
      // suggestion behind a command nobody has a reason to type — the list of
      // real applets is what a user opens, and the suggestion belongs beside it.
      let firstPass = true;
      let listIndex = 0;
      // `stale` is what decides whether the list is re-read, and it is set only
      // by the two branches that change it. Returning from a submenu is the
      // common navigation and used to re-`listIds()` and re-parse every
      // manifest — up to `MAX_APPLETS` synchronous reads and zod parses — for a
      // list that had not changed.
      let stale = true;
      let entries: MenuEntry[] = [];
      let pending: AppletCandidate[] = [];
      // Tracked separately from `entries.length` since the Host row is
      // unconditional: without this the "no applets yet" guidance would be
      // replaced by a menu whose only row is about the server.
      let hasApplets = false;
      const rebuild = () => {
        const registry = new AppRegistry();
        pending = appletCandidates.listPending();
        const rows: MenuEntry[] = [];
        const appIds = registry.listIds();
        // Split the same way `bernard app list` does, and for the same reason:
        // a seeded example in one flat list is indistinguishable from the
        // user's own work. Sections rather than omission — a bundled applet
        // still holds a port and still answers in a browser, so hiding it
        // makes it unfindable rather than tidy.
        const bundled = bundledAppIds();
        const group = (title: string, ids: string[]) => {
          if (ids.length === 0) return;
          rows.push({ type: 'section', title });
          for (const id of ids) {
            const parsed = registry.get(id);
            const m = parsed.ok ? parsed.manifest : undefined;
            rows.push({
              label: m?.name ?? id,
              annotation: m ? id : 'invalid manifest',
              description: truncate(m?.description ?? '', 100),
              value: `app:${id}`,
            });
          }
        };
        group(
          'Applets',
          appIds.filter((id) => !bundled.has(id)),
        );
        group(
          'Bundled examples',
          appIds.filter((id) => bundled.has(id)),
        );
        if (pending.length > 0) {
          rows.push({ type: 'section', title: 'Suggestions' });
          for (const c of pending) {
            rows.push({
              label: c.name,
              annotation: `${Math.round(c.confidence * 100)}%`,
              description: truncate(c.reasoning || c.description, 100),
              value: `cand:${c.id}`,
            });
          }
        }
        // The first question when a button does nothing is whether anything
        // is serving the applet at all, and `bernard applet-host status` was
        // the only way to ask it.
        rows.push({ type: 'section', title: 'Host' });
        rows.push({ label: 'Applet host', value: 'host' });
        hasApplets = appIds.length > 0 || pending.length > 0;
        entries = rows;
        stale = false;
      };
      for (;;) {
        if (stale) rebuild();
        if (!hasApplets) {
          if (firstPass) flashToast('No applets yet. Ask me to build one.');
          return;
        }
        firstPass = false;
        const pick = await requestMenu(entries, {
          title: 'Applets',
          initialIndex: listIndex,
        });
        if (pick.cancelled) return;
        listIndex = pick.index;
        const value = pick.item.value as string;

        if (value === 'host') {
          await appletHostMenu();
          continue;
        }

        if (value.startsWith('app:')) {
          const id = value.slice(4);
          // Every `bernard app` operation has an equivalent here (#460),
          // deletion and grants included.
          //
          // The rule that used to keep them out is about the MODEL acting:
          // `app-grants.ts` refuses to let a model widen the authority of the
          // app it is running inside, and `src/tools/applet.ts` has no delete
          // for the same reason. Neither argument extends to a menu. A user
          // selecting a row is the same person, exercising the same authority,
          // as the one typing `bernard app delete` — this is a user surface,
          // not an agent surface. Written down because it looks like an
          // inconsistency and will otherwise be "fixed" back.
          const stale2 = await appletActionMenu(id);
          if (stale2) stale = true;
          continue;
        }

        const c = pending.find((p) => p.id === value.slice(5));
        if (!c) continue;
        const action = await requestMenu(
          [{ label: 'Build it' }, { label: 'Dismiss' }, { label: 'Back' }],
          { title: `"${c.name}" (${c.draftId})` },
        );
        if (action.cancelled || action.index === 2) continue;
        if (action.index === 1) {
          appletCandidates.updateStatus(c.id, 'rejected');
          flashToast(`Dismissed ${c.name}.`, 'success');
          stale = true;
          continue;
        }
        // Building goes through the agent and its `applet` tool rather than
        // constructing a manifest here: the tool already owns id validation,
        // the asset seed and the authority split, and a second writer in the
        // UI is how those drift apart.
        appletCandidates.updateStatus(c.id, 'accepted');
        await handleSubmit(buildAppletRequest(c));
        return;
      }
    }

    /**
     * Start, stop and inspect the applet host (#460).
     *
     * Calls `startHost`/`stopHost` directly, never `appletHostStart` — that is
     * the CLI door: it prints (into Ink's alternate screen buffer, outside the
     * render loop) and sets `process.exitCode = 1` on failure, which from a
     * REPL menu would make the whole session exit non-zero. The same reason
     * `apps/open.ts` avoids it.
     */
    async function appletHostMenu(): Promise<void> {
      const { isHostProcessAlive, probeApplet, startHost, stopHost } =
        await import('../host/client.js');
      const { HostRegistry } = await import('../host/registry.js');
      for (;;) {
        const alive = isHostProcessAlive();
        const lines: string[] = [alive ? 'Host process: running' : 'Host process: stopped'];
        if (alive) {
          const registry = new HostRegistry();
          for (const id of new AppRegistry().listIds()) {
            const port = registry.recordFor(id).port;
            const serving = await probeApplet(port);
            lines.push(
              `  ${id} — http://127.0.0.1:${port} (${serving ? 'serving' : 'not serving'})`,
            );
          }
        }
        const pick = await requestMenu(
          [
            { label: alive ? 'Restart' : 'Start' },
            ...(alive ? [{ label: 'Stop' }] : []),
            { label: 'Back' },
          ],
          { title: 'Applet host', headerLines: lines },
        );
        if (pick.cancelled || pick.item.label === 'Back') return;
        if (pick.item.label === 'Stop') {
          flashToast(
            stopHost() ? 'Applet host stopped.' : 'Applet host was not running.',
            'success',
          );
          continue;
        }
        if (alive) stopHost();
        flashToast(
          (await startHost()) ? 'Applet host started.' : 'Applet host would not start.',
          'success',
        );
      }
    }

    /**
     * One applet's operations (#460). Returns whether the list needs rebuilding.
     */
    async function appletActionMenu(id: string): Promise<boolean> {
      const { AppRegistry: Reg } = await import('../apps/registry.js');
      for (;;) {
        const parsed = new Reg().get(id);
        const manage = await import('../apps/manage.js');
        const grantSummary = manage.applyCspGrant(id, {});
        const rows: MenuEntry[] = [
          { label: 'Open in browser', description: await appletOriginLine(id) },
          {
            label: 'Permissions',
            description: grantSummary.ok ? grantSummary.lines.join(' · ') : 'unavailable',
          },
          { label: 'Tool grants' },
          { label: 'View manifest' },
          { label: 'Delete', description: 'Removes the page, its data, and any bound agent.' },
          { label: 'Back' },
        ];
        const pick = await requestMenu(rows, { title: id });
        if (pick.cancelled || pick.index === 5) return false;

        if (pick.index === 0) {
          try {
            const { appOpen } = await import('../apps/app-cli.js');
            await appOpen(id, {});
            flashToast(`Opened ${id}.`, 'success');
          } catch (err) {
            flashToast(`Could not open ${id}: ${(err as Error).message}`, 'error');
          }
          continue;
        }
        if (pick.index === 1) {
          await appletPermissionsMenu(id);
          continue;
        }
        if (pick.index === 2) {
          await appletToolGrantMenu(id);
          continue;
        }
        if (pick.index === 3) {
          if (!parsed.ok) {
            flashToast(`Cannot read ${id}: ${parsed.failure.message}`, 'error');
            continue;
          }
          showInfo(id, [{ text: JSON.stringify(parsed.manifest, null, 2) }]);
          return false;
        }
        // Delete. The description names what the sweep takes, because
        // "delete" both understates it (the data store and any bound
        // specialist go too) and overstates it (the port assignment is kept,
        // so a re-added applet gets its origin and browser storage back).
        if (!(await confirmDeletion(requestMenu, id))) continue;
        const { deleteApplet } = await import('../apps/lifecycle.js');
        const result = deleteApplet(id);
        if (!result.deleted) {
          flashToast(`No such applet: ${id}.`, 'error');
          return false;
        }
        const bound =
          result.boundSpecialists.length > 0
            ? ` and ${result.boundSpecialists.length} bound agent(s)`
            : '';
        flashToast(`Deleted ${id} — page, data, workspace, grants${bound}.`, 'success');
        return true;
      }
    }

    /** Origin plus whether the host is actually serving it, rather than opening blind. */
    async function appletOriginLine(id: string): Promise<string> {
      try {
        const { HostRegistry } = await import('../host/registry.js');
        const { isHostProcessAlive, probeApplet } = await import('../host/client.js');
        const port = new HostRegistry().recordFor(id).port;
        if (!isHostProcessAlive()) return `http://127.0.0.1:${port} — host not running`;
        return `http://127.0.0.1:${port} — ${(await probeApplet(port)) ? 'serving' : 'not serving'}`;
      } catch {
        return '';
      }
    }

    /**
     * What this applet may reach outside its own origin, and what it was
     * refused (#467, #468).
     *
     * The same authority the consent prompt exercises, reached deliberately
     * rather than at build time — which is where a user who denied something,
     * or who wants it back, actually goes.
     */
    async function appletPermissionsMenu(id: string): Promise<void> {
      const manage = await import('../apps/manage.js');
      const { loadBlocked, clearBlocked } = await import('../host/violations.js');
      const { DIRECTIVE_NAMES } = await import('../host/csp-grant.js');
      for (;;) {
        const current = manage.applyCspGrant(id, {});
        if (!current.ok) {
          flashToast(current.error, 'error');
          return;
        }
        const blocked = loadBlocked(id);
        const rows: MenuEntry[] = [{ type: 'section', title: 'Granted' }];
        for (const line of current.lines) rows.push({ label: line, value: 'noop' });
        if (blocked.length > 0) {
          rows.push({ type: 'section', title: 'Blocked — the applet tried and was refused' });
          for (const b of blocked) {
            rows.push({
              label: `Allow ${DIRECTIVE_NAMES[b.directive]} ${b.origin}`,
              annotation: `${b.count}×`,
              description: `last ${formatFriendlyTimestamp(new Date(b.lastSeen))}`,
              value: `allow:${b.directive}:${b.origin}`,
            });
          }
        }
        rows.push({ type: 'section', title: 'Change' });
        rows.push({ label: 'Allow links to open in your browser', value: 'sandbox' });
        rows.push({ label: 'Revoke everything', value: 'clear' });
        rows.push({ label: 'Back', value: 'back' });

        const pick = await requestMenu(rows, {
          title: `${id} — external access`,
          headerLines: current.warnings.map((w) => `⚠ ${w}`),
        });
        if (pick.cancelled) return;
        const v = String(pick.item.value ?? 'noop');
        if (v === 'back') return;
        if (v === 'noop') continue;
        if (v === 'clear') {
          manage.applyCspGrant(id, { clear: true });
          clearBlocked(id);
          flashToast(`${id} reaches only Bernard again.`, 'success');
          continue;
        }
        if (v === 'sandbox') {
          const out = manage.applyCspGrant(id, { sandbox: ['links'] });
          flashToast(
            out.ok ? 'Links will open in your browser.' : out.error,
            out.ok ? 'success' : 'error',
          );
          continue;
        }
        if (v.startsWith('allow:')) {
          const [, directive, ...rest] = v.split(':');
          const origin = rest.join(':');
          const held = current.grant[directive as keyof typeof current.grant] as
            | string[]
            | undefined;
          const out = manage.applyCspGrant(id, {
            [directive]: [...new Set([...(held ?? []), origin])],
          } as never);
          flashToast(out.ok ? `Allowed ${origin}.` : out.error, out.ok ? 'success' : 'error');
        }
      }
    }

    /**
     * An action's tool allowlist, multi-select over what the backing
     * specialist can actually reach — so the intersection rule is visible
     * while the grant is being made rather than as a warning afterwards.
     */
    async function appletToolGrantMenu(id: string): Promise<void> {
      const { AppRegistry: Reg } = await import('../apps/registry.js');
      const manage = await import('../apps/manage.js');
      const app = new Reg().get(id);
      if (!app.ok) {
        flashToast(app.failure.message, 'error');
        return;
      }
      const actionNames = Object.keys(app.manifest.actions);
      const chosen = await requestMenu(
        actionNames.map((name) => ({
          label: name,
          description: (app.manifest.actions[name].toolAllowlist ?? []).join(', ') || 'no tools',
        })),
        { title: `${id} — grant tools to which action?` },
      );
      if (chosen.cancelled) return;
      const actionName = actionNames[chosen.index];

      const targets = manage.targetToolsFor(id, actionName);
      if (!targets || targets.length === 0) {
        flashToast(
          `"${actionName}" has no agent behind it, or its agent targets no tools — nothing to grant.`,
          'error',
        );
        return;
      }
      const held = new Set(app.manifest.actions[actionName].toolAllowlist ?? []);
      const picked = await requestMultiMenu(
        targets.map((t) => ({ label: t, active: held.has(t) })),
        { title: `${actionName} — tools (space to toggle)` },
      );
      if (picked.cancelled) return;
      const out = manage.setActionGrant(
        id,
        actionName,
        picked.items.map((i) => i.label),
      );
      if (!out.ok) {
        flashToast(out.error, 'error');
        return;
      }
      flashToast(`${id}/${actionName}: ${out.tools.join(', ') || 'no tools'}`, 'success');
      for (const w of out.warnings) flashToast(w, 'error');
    }

    if (is(text, '/candidates')) {
      let firstPass = true;
      let listIndex = 0;
      for (;;) {
        const pending = stores.candidates.listPending();
        if (pending.length === 0) {
          if (firstPass) flashToast('No pending specialist suggestions.');
          return;
        }
        firstPass = false;
        const byId = new Map(pending.map((c) => [c.id, c]));
        const entries: MenuEntry[] = pending.map((c) => {
          stores.candidates.acknowledge(c.id); // mark seen on open (prior behavior)
          return {
            label: c.name,
            annotation: `${Math.round(c.confidence * 100)}%`,
            description: truncate(c.reasoning || c.description, 100),
            value: c.id,
          };
        });
        const pick = await requestMenu(entries, {
          title: 'Specialist suggestions — select one',
          initialIndex: listIndex,
        });
        if (pick.cancelled) return; // Esc on the list → exit
        listIndex = pick.index;
        const c = byId.get(pick.item.value as string);
        if (!c) continue;
        const action = await requestMenu(
          [{ label: 'Accept' }, { label: 'Reject' }, { label: 'View' }, { label: 'Back' }],
          { title: `"${c.name}" (${c.draftId})` },
        );
        if (action.cancelled || action.index === 3) continue; // Back / Esc → list
        if (action.index === 0) {
          try {
            promoteCandidate(
              c,
              stores.specialists,
              stores.candidates,
              config.autoCreateThreshold,
              config,
            );
            flashToast(`Accepted ${c.name} — specialist created.`, 'success');
          } catch (err) {
            flashToast(`Could not create specialist: ${(err as Error).message}`, 'error');
          }
          continue; // back to the refreshed list (accepted drops out of pending)
        }
        if (action.index === 1) {
          stores.candidates.updateStatus(c.id, 'rejected');
          flashToast(`Rejected ${c.name}.`, 'success');
          continue; // back to the refreshed list
        }
        // View — read-only detail. Opens an InfoOverlay, so exit the menu loop
        // (the loop would otherwise immediately replace it with the next menu).
        showInfo(c.name, [
          { text: c.description },
          { text: '' },
          { text: `Confidence: ${Math.round(c.confidence * 100)}%`, dim: true },
          { text: `Detected: ${new Date(c.detectedAt).toLocaleString()}`, dim: true },
          { text: '' },
          { text: 'Reasoning:', bold: true },
          { text: c.reasoning, dim: true },
        ]);
        return;
      }
    }

    if (is(text, '/create-routine') || is(text, '/create-task') || is(text, '/create-specialist')) {
      // Guarded rather than asserted. Typing the record's values as possibly
      // undefined (#393) turned what had been an implicit agreement between two
      // lists into a compile error here: the branch matches three names, the
      // record supplies three, and nothing had been checking those were the
      // same three. A missing key would have sent `undefined` into
      // `runAgentTurn` as the user's whole prompt.
      const seed = CREATE_SEED_PROMPTS[text];
      if (!seed) return;
      await runAgentTurn(seed);
      return;
    }

    if (is(text, '/task') || startsWithCmd(text, '/task')) {
      const description = text.slice('/task'.length).trim();
      if (!description) {
        flashToast('Usage: /task <description>', 'error');
        return;
      }
      await runTaskInk(description);
      return;
    }

    if (is(text, '/image') || startsWithCmd(text, '/image')) {
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
      // The model the turn will actually RUN on, not `config.model` — under a
      // lineup those differ, and this refused images for a model that could
      // read them. Same staleness #233 fixed for the context-window math.
      if (!mainVisionCapable(config)) {
        flashToast(
          `Model "${resolveMainModel(config)}" does not support image input. Switch with /model.`,
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
    // agent turn. The table is module-level (LEGACY_TOGGLE_POINTERS) — it was a
    // fresh object literal per submit, and its keys are the only dispatch here
    // that isn't an `if`, so they need the same typed home as the rest.
    const legacyPointer = LEGACY_TOGGLE_POINTERS[text];
    if (legacyPointer) {
      flashToast(`This command moved. ${legacyPointer}`, 'warning');
      return;
    }

    // Dynamic routine invocation: /{routine-id} [args...]
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const routineId = parts[0];
      const routine = stores.routines.get(routineId);
      if (routine) {
        await runRoutine(routine, parts.slice(1).join(' '));
        return;
      }
      // Unknown slash command — fall through to agent turn (legacy behavior).
    }

    // Inline-image detection on plain text turns.
    let inlineImages: ImageAttachment[] | undefined;
    const candidatePaths = extractImagePaths(text);
    if (candidatePaths.length > 0) {
      if (mainVisionCapable(config)) {
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

  type BooleanPrefKey =
    | 'autoCreateSpecialists'
    | 'autoCreateApplets'
    | 'promptRewriter'
    | 'recallFilter'
    | 'toolDetails'
    | 'conciseMode'
    | 'voiceTts'
    | 'voiceNormalizer';

  /**
   * The one way to set a boolean preference from a menu. `persist` exists
   * because the voice fields live behind `persistVoice` (`saveActiveSettings`)
   * rather than the `savePreferences` round-trip the others use — that one line
   * was the entire difference, and duplicating the row for it would have given
   * the file two On/Off idioms 250 lines apart.
   */
  async function toggleBooleanPref(
    key: BooleanPrefKey,
    label: string,
    onMsg: string,
    offMsg: string,
    onToggle?: (value: boolean) => void,
    persist?: () => void,
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
    if (persist) {
      persist();
    } else {
      savePreferences({
        ...loadPreferences(),
        provider: config.provider,
        model: config.model,
        [key]: newVal,
      });
    }
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
        desc: 'Premium orchestrator; mid executor/function-caller/summarizer; cheap classifier.',
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
      active:
        m.value === 'skip'
          ? config.skipPermissions
          : !config.skipPermissions && config.toolMode === m.value,
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

  /** An entry list paired with the per-item actions (sections excluded). */
  type SettingsMenu = { entries: MenuEntry[]; actions: Array<() => void | Promise<void>> };

  /**
   * One row of a settings-style menu, paired with what selecting it does.
   * Lifted out of `buildAgentOptionsMenu` once `buildVoiceMenu` needed the same
   * shape — the `entries`/`actions` split has to stay in lockstep, so the two
   * builders should be describing it with the same type.
   */
  type MenuRow =
    | { kind: 'section'; title: string }
    | { kind: 'item'; item: MenuItem; action: () => void | Promise<void> };

  /** Splits rows into the parallel arrays `SettingsMenu` and `runVoiceMenu` consume. */
  function splitRows(rows: MenuRow[]): SettingsMenu {
    return {
      entries: rows.map((r) =>
        r.kind === 'section' ? { type: 'section', title: r.title } : r.item,
      ),
      actions: rows.flatMap((r) => (r.kind === 'item' ? [r.action] : [])),
    };
  }

  function buildAgentOptionsMenu(): SettingsMenu {
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
      toggleRow(
        'autoCreateApplets',
        'Auto-create applets',
        'Build suggested applets above the threshold, without asking.',
        'Auto-create applets: on',
        'Auto-create applets: off',
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
            'Switch, edit, or create lineups that bind each functional role × cost tier (premium/mid/cheap) to a (provider, model) pair.',
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
        'recallFilter',
        'Recall filter',
        'Before each turn, widen recalled-memory retrieval and let a cheap model keep only the facts relevant to the conversation, so the agent sees less irrelevant context.',
        'Recall filter: on',
        'Recall filter: off',
      ),
      toggleRow(
        'toolDetails',
        'Tool details',
        'Show full tool call args and results in the transcript.',
        'Tool details: on',
        'Tool details: off',
        (value) => {
          setToolDetailsVisible(value);
          // Finalized transcript items snapshot toolDetails at commit time and
          // are written to scrollback once (#232), so a toggle can't retroapply
          // to already-printed turns — it takes effect on subsequent turns. The
          // in-flight streaming message reads config.toolDetails live, so the
          // current turn still responds.
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

    return splitRows(rows);
  }

  /**
   * The "Options" tab — numeric system options from {@link OPTIONS_REGISTRY} plus
   * a Debug-report item. Mirrors the former standalone `/options` menu; each
   * registry item opens a value prompt, validates, and persists via `saveOption`.
   */
  function buildOptionsMenu(): SettingsMenu {
    const optEntries = Object.entries(OPTIONS_REGISTRY);
    // Rows, not two independently-built arrays: `entries` and `actions` are
    // paired by index, and building them separately is how inserting a section
    // silently shifts every action by one.
    const rows: MenuRow[] = optEntries.map(([name, opt]) => {
      const current = config[opt.configKey];
      const tag = current === opt.default ? '(default)' : '(custom)';
      return {
        kind: 'item',
        item: { label: name, annotation: `= ${current} ${tag}`, description: opt.description },
        action: async () => {
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
        },
      };
    });
    rows.push({ kind: 'section', title: 'Info' });
    rows.push({
      kind: 'item',
      item: { label: 'Debug report', description: 'Print a diagnostic report for troubleshooting' },
      action: () =>
        showInfo('Bernard Diagnostic Report', buildDebugReportLines(config, agent, stores)),
    });
    return splitRows(rows);
  }

  /**
   * Drives the tabbed settings screen. Both `/options` and `/agent-options` open
   * it (on their respective tab); Shift+Tab cycles between them in-place. After
   * an item's action runs, the loop re-shows on the same tab/cursor with entries
   * rebuilt from the (possibly mutated) config so annotations stay current.
   */
  async function runSettings(initialTab: SettingsTab): Promise<void> {
    let tab = initialTab;
    let index = 0;
    for (;;) {
      const optionsMenu = buildOptionsMenu();
      const agentMenu = buildAgentOptionsMenu();
      const res = await requestSettings({
        initialTab: tab,
        initialIndex: index,
        optionsEntries: optionsMenu.entries,
        agentEntries: agentMenu.entries,
      });
      if (res.cancelled) return;
      tab = res.tab;
      index = res.index;
      const action = (tab === 'options' ? optionsMenu.actions : agentMenu.actions)[res.index];
      if (action) await action();
    }
  }

  /** Persists every voice field onto the active profile. */
  function persistVoice(): void {
    saveActiveSettings({
      voiceTts: config.voiceTts,
      voiceBackend: config.voiceBackend,
      voiceVoice: config.voiceVoice,
      voiceRate: config.voiceRate,
      voiceWarmupMs: config.voiceWarmupMs,
      voiceNormalizer: config.voiceNormalizer,
    });
  }

  /**
   * The integer rows of the `/voice` menu. Blank clears the field to
   * `undefined` (which is how Rate returns to the backend default), so
   * `cancelOnEmpty: false` is required — without it the field could be set but
   * never unset.
   *
   * `String(n) !== raw` is the guard the older numeric prompts carry
   * (`runMaxConcurrentPrompt`) and the registry-driven one does not: without
   * it `parseInt` accepts `120wpm` and silently stores `120`.
   */
  async function promptVoiceInt(o: {
    prompt: string;
    initial: string;
    min: number;
    invalid: string;
    /** Whether an empty entry clears the field. Off where 0 is the "disabled"
     *  value and blank would be ambiguous. */
    blankClears?: boolean;
    apply: (value: number | undefined) => void;
    describe: () => string;
  }): Promise<void> {
    const res = await requestTextInput({
      label: o.prompt,
      initialValue: o.initial,
      cancelOnEmpty: false,
    });
    if (res.cancelled) return;
    const raw = res.raw.trim();
    if (raw.length === 0 && o.blankClears !== false) {
      o.apply(undefined);
    } else {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || String(n) !== raw || n < o.min) {
        flashToast(o.invalid, 'error');
        return;
      }
      o.apply(n);
    }
    persistVoice();
    flashToast(o.describe(), 'success');
  }

  /**
   * `/voice status` — the read-only view, also reachable as the menu's last row.
   * Reads the backend and warmup player off the cached service rather than
   * re-probing PATH with synchronous `which` calls on every invocation.
   */
  function showVoiceStatus(): void {
    const svc = getVoiceService(config);
    const resolved = svc.backend;
    const warmupPlayer = svc.warmupPlayer;
    showInfo('Voice TTS', [
      { text: `State: ${config.voiceTts ? 'ON' : 'OFF'}`, bold: true },
      {
        text: config.voiceNormalizer
          ? 'Natural speech: on'
          : 'Natural speech: off (speaking literal text)',
      },
      { text: `Configured backend: ${config.voiceBackend}` },
      {
        text: `Resolved backend: ${describeBackend(resolved)}`,
        dim: !resolved,
      },
      { text: `Voice: ${config.voiceVoice ?? 'backend default'}`, dim: true },
      {
        text: config.voiceRate ? `Rate: ${config.voiceRate} wpm` : 'Rate: backend default',
        dim: true,
      },
      {
        text:
          config.voiceWarmupMs > 0
            ? `Sink warmup: ${config.voiceWarmupMs} ms${warmupPlayer ? ` (${warmupPlayer})` : ' (no player — inactive)'}`
            : 'Sink warmup: off',
        dim: true,
      },
    ]);
  }

  /** Speaks the sample through every current setting, including the normalizer. */
  async function speakVoiceSample(): Promise<void> {
    if (!getVoiceService(config).backend) {
      flashToast('No TTS backend available on this system.', 'error');
      return;
    }
    await startSpeech(VOICE_SAMPLE, {
      // Surfaced rather than swallowed: the menu is the first place `voiceVoice`
      // is reachable, and a typo'd voice name makes the backend exit non-zero
      // with no other signal that anything went wrong.
      onError: (message) => flashToast(`TTS failed: ${message}. Check the voice name.`, 'error'),
    });
  }

  function voiceMenuTitle(): string {
    const resolved = getVoiceService(config).backend;
    const state = config.voiceTts ? 'ON' : 'OFF';
    // "On but silent" — a configured backend that isn't installed — was
    // previously invisible outside `/voice status`.
    const engine = describeBackend(resolved);
    return `Voice — ${state} · ${engine}`;
  }

  /**
   * The `/voice` screen. A plain `requestMenu` loop rather than a third
   * `SettingsOverlay` tab: `SettingsTab` is a closed union threaded through
   * `SETTINGS_TABS`, `requestSettings`'s resolve shape and the overlay's
   * `optionsEntries`/`agentEntries` props, so a third tab is a refactor of the
   * overlay contract — and it would be wrong even if it were free, since a third
   * tab is reachable by Shift+Tab from `/options`, which would put an
   * audio-device panel in the general-settings rotation.
   *
   * Every row stays enabled regardless of `voiceTts`: configuring a backend
   * while voice is off is legitimate, and hiding rows makes the list jump under
   * the cursor.
   */
  function buildVoiceMenu(): SettingsMenu {
    const svc = getVoiceService(config);
    const resolved = svc.backend;
    const backendAnnotation =
      config.voiceBackend === 'auto'
        ? `= auto → ${describeBackend(resolved)}`
        : `= ${config.voiceBackend}`;

    const rows: MenuRow[] = [
      { kind: 'section', title: 'Playback' },
      {
        kind: 'item',
        item: {
          label: 'Speech',
          annotation: `= ${config.voiceTts ? 'on' : 'off'}`,
          description: 'Speak each assistant reply aloud after the turn completes.',
        },
        action: () =>
          toggleBooleanPref(
            'voiceTts',
            'Speech',
            'Speech on.',
            'Speech off.',
            (on) => {
              if (!on) resetVoiceService();
            },
            persistVoice,
          ),
      },
      {
        kind: 'item',
        item: {
          label: 'Backend',
          annotation: backendAnnotation,
          description: 'Which TTS engine speaks. Auto detects one for this platform.',
        },
        action: async () => {
          const res = await requestMenu(
            (VOICE_BACKEND_VALUES as readonly string[]).map((b) => ({
              label: b,
              active: config.voiceBackend === b,
              value: b,
            })),
            { title: `Backend: ${config.voiceBackend}` },
          );
          if (res.cancelled) return;
          config.voiceBackend = res.item.value as VoiceBackend;
          // Re-resolve the singleton against the new backend setting.
          resetVoiceService();
          persistVoice();
          flashToast(`Backend: ${config.voiceBackend}.`, 'success');
        },
      },
      {
        kind: 'item',
        item: {
          label: 'Voice',
          annotation: `= ${config.voiceVoice ?? '(backend default)'}`,
          description:
            'Named voice passed to the backend — "Daniel" on macOS, "en-us+f3" on espeak. Blank uses the backend’s own.',
        },
        action: async () => {
          // `cancelOnEmpty: false` is required, or the field could never be
          // cleared back to the backend default once set.
          const res = await requestTextInput({
            label: 'Voice name',
            initialValue: config.voiceVoice ?? '',
            cancelOnEmpty: false,
          });
          if (res.cancelled) return;
          const name = res.raw.trim();
          config.voiceVoice = name.length > 0 ? name : undefined;
          resetVoiceService();
          persistVoice();
          flashToast(`Voice: ${config.voiceVoice ?? 'backend default'}.`, 'success');
        },
      },
      {
        kind: 'item',
        item: {
          label: 'Rate',
          annotation: `= ${config.voiceRate ? `${config.voiceRate} wpm` : '(backend default)'}`,
          description: 'Words per minute. Blank uses the backend default.',
        },
        action: () =>
          promptVoiceInt({
            prompt: 'Rate (words per minute)',
            initial: config.voiceRate ? String(config.voiceRate) : '',
            min: 1,
            blankClears: true,
            invalid: 'Invalid rate. Must be a positive integer.',
            apply: (n) => {
              config.voiceRate = n;
            },
            describe: () => `Rate: ${config.voiceRate ?? 'backend default'}.`,
          }),
      },
      {
        kind: 'item',
        item: {
          label: 'Sink warmup',
          annotation: `= ${config.voiceWarmupMs > 0 ? `${config.voiceWarmupMs} ms${svc.warmupPlayer ? ` (${svc.warmupPlayer})` : ' (no player)'}` : 'off'}`,
          description:
            "Silence played to wake a suspended audio sink so the first words aren't clipped. Linux only; 0 disables.",
        },
        action: () =>
          promptVoiceInt({
            prompt: 'Sink warmup (ms, 0 disables)',
            initial: String(config.voiceWarmupMs),
            min: 0,
            blankClears: false,
            invalid: 'Invalid warmup. Must be 0 or a positive integer.',
            apply: (n) => {
              config.voiceWarmupMs = n as number;
              // The warmup config is captured at construction, so re-resolve.
              resetVoiceService();
            },
            describe: () =>
              `Sink warmup: ${config.voiceWarmupMs > 0 ? `${config.voiceWarmupMs} ms` : 'off'}.`,
          }),
      },

      { kind: 'section', title: 'Spoken form' },
      {
        kind: 'item',
        item: {
          label: 'Natural speech',
          annotation: `= ${config.voiceNormalizer ? 'on' : 'off'}`,
          description:
            'Read the reply the way a person would say it: phone numbers as digit groups, links named instead of spelled, tables as sentences. The transcript and saved history stay literal.',
        },
        action: () =>
          toggleBooleanPref(
            'voiceNormalizer',
            'Natural speech',
            'Natural speech on.',
            'Natural speech off.',
            // Not `resetVoiceService()` — the backend did not change; only a
            // pending normalization is now running under the wrong setting.
            cancelPendingSpeech,
            persistVoice,
          ),
      },

      { kind: 'section', title: 'Try it' },
      {
        kind: 'item',
        item: {
          label: 'Speak a test phrase',
          description:
            'Speak a sample containing a table, a link and a phone number, using every setting above.',
        },
        action: speakVoiceSample,
      },
      {
        kind: 'item',
        item: { label: 'Stop speaking', description: 'Kill any utterance in flight.' },
        action: () => {
          _voiceService?.stop();
          cancelPendingSpeech();
        },
      },
      {
        kind: 'item',
        item: { label: 'Diagnostics', description: 'Resolved backend, warmup player, settings.' },
        action: showVoiceStatus,
      },
    ];

    return splitRows(rows);
  }

  /**
   * Drives the `/voice` screen. Entries are rebuilt each pass so annotations
   * refresh from the mutated config, and `initialIndex` restores the cursor onto
   * the row just changed — `MenuOptions.initialIndex` is item-indexed with
   * sections excluded, which is exactly what `res.index` is. Same shape as
   * {@link runSettings}.
   */
  async function runVoiceMenu(): Promise<void> {
    let index = 0;
    for (;;) {
      const { entries, actions } = buildVoiceMenu();
      const res = await requestMenu(entries, { title: voiceMenuTitle(), initialIndex: index });
      if (res.cancelled) return;
      index = res.index;
      await actions[res.index]?.();
    }
  }

  function reapplyRuntimeSettings(cfg: BernardConfig): void {
    try {
      setTheme(cfg.theme);
    } catch {
      /* unknown theme — keep current */
    }
    setToolDetailsVisible(cfg.toolDetails);
    // Reset the voice singleton so profile-switched voiceBackend takes effect.
    resetVoiceService();
  }

  async function runPreTurnPipeline(
    input: string,
    signal: AbortSignal,
  ): Promise<{
    agentInput: string;
    resolvedEntries: ResolvedEntry[];
    ragResults?: RAGSearchResult[];
    recallReconciliation?: string;
    memoryPriority?: string[];
  }> {
    const pipelineStartedAt = Date.now();
    debugLog('pre-turn:start', { inputLen: input.length });
    // Per-turn RAG cache invalidation (#171). Must run before any resolver /
    // rewriter LLM call so they see only this turn's facts.
    stores.rag?.clearTurnCache();

    // Fold pre-turn LLM calls into the per-turn ledger (#258). No-op when the
    // spinner stats aren't wired (headless paths never hit runPreTurnPipeline).
    const recordPreTurnUsage = makeUsageRecorder(agent);

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
            recordPreTurnUsage,
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
        const result = await rewritePrompt(
          input,
          profile,
          resolvedEntries,
          config,
          signal,
          recordPreTurnUsage,
        );
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

    // Recall filter (runs last, on the final agentInput): widen RAG retrieval
    // and let a cheap LLM keep only the facts relevant to the conversation.
    // On any `noop` we leave `ragResults` undefined and the agent runs its own
    // narrow search — i.e. fail-open to legacy behavior.
    let ragResults: RAGSearchResult[] | undefined;
    let recallReconciliation: string | undefined;
    let memoryPriority: string[] | undefined;
    if (config.recallFilter && stores.rag) {
      try {
        const result = await recallFilter(agentInput, config, stores.rag, agent.getHistory(), {
          // Read-only: the curator reconciles against memory and ranks it, but
          // never drops it — `renderPersistentMemory` still injects every entry
          // that fits (#371).
          memoryStore: stores.memory,
          abortSignal: signal,
          onUsage: recordPreTurnUsage,
        });
        if (result.status === 'filtered') {
          ragResults = result.facts;
          recallReconciliation = result.reconciliation;
          memoryPriority = result.memoryPriority;
        }
      } catch (err: unknown) {
        debugLog('app:recall-filter', err instanceof Error ? err.message : String(err));
      }
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    debugLog('pre-turn:end', {
      durationMs: Date.now() - pipelineStartedAt,
      rewritten: agentInput !== input,
      refCount: resolvedEntries.length,
      recallFiltered: ragResults !== undefined,
      reconciled: recallReconciliation !== undefined,
    });
    return { agentInput, resolvedEntries, ragResults, recallReconciliation, memoryPriority };
  }

  /**
   * Freeze every history message added since the last commit into the
   * append-only `staticItems` log (#232). Called at the two turn boundaries
   * where the per-message extras are known: at turn start for the just-pushed
   * user message (its pre-rewrite original), and at turn end for the assistant
   * message (its timing footer). Each item snapshots `config.toolDetails` and
   * gets a fresh monotonic key, then `committedLenRef` advances so the next
   * commit only picks up newer messages.
   */
  function commitNewHistory(opts?: {
    /** Pre-rewrite text, attached to the just-pushed user message in the slice. */
    rewriteForLastUser?: string;
    /** Timing footer, attached to the last assistant message in the slice. */
    timing?: { endedAt: number; durationMs: number };
    /** Estimated turn cost (#258), attached beside the timing footer. */
    costUsd?: number;
  }): void {
    const history = agent.getHistory();
    // If the agent replaced its history array mid-turn (auto-compression /
    // emergency truncation in processInput, which reassigns `this.history` to a
    // shorter array — #243 review), the length cursor points past the end of
    // the new array and the slice below would silently drop this turn's
    // assistant + tool output. Re-anchor on this turn's user message instead:
    // compression always keeps the most recent user message, so everything
    // after the last user message is the still-uncommitted turn output (the
    // user message itself was already committed at turn start). Guard on a
    // non-null prior ref so the first-ever commit still emits initial history.
    if (historyRef.current !== null && historyRef.current !== history) {
      let lastUserIdx = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      committedLenRef.current = lastUserIdx + 1;
    }
    historyRef.current = history;
    const start = committedLenRef.current;
    if (start >= history.length) return;
    const toolDetails = config.toolDetails;
    // The rewrite original belongs to the just-pushed user message and the
    // timing footer to the turn's assistant message — i.e. the last of each
    // role in the slice. Resolve both targets here so callers only pass the
    // payloads, not history indices to keep in sync.
    let lastUserIdx = -1;
    let lastAssistantIdx = -1;
    for (let i = start; i < history.length; i++) {
      if (history[i].role === 'user') lastUserIdx = i;
      else if (history[i].role === 'assistant') lastAssistantIdx = i;
    }
    const appended: StaticItem[] = [];
    for (let i = start; i < history.length; i++) {
      const message = history[i];
      appended.push({
        key: String(itemKeyRef.current++),
        message,
        rewriteOriginal:
          opts?.rewriteForLastUser !== undefined && i === lastUserIdx
            ? opts.rewriteForLastUser
            : undefined,
        timing: opts?.timing && i === lastAssistantIdx ? opts.timing : undefined,
        costUsd: opts?.timing && i === lastAssistantIdx ? opts.costUsd : undefined,
        toolDetails,
      });
    }
    committedLenRef.current = history.length;
    setStaticItems((prev) => [...prev, ...appended]);
  }

  /**
   * Runs one normalize-then-speak cycle under the pending-speech lifecycle.
   *
   * **Every producer must go through here.** Starting a normalization and
   * registering it for cancellation used to be two separate acts, one of which
   * was optional — and the menu's Preview row promptly forgot the second, so
   * Esc, the Stop row and a new turn were all no-ops against it. Owning
   * cancel-previous → allocate → register → clear in one place makes forgetting
   * impossible; `_speechAbort` is written nowhere else.
   *
   * The re-checks after the await are the point: an LLM round trip sits between
   * "the text is ready" and "audio starts", and the user can begin a new turn,
   * hit Esc, run `/voice off` or switch profile inside that window.
   */
  async function startSpeech(
    writtenForm: string,
    hooks?: { onNormalized?: () => void; onError?: (message: string) => void },
  ): Promise<void> {
    cancelPendingSpeech();
    const ac = new AbortController();
    _speechAbort = ac;
    try {
      const svc = getVoiceService(config);
      // Wake a suspended sink CONCURRENTLY with the round trip rather than
      // after it. `speak()` used to be called at turn end, so its 400 ms warmup
      // overlapped nothing; putting an LLM call in front of it would otherwise
      // add the two together on every voiced turn.
      svc.prewarm();
      const spoken = await toSpokenForm(
        writtenForm,
        config,
        ac.signal,
        makeOutOfTurnUsageRecorder(agent),
      );
      // `_speechAbort !== ac` sits beside `aborted` deliberately: it makes "a
      // newer readback started" true without depending on abort-propagation
      // ordering.
      if (ac.signal.aborted || _speechAbort !== ac) return;
      if (!spoken.text) return;
      if (spoken.normalized) hooks?.onNormalized?.();
      await svc.speak(spoken.text, { voice: config.voiceVoice, rate: config.voiceRate });
    } catch (err) {
      // Never rethrow — TTS must not crash the REPL. A producer that wants the
      // failure visible (the menu's Preview row) passes `onError`.
      hooks?.onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      if (_speechAbort === ac) _speechAbort = null;
    }
  }

  /** The post-turn readback. Fire-and-forget by design — see its call site. */
  async function speakAssistantReply(writtenForm: string): Promise<void> {
    if (!config.voiceTts) return;
    await startSpeech(writtenForm, {
      onNormalized: () => {
        if (speechNoticeShownRef.current) return;
        speechNoticeShownRef.current = true;
        flashToast(
          'Natural speech is on — Bernard reads a listener-friendly version of each reply. /voice to turn it off.',
          'info',
        );
      },
    });
  }

  async function runAgentTurn(input: string, images?: ImageAttachment[]): Promise<void> {
    // Drop a second Enter that arrives before the busy re-render has propagated
    // to <Prompt disabled={busy}>. Without this, two turns can run concurrently.
    if (submittingRef.current) return;
    submittingRef.current = true;
    // Clear the previous turn's stream events so the in-flight
    // <StreamingAssistantMessage> renders only this turn's deltas.
    messageStore.reset();
    // A new turn supersedes the previous turn's unspoken readback (#432) — the
    // case that motivates the guard at all.
    cancelPendingSpeech();
    setInterrupted(false);
    setBusy(true);
    const turnStartedAt = Date.now();
    let turnCompleted = false;
    let errorPanel: ErrorPanelData | null = null;
    const controller = new AbortController();
    turnAbortRef.current = controller;
    try {
      // Open the per-turn stats window here — at the true turn boundary, before
      // the pre-turn pipeline runs (#258) — so reference-resolver / rewriter
      // tokens land in the same ledger as the main loop. `processInput` then
      // won't reset and wipe them.
      agent.beginTurnStats();
      const { agentInput, resolvedEntries, ragResults, recallReconciliation, memoryPriority } =
        await runPreTurnPipeline(input, controller.signal);
      if (controller.signal.aborted) return;
      // `processInput` pushes the user message to `agent.history` synchronously
      // (before its first internal await), so by the time the returned promise
      // hits this microtask boundary the history already contains the new
      // entry. Committing it here shows the user message in the transcript
      // (above the streaming assistant block) immediately instead of after the
      // turn finishes. When the rewriter substituted the text, pass the
      // original so <UserMessage> displays it (the rewrite is an LLM-only
      // detail) rather than the dispatched version.
      const inflight = agent.processInput(agentInput, images, resolvedEntries, {
        ragResults,
        recallReconciliation,
        memoryPriority,
        originalInput: input,
      });
      commitNewHistory({ rewriteForLastUser: input !== agentInput ? input : undefined });
      // Snapshot history length AFTER the user message push (synchronous) so
      // the ask_user scanner below knows where this turn's tool results begin.
      const historyLenAfterUserMsg = agent.getHistory().length;
      // Per-turn dedup set — one entry per toolCallId we've already injected for.
      // Prevents double-injection if the agent auto-continues after a length cut.
      const askUserInjectedIds = new Set<string>();
      await inflight;
      // Inject synthetic `role:'user'` messages for any ask_user answers that
      // landed in history this turn (#245). Only run on non-aborted turns so
      // cancelled turns don't emit a stale partial bubble.
      if (!controller.signal.aborted) {
        injectAskUserHistoryMessages(
          agent.getHistory(),
          historyLenAfterUserMsg,
          askUserInjectedIds,
        );
      }
      turnCompleted = !controller.signal.aborted;
      // Voice TTS readback: speak the last assistant response if voiceTts is on.
      if (turnCompleted && config.voiceTts) {
        const history = agent.getHistory();
        let lastMsg: (typeof history)[number] | undefined;
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].role === 'assistant') {
            lastMsg = history[i];
            break;
          }
        }
        const ttsText = lastMsg ? extractTextFromContent(lastMsg.content) : '';
        // Deliberately NOT awaited. The `finally` below calls
        // `finalizeTurnStats()` + `commitNewHistory()` + `setBusy(false)`, so
        // awaiting a normalization round trip here would hold the spinner and
        // delay the transcript commit by ~1 s on every voiced turn — for work
        // nobody is waiting on. That is also why the usage recorder is the
        // out-of-turn one: this spend lands after the ledger has closed.
        if (ttsText.trim()) void speakAssistantReply(ttsText);
      }
    } catch (err) {
      // AbortError on user-cancel is expected; don't dump it to the console.
      const isAbort =
        err instanceof Error && (err.name === 'AbortError' || controller.signal.aborted);
      if (!isAbort) {
        const debug = isDebugEnabled();
        if (debug) {
          debugLog('error:turn', {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            cause: err instanceof Error && err.cause instanceof Error ? err.cause.stack : undefined,
          });
        }
        // Surface every failed turn as a styled <ErrorPanel> in the transcript
        // (committed after this turn's output, in the finally block). The full
        // stack/cause only rides along under debug. This is a UI-only notice —
        // deliberately NOT pushed into agent history, so the model's context
        // isn't polluted with its own error text.
        errorPanel = formatAgentError(err, debug);
      }
    } finally {
      persistAgentState({ agent, historyStore, provenanceHistoryStore, turnContextStore });
      submittingRef.current = false;
      turnAbortRef.current = null;
      setBusy(false);
      // Commit the assistant message (+ any tool messages) added this turn.
      // commitNewHistory attaches the timing footer to the turn's assistant
      // message itself; an aborted turn passes no timing (no footer, same as
      // before). This append + setBusy(false) land in the same React 18 batch,
      // so the streaming view freezes into scrollback in a single render.
      const endedAt = Date.now();
      const timing = turnCompleted ? { endedAt, durationMs: endedAt - turnStartedAt } : undefined;
      // Price this turn's ledger before the next turn's beginTurnStats() clears
      // it, and fold the total into the session-cumulative footer (#258). The
      // per-turn label only shows on completed turns (gated by `timing` in
      // commitNewHistory), matching the duration/timestamp footer.
      const turnCostUsd = agent.finalizeTurnStats();
      commitNewHistory({ timing, costUsd: turnCostUsd });
      // Provider-aware cost guardrail (#298): once per session, if this turn's
      // main-agent prefix was large and the active provider has no prompt-cache
      // discount (xAI / custom), flash a one-time hint that the prefix is being
      // re-billed at full price every step. Read before beginTurnStats() clears
      // the odometer next turn; `latestPromptTokens` is the last step's size.
      if (turnCompleted) {
        const hint = noPromptCacheHint({
          provider: config.provider,
          promptTokens: agent.spinnerStats?.latestPromptTokens ?? 0,
          thresholdTokens: config.costGuardrailTokens,
          alreadyWarned: noCacheWarnedRef.current,
        });
        if (hint) {
          noCacheWarnedRef.current = true;
          flashToast(hint, 'warning');
        }
      }
      // Durable record of an interrupted turn (#403). The `⏹ you interrupted`
      // chrome in <Thread>/<TranscriptViewport> renders off the `interrupted`
      // boolean and is never pushed into `staticItems`, so it is not part of
      // the transcript — and `runAgentTurn` clears the flag at the top of the
      // submit path, which means the next keystroke erased the only trace the
      // turn ever left. Scrolling back through a session showed a user message
      // followed by nothing, indistinguishable from a turn that answered and
      // produced no text.
      //
      // This is deliberately a UI-only notice, the same channel the startup
      // lineup-correction and `provider-wiped` notices use: it never enters
      // `agent.history`, because the model's record of the interrupt is the
      // `[interrupted by user]` marker `Agent.processInput` pushes (which,
      // since #403, lands even when the abort beat the first step). Two
      // records, one per audience — duplicating the UI text into history would
      // make the model read its own transcript furniture as content.
      //
      // The chrome stays: it is the right affordance while the turn is dead but
      // before the user types. The bug was that it was the ONLY record.
      if (controller.signal.aborted) {
        const inFlight = interruptInFlightRef.current;
        interruptInFlightRef.current = 0;
        pushAssistantNotice(
          `⏹ Turn interrupted after ${formatDuration(endedAt - turnStartedAt)}.` +
            (inFlight > 0
              ? ` ${inFlight} sub-dispatch${inFlight === 1 ? '' : 'es'} cancelled with it.`
              : ''),
        );
      }
      // Append the error panel after the turn's committed output so it reads
      // as the turn's outcome (in the same batch as the commit above).
      if (errorPanel) {
        setStaticItems((prev) => [
          ...prev,
          {
            key: String(itemKeyRef.current++),
            toolDetails: config.toolDetails,
            error: errorPanel!,
          },
        ]);
      }
    }
  }

  // Execute a saved routine: tasks (`task-` prefix) run single-shot via
  // runTaskInk; routines run as a guided agent turn. Shared by the dynamic
  // `/<routine-id>` dispatch and the `/routines` menu's Run action.
  async function runRoutine(routine: Routine, args = ''): Promise<void> {
    if (routine.id.startsWith('task-')) {
      await runTaskInk(routine.content, args || undefined);
      return;
    }
    let message = `Execute routine "${routine.name}" (/${routine.id}):\n${routine.description}\n\n## Routine Steps\n${routine.content}`;
    if (args) message += `\n\n## Additional Context\n${args}`;
    message +=
      "\n\nFollow this routine intelligently — adapt to the current situation, skip steps that don't apply, and explain any deviations.";
    await runAgentTurn(message);
  }

  async function runTaskInk(description: string, context?: string): Promise<void> {
    await withSlot(
      async (slot) => {
        setInterrupted(false);
        setBusy(true);
        const ctx = agent.getContext();
        ctx.provenance.clear();
        try {
          const input: TaskInput = context
            ? { task: description, context, slotId: slot.id }
            : { task: description, slotId: slot.id };
          // Tasks dispatch OUTSIDE the normal turn loop, so `ctx.policyDecision` is
          // undefined here (it's only set during `processInput`). Without it the
          // augment gate defaults `confirmThreshold` to 'high' and ignores the
          // user's skipPermissions / confirmMode / toolMode — re-prompting on
          // dangerous shell even in unrestricted mode. Resolve the same per-turn
          // decision a chat turn would, feeding the policy engine the exact user
          // message the model sees (`renderTaskText` adds the `Task:`/`Context:`
          // framing) so the decision can't diverge from the real dispatch.
          //
          // `renderTaskText`, not `buildUserMessage(input).content`: that
          // returns a `CoreMessage` whose content becomes an ARRAY once a
          // dispatch carries an attachment (#427), and the `typeof === 'string'`
          // guard this replaced would then have silently fed the policy engine
          // the bare description — diverging in exactly the way the comment
          // above promises it cannot.
          const policyInput = renderTaskText(input);
          const taskCtx = { ...ctx, policyDecision: agent.resolvePolicyDecisionFor(policyInput) };
          const { result, formatted } = await runDefinition(taskCtx, taskDefinition, input);
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
          setBusy(false);
        }
      },
      () => {
        flashToast(`Maximum concurrent agents (${getMaxConcurrentAgents()}) reached.`, 'error');
      },
    );
  }

  // Overlay-request helpers — built locally and bridged to the pre-mount
  // `ToolOptions` callbacks in `src/index.ts` via `setInkHandlers`. The
  // `handlersRef.current` assignment below rewrites the slot every render so
  // the registered (stable) shim object always forwards to the latest
  // closures.

  /**
   * The permission prompt an applet's declaration produces (#467, #468).
   *
   * This is the "installing an app" moment: the applet has just been built and
   * the user is already looking at the screen, which is the only point where an
   * interruption is cheaper than a note telling them to go and type a command
   * later. Everything after this is `/applets → Permissions`.
   *
   * **Bernard writes the label; the applet writes the reason.** The structural
   * facts — which capability, which origins — are rendered from the manifest by
   * `permission-consent.ts` and are verifiable. The applet's own sentence is
   * model-written prose being used to influence a security decision, so it is
   * quoted and attributed rather than presented as Bernard's own words, and it
   * is never the only thing on the row. Same posture as `<available_sources>`.
   *
   * **"Allow all" cannot cover everything, deliberately.** An ask marked
   * `ownScreen` — a two-way network channel, or any whole-scheme wildcard —
   * gets its own question however the blanket row was answered, because the
   * blanket row is the one people press without reading.
   *
   * Cancelling is a deny: the applet is still built, and the user can grant
   * later. Nothing here can widen anything the applet did not ask for.
   */
  async function requestPermissionConsent(
    request: PermissionConsentRequest,
    signal?: AbortSignal,
  ): Promise<PendingPermission[]> {
    const { pending, appName } = request;
    if (pending.length === 0) return [];

    const describe = (p: PendingPermission): string[] => [
      `  ${p.label}`,
      `    ${p.detail}`,
      // Attributed, so the reader can tell whose claim it is.
      ...(p.reason ? [`    "${p.reason}" — the applet's words`] : []),
    ];

    const blanket = pending.filter((p) => !p.ownScreen);
    const individually = pending.filter((p) => p.ownScreen);
    const header = [
      `${appName} needs permission to:`,
      '',
      ...pending.flatMap(describe),
      '',
      notAskedLine(pending),
    ];

    const allowed: PendingPermission[] = [];
    let reviewEach = blanket.length === 0;

    if (blanket.length > 0) {
      const rows: MenuEntry[] = [
        {
          label: blanket.length === pending.length ? 'Allow all' : 'Allow these',
          description: blanket.map((p) => p.label).join('; '),
        },
        { label: 'Review one at a time' },
        { label: "Skip — don't allow any" },
      ];
      const pick = await requestMenu(
        rows,
        { title: 'Applet permissions', headerLines: header },
        signal,
      );
      if (pick.cancelled || pick.index === 2) return [];
      if (pick.index === 0) allowed.push(...blanket);
      else reviewEach = true;
    }

    const remaining = reviewEach ? [...blanket, ...individually] : individually;
    for (const item of remaining) {
      if (signal?.aborted) return allowed;
      const rows: MenuEntry[] = [{ label: 'Allow' }, { label: "Don't allow" }];
      const pick = await requestMenu(
        rows,
        {
          title: item.label,
          headerLines: [
            ...describe(item),
            '',
            // Said plainly rather than in CSP terms, because this is the screen
            // where the difference actually costs something.
            item.key === 'connectSrc'
              ? 'This is a two-way channel: the applet can send data to these sites, not only read from them.'
              : item.sources.some((src) => src === 'https:' || src.includes('*'))
                ? 'This is a wildcard — it covers every site, not a named few.'
                : 'The applet can load content from these sites.',
          ],
        },
        signal,
      );
      if (pick.cancelled) return allowed;
      if (pick.index === 0) allowed.push(item);
    }
    return allowed;
  }

  handlersRef.current = {
    requestMenu,
    requestConfirm,
    requestBlock,
    requestTextInput,
    requestAskUser,
    requestPermissionConsent,
  };

  // Overlay teardown, one closure per pending slot. Passed to `openOverlay` so
  // an abort clears the same state the user's own answer would have.
  const closeMenu = () => {
    setPendingMenu(null);
    setActiveOverlay(null);
  };
  const closeMultiMenu = () => {
    setPendingMultiMenu(null);
    setActiveOverlay(null);
  };
  const closeDialog = () => {
    setPendingDialog(null);
    setActiveOverlay(null);
  };
  const closeTextInput = () => {
    setPendingTextInput(null);
    setActiveOverlay(null);
  };

  /**
   * `signal` is optional and TRAILING so the ~40 call sites that have none are
   * untouched. Before this, `MenuOverlay` carried a `signal` prop nothing ever
   * passed — exercised only by its own tests — while the abort that actually
   * happens, an agent turn cancelled with an `ask_user` menu on screen, left
   * the menu on the screen. See {@link openOverlay} for the settle/teardown
   * race every one of these shares.
   */
  function requestMenu(
    entries: MenuEntry[],
    options?: MenuOptions,
    signal?: AbortSignal,
  ): Promise<MenuResult> {
    return openOverlay<MenuResult>(signal, { cancelled: true }, closeMenu, (settle) => {
      setPendingMenu({ entries, options, resolve: settle });
      setActiveOverlay('menu');
    });
  }

  /**
   * Shows the tabbed settings screen ({@link SettingsOverlay}). Resolves when the
   * user picks an item (with the active tab + item index) or Esc-cancels; the
   * driver ({@link runSettings}) loops on the resolved tab.
   */
  function requestSettings(
    pending: Omit<PendingSettings, 'resolve'>,
  ): Promise<
    { cancelled: true } | { cancelled: false; tab: SettingsTab; index: number; item: MenuItem }
  > {
    return new Promise((resolve) => {
      setPendingSettings({ ...pending, resolve });
      setActiveOverlay('settings');
    });
  }

  /** Multi-select sibling of {@link requestMenu} (#231). Same abort idiom. */
  function requestMultiMenu(
    entries: MenuEntry[],
    options?: MenuOptions,
    signal?: AbortSignal,
  ): Promise<MultiMenuResult> {
    return openOverlay<MultiMenuResult>(signal, { cancelled: true }, closeMultiMenu, (settle) => {
      setPendingMultiMenu({ entries, options, resolve: settle });
      setActiveOverlay('multi-menu');
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
  /** Build a PermissionRule from a tool + selected breadth option (#261). */
  function buildRuleFromBreadth(
    toolName: string,
    breadth: BreadthOption | undefined,
    effect: ToolPermissionEffect,
  ): PermissionRule {
    return breadth
      ? { effect, tool: toolName, specifier: breadth.specifier, _v: 2 }
      : { effect, tool: toolName, _v: 2 };
  }

  /** Append a rule to the active profile and persist (#261). */
  function persistPermissionRule(rule: PermissionRule): void {
    config.toolPermissions = [...config.toolPermissions, rule];
    saveActiveSettings({ toolPermissions: config.toolPermissions });
  }

  /**
   * `/tool-permissions` (#212/#261): inspect/remove/flip the active profile's
   * persisted permission rules and toggle the global "Run Without Permission
   * Checks or Safeguards" escape hatch.
   */
  async function runToolPermissionsMenu(): Promise<void> {
    const skipOn = config.skipPermissions;
    const rules = config.toolPermissions;
    const entries: MenuEntry[] = [
      {
        label: 'Run Without Permission Checks or Safeguards',
        annotation: skipOn ? 'ON' : 'off',
        description: skipOn
          ? 'Every tool call runs without prompts or read-only blocking. Select to turn back off.'
          : 'Disable the block gate and every confirmation prompt for this profile.',
        value: '__skip__',
      },
      ...(rules.length > 0
        ? [
            { type: 'section' as const, title: 'Profile rules (deny → ask → allow):' },
            ...rules.map((r, i) => ({
              label: ruleLabel(r),
              annotation: r.effect,
              value: String(i),
            })),
            { label: 'Reset all rules', value: '__reset__' },
          ]
        : [{ type: 'section' as const, title: 'No tool rules saved for this profile.' }]),
    ];
    const result = await requestMenu(entries, {
      title: `Tool permissions — profile rules persist across sessions`,
    });
    if (result.cancelled) return;
    const value = result.item.value as string;

    if (value === '__skip__') {
      setSkipPermissions(!skipOn);
      return;
    }

    if (value === '__reset__') {
      config.toolPermissions = [];
      saveActiveSettings({ toolPermissions: [] });
      flashToast('All profile tool rules removed.', 'success');
      return;
    }

    // Per-rule submenu.
    const idx = Number(value);
    const rule = rules[idx];
    if (!rule) return;
    const flipped: ToolPermissionEffect = rule.effect === 'allow' ? 'deny' : 'allow';
    const sub = await requestMenu(
      [
        { label: 'Remove rule', value: 'remove' },
        { label: `Switch to ${flipped}`, value: 'switch' },
        { label: 'Cancel', value: 'cancel' },
      ],
      { title: `${ruleLabel(rule)} — currently ${rule.effect}` },
    );
    if (sub.cancelled || sub.item.value === 'cancel') return;
    if (sub.item.value === 'remove') {
      const updated = rules.filter((_, i) => i !== idx);
      config.toolPermissions = updated;
      saveActiveSettings({ toolPermissions: updated });
      flashToast(`Removed rule "${ruleLabel(rule)}".`, 'success');
      return;
    }
    const updated = rules.map((r, i) => (i === idx ? { ...r, effect: flipped } : r));
    config.toolPermissions = updated;
    saveActiveSettings({ toolPermissions: updated });
    flashToast(`"${ruleLabel(rule)}" switched to ${flipped}.`, 'success');
  }

  function requestConfirm(input: ConfirmActionInput, signal?: AbortSignal): Promise<boolean> {
    const key = `${input.toolName}:${stableHash(input.args)}`;
    if (confirmAllowSession.current.get(key)) return Promise.resolve(true);
    return openOverlay<boolean>(signal, false, closeDialog, (settle) => {
      setPendingDialog({
        kind: 'confirm',
        input,
        resolve: (allowed, scope, breadth) => {
          if (allowed && scope === 'session') confirmAllowSession.current.set(key, true);
          if (allowed && scope === 'profile') {
            persistPermissionRule(buildRuleFromBreadth(input.toolName, breadth, 'allow'));
          }
          settle(allowed);
        },
      });
      setActiveOverlay('confirm');
    });
  }

  function requestBlock(input: BlockActionInput, signal?: AbortSignal): Promise<BlockOutcome> {
    return openOverlay<BlockOutcome>(signal, 'deny', closeDialog, (settle) => {
      setPendingDialog({
        kind: 'block',
        input,
        resolve: (outcome, breadth) => {
          if (outcome === 'allow-tool-for-profile') {
            persistPermissionRule(buildRuleFromBreadth(input.toolName, breadth, 'allow'));
          }
          settle(outcome);
        },
      });
      setActiveOverlay('confirm');
    });
  }

  /** Free-text sibling of {@link requestMenu}. Same abort idiom. */
  function requestTextInput(
    options: ValuePromptOptions,
    signal?: AbortSignal,
  ): Promise<ValueResult> {
    return openOverlay<ValueResult>(signal, { cancelled: true }, closeTextInput, (settle) => {
      setPendingTextInput({ options, resolve: settle });
      setActiveOverlay('text-input');
    });
  }

  async function requestAskUser(
    questions: AskUserQuestion[],
    signal?: AbortSignal,
  ): Promise<AskUserBatchResult> {
    const answers: (string | string[])[] = [];
    for (const q of questions) {
      // Belt-and-braces since #266: every overlay below now takes the signal
      // itself, so an abort mid-question tears the overlay down instead of
      // waiting for the user to answer it and the loop to come back here.
      if (signal?.aborted) return { cancelled: true, answered: answers };

      // Free-text question (no choices) — prompt with TextInputOverlay.
      if (!q.choices || q.choices.length === 0) {
        const result = await requestTextInput(askUserPrompt(q.question), signal);
        if (result.cancelled) return { cancelled: true, answered: answers };
        answers.push(result.raw.trim());
        continue;
      }

      // Choice question. `buildChoiceMenu` appends an "Other" escape hatch when
      // requested and dedupes against a model-supplied "Other" entry (#230);
      // `isHatch` tells whether a picked row routes to free-text.
      const { entries, isHatch } = buildChoiceMenu(q);

      // Multi-select question (#231): toggle a checkbox set, commit at once.
      // The answer is the array of chosen labels; an "Other"-shaped pick still
      // routes to a free-text follow-up (same dedup behavior as single-select).
      if (q.multiSelect) {
        const result = await requestMultiMenu(entries, { title: q.question }, signal);
        if (result.cancelled) return { cancelled: true, answered: answers };
        const picked = result.items.filter((item) => !isHatch(item)).map((item) => item.label);
        if (result.items.some(isHatch)) {
          const free = await requestTextInput(askUserPrompt(q.question), signal);
          if (free.cancelled) return { cancelled: true, answered: answers };
          const typed = free.raw.trim();
          if (typed) picked.push(typed);
        }
        answers.push(picked);
        continue;
      }

      const result = await requestMenu(entries, { title: q.question }, signal);
      if (result.cancelled) return { cancelled: true, answered: answers };

      if (isHatch(result.item)) {
        // User picked "Other" — gather free-form text.
        const free = await requestTextInput(askUserPrompt(q.question), signal);
        if (free.cancelled) return { cancelled: true, answered: answers };
        answers.push(free.raw.trim());
      } else {
        answers.push(result.item.label);
      }
    }
    return { answers };
  }

  const banner = bannerVisible && alertBanner && (
    <Box marginTop={1} borderStyle="single" borderColor={colors.warning} paddingX={1}>
      <Text color={colors.warning}>{alertBanner}</Text>
    </Box>
  );

  // Rows the windowed overlays (#266) do NOT get, because something outside
  // them occupies those rows. Only App knows about either consumer, which is
  // why this is a prop and not a constant inside the overlay — the same shape
  // and reasoning as `BoundedLine`'s `reserveColumns`.
  //
  // Derived on EVERY render, never memoised on mount: the alert banner can
  // appear while an overlay is already open, and a budget captured at open
  // would then be one bordered box too generous.
  const overlayReserveRows =
    (banner ? BANNER_ROWS : 0) + (fullScreen ? 0 : LEGACY_INLINE_CHROME_ROWS);

  // Full-screen renders the scrollable <TranscriptViewport>; legacy mode keeps
  // the <Static>-based <Thread> (terminal scrollback). The epoch key remounts
  // either one on /clear.
  // The welcome splash renders as the first (scroll-away) content in the
  // viewport — the alt buffer has no normal screen to print it on. Built once;
  // a /clear (staticEpoch bump) remounts the viewport and drops it.
  const welcomeHeader =
    welcomeLines && welcomeLines.length > 0 && staticEpoch === 0 ? (
      <Box flexDirection="column" marginBottom={1}>
        {welcomeLines.map((line, i) => (
          <Text key={i}>{line.length === 0 ? ' ' : line}</Text>
        ))}
      </Box>
    ) : undefined;

  const thread = fullScreen ? (
    <TranscriptViewport
      key={staticEpoch}
      items={staticItems}
      messageStore={messageStore}
      busy={busy}
      interrupted={interrupted}
      streamingToolDetails={config.toolDetails}
      promptEmpty={promptEmpty || busy}
      mouseEnabled={mouseEnabled}
      header={welcomeHeader}
    />
  ) : (
    <Thread
      key={staticEpoch}
      staticItems={staticItems}
      messageStore={messageStore}
      busy={busy}
      interrupted={interrupted}
      streamingToolDetails={config.toolDetails}
    />
  );

  const chrome = (
    <>
      {busy && (
        <Box marginTop={1}>
          <Spinner label="thinking…" />
        </Box>
      )}
      {toast && <Toast message={toast.message} variant={toast.variant} />}
      <Prompt
        disabled={busy || activeOverlay !== null}
        onSubmit={handleSubmit}
        onSlashActiveChange={setSlashActive}
        onEmptyChange={setPromptEmpty}
        history={inputHistory}
        onRecordInput={recordInput}
        dynamicCommands={getDynamicCommands}
        renderAbove={({ maxRows, reserveColumns }) => (
          <PlanPanel agent={agent} maxRows={maxRows} reserveColumns={reserveColumns} />
        )}
      />
      <Box justifyContent="space-between">
        <HintBar
          busy={busy}
          overlayActive={activeOverlay !== null}
          slashActive={slashActive}
          scrollable={fullScreen}
        />
        <StatusBar agent={agent} />
      </Box>
    </>
  );

  // The overlay layer. In full-screen it REPLACES the thread+chrome (a true
  // modal frame); in legacy mode it is appended below the chrome as before.
  const overlays = (
    <>
      {activeOverlay === 'status' && (
        <StatusViewer
          agent={agent}
          config={config}
          sessionAllowedCount={_sessionToolAllowlist.size}
          onClose={() => setActiveOverlay(null)}
          onCycleTab={() => setActiveOverlay('sources')}
        />
      )}
      {activeOverlay === 'sources' && (
        <SourcesViewer
          agent={agent}
          onClose={() => setActiveOverlay(null)}
          onCycleTab={() => setActiveOverlay('context')}
        />
      )}
      {activeOverlay === 'context' && (
        <ContextViewer
          agent={agent}
          onClose={() => setActiveOverlay(null)}
          onCycleTab={() => setActiveOverlay('usage')}
        />
      )}
      {activeOverlay === 'usage' && (
        <UsageViewer
          agent={agent}
          onClose={() => setActiveOverlay(null)}
          onCycleTab={() => setActiveOverlay('status')}
        />
      )}
      {activeOverlay === 'menu' && pendingMenu && (
        <MenuOverlay
          entries={pendingMenu.entries}
          options={pendingMenu.options}
          reserveRows={overlayReserveRows}
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
      {activeOverlay === 'multi-menu' && pendingMultiMenu && (
        <MenuOverlay
          multiSelect
          entries={pendingMultiMenu.entries}
          options={pendingMultiMenu.options}
          reserveRows={overlayReserveRows}
          onMultiSelect={(items) => {
            pendingMultiMenu.resolve({ cancelled: false, items });
            setPendingMultiMenu(null);
            setActiveOverlay(null);
          }}
          onCancel={() => {
            pendingMultiMenu.resolve({ cancelled: true });
            setPendingMultiMenu(null);
            setActiveOverlay(null);
          }}
        />
      )}
      {activeOverlay === 'grid' && pendingGrid && (
        <ModelGridOverlay
          items={pendingGrid.items}
          reserveRows={overlayReserveRows}
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
          breadthOptions={pendingDialog.input.breadthOptions}
          onResolve={(allowed, scope, breadth) => {
            pendingDialog.resolve(allowed, scope, breadth);
            setPendingDialog(null);
            setActiveOverlay(null);
          }}
          onCancel={() => {
            pendingDialog.resolve(false, 'once', undefined);
            setPendingDialog(null);
            setActiveOverlay(null);
          }}
        />
      )}
      {activeOverlay === 'help' && (
        <HelpOverlay onClose={() => setActiveOverlay(null)} reserveRows={overlayReserveRows} />
      )}
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
      {activeOverlay === 'settings' && pendingSettings && (
        <SettingsOverlay
          initialTab={pendingSettings.initialTab}
          initialIndex={pendingSettings.initialIndex}
          optionsEntries={pendingSettings.optionsEntries}
          agentEntries={pendingSettings.agentEntries}
          onSelect={(tab, index, item) => {
            pendingSettings.resolve({ cancelled: false, tab, index, item });
            setPendingSettings(null);
            setActiveOverlay(null);
          }}
          onClose={() => {
            pendingSettings.resolve({ cancelled: true });
            setPendingSettings(null);
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
          breadthOptions={pendingDialog.input.breadthOptions}
          onResolve={(outcome, breadth) => {
            pendingDialog.resolve(outcome, breadth);
            setPendingDialog(null);
            setActiveOverlay(null);
          }}
          onCancel={() => {
            pendingDialog.resolve('deny', undefined);
            setPendingDialog(null);
            setActiveOverlay(null);
          }}
        />
      )}
    </>
  );

  if (fullScreen) {
    // Fixed-height frame: banner (if any), then either the modal overlay zone OR
    // the transcript (flex-grows to fill) with the chrome pinned to the bottom.
    return (
      <Box flexDirection="column" paddingX={2} height={rows}>
        {banner}
        {activeOverlay !== null ? (
          <Box flexDirection="column" flexGrow={1}>
            {overlays}
          </Box>
        ) : (
          <>
            {thread}
            {chrome}
          </>
        )}
      </Box>
    );
  }

  // Legacy inline rendering: thread always mounted (keeps <Static> scrollback),
  // chrome hidden only behind a Shift-Tab viewer, overlays appended below.
  return (
    <Box flexDirection="column" paddingX={2}>
      {banner}
      {thread}
      {!viewerActive && chrome}
      {overlays}
    </Box>
  );
}

/**
 * The overlay-request signatures the module-level helpers below take as
 * parameters, because they live OUTSIDE `<App>` and so cannot close over its
 * versions. There used to be two of these blocks — a `*Fn`-suffixed one here
 * and an unsuffixed superset further down — plus a third copy spelled out
 * inline in `runAddProviderInk`. One block, declared above its first consumer.
 *
 * `MenuResult` comes from `ink-handlers.ts`, where it was already exported and
 * then re-spelled inline in five places.
 */
type RequestMenu = (
  entries: MenuEntry[],
  options?: MenuOptions,
  signal?: AbortSignal,
) => Promise<MenuResult>;
type RequestGridMenu = (
  items: string[],
  options?: { title?: string; footer?: string; initialIndex?: number; currentItem?: string },
) => Promise<{ cancelled: true } | { cancelled: false; index: number }>;
type RequestTextInput = (options: ValuePromptOptions, signal?: AbortSignal) => Promise<ValueResult>;
type FlashToast = (message: string, variant?: ToastVariant) => void;

/**
 * The delete-confirmation menu, which was copy-pasted five times (cron,
 * profiles, routines, specialists, lineups) with a byte-identical menu in all
 * five.
 *
 * Module-level, and `requestMenu` is its FIRST PARAMETER rather than a closure
 * capture, because the lineups call site lives outside `<App>` and receives
 * `requestMenu` as an argument of its own. (The module-level helpers already
 * have a parameter of that name, so a helper closing over the component's
 * `requestMenu` would silently be the wrong one.)
 *
 * The AFTERMATH is deliberately NOT shared: cancel control flow differs
 * (`continue` at the four loop sites vs. `return` in profiles), two of five
 * wrap the deletion in try/catch, there are three distinct toast wordings, and
 * cron additionally clears job logs and re-syncs the daemon. All of that stays
 * at the call sites.
 */
async function confirmDeletion(requestMenu: RequestMenu, name: string): Promise<boolean> {
  const confirm = await requestMenu(
    [{ label: `Delete "${name}"`, description: 'This cannot be undone.' }, { label: 'Cancel' }],
    { title: 'Confirm deletion' },
  );
  return !confirm.cancelled && confirm.index === 0;
}

async function pickWizardField(
  field: WizardFieldData,
  current: unknown,
  requestMenu: RequestMenu,
  requestTextInput: RequestTextInput,
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
  requestMenu: RequestMenu,
  requestTextInput: RequestTextInput,
  _flashToast: FlashToast,
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
  lines.push({ text: `  Recall filter: ${config.recallFilter ? 'on' : 'off'}`, dim: true });
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

/**
 * Seeds a conversational edit of an existing specialist (the `/specialists`
 * menu's Edit action). The agent is given the current definition and told to ask
 * what to change, then persist via the `specialist` tool's `update` action.
 */
function buildSpecialistEditSeed(s: Specialist): string {
  const lines = [
    `The user wants to edit the "${s.name}" specialist (id: ${s.id}).`,
    '',
    'Current definition:',
    `- name: ${s.name}`,
    `- description: ${s.description}`,
    `- kind: ${s.kind ?? 'persona'}`,
  ];
  if (s.targetTools?.length) lines.push(`- targetTools: ${s.targetTools.join(', ')}`);
  if (s.provider) lines.push(`- provider: ${s.provider}`);
  if (s.model) lines.push(`- model: ${s.model}`);
  if (s.disabled) lines.push('- status: disabled');
  lines.push(
    '',
    'Ask what they would like to change. Once they confirm, apply it with the ' +
      `specialist tool (action: "update", id: "${s.id}"), changing only the fields ` +
      'they asked for, then confirm what was saved.',
  );
  return lines.join('\n');
}

/**
 * Seeds a conversational edit of an existing routine (the `/routines` menu's
 * Edit action). The agent gets the current definition and persists changes via
 * the `routine` tool's `update` action.
 */
function buildRoutineEditSeed(r: Routine): string {
  return [
    `The user wants to edit the "${r.name}" routine (id: ${r.id}).`,
    '',
    'Current definition:',
    `- name: ${r.name}`,
    `- description: ${r.description}`,
    '- content:',
    r.content,
    '',
    'Ask what they would like to change. Once they confirm, apply it with the ' +
      `routine tool (action: "update", id: "${r.id}"), changing only the fields they ` +
      'asked for, then confirm what was saved.',
  ].join('\n');
}

const CREATE_SEED_PROMPTS: Readonly<Record<string, string | undefined>> = {
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
  requestMenu: RequestMenu,
  requestTextInput: RequestTextInput,
  flashToast: FlashToast,
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

/**
 * Generation-params editor step (issue #286). Rendered after a model is picked
 * in a lineup slot (or a specialist pin). If the model exposes no tunable
 * params (`describeModelParams` empty) it returns immediately, so the UX is
 * unchanged for models without knobs. Otherwise it loops a menu of descriptors
 * — enum/toggle via a sub-menu, number/range via a validated text input —
 * until the user picks Done (or Esc). Returns the chosen {@link ModelParams},
 * or `undefined` when nothing is set (clean disk record = model defaults).
 */
async function pickGenerationParamsInk(
  provider: string,
  model: string,
  sdk: SupportedSdk | undefined,
  current: ModelParams | undefined,
  requestMenu: RequestMenu,
  requestTextInput: RequestTextInput,
  flashToast: FlashToast,
): Promise<ModelParams | undefined> {
  const descriptors = describeModelParams(provider, model, sdk);
  if (descriptors.length === 0) return current;

  const values: ModelParams = { ...(current ?? {}) };

  while (true) {
    const entries: MenuEntry[] = descriptors.map((d) => {
      const v = values[d.id];
      return {
        label: d.label,
        annotation: v === undefined ? '(default)' : String(v),
        value: { kind: 'edit', descriptor: d } as const,
      };
    });
    entries.push({ type: 'section', title: '' });
    entries.push({ label: 'Done', value: { kind: 'done' } as const });
    entries.push({ label: 'Reset to model defaults', value: { kind: 'reset' } as const });

    const pick = await requestMenu(entries, {
      title: `Generation params · ${model}`,
      headerLines: ['Leave a param as (default) to use the model default. Esc = done.'],
    });
    if (pick.cancelled) break; // Esc commits whatever's set so far
    const choice = pick.item.value as
      | { kind: 'edit'; descriptor: ParamDescriptor }
      | { kind: 'done' }
      | { kind: 'reset' };
    if (choice.kind === 'done') break;
    if (choice.kind === 'reset') {
      for (const k of Object.keys(values) as ParamId[]) delete values[k];
      continue;
    }

    const d = choice.descriptor;
    if (d.kind === 'enum' || d.kind === 'toggle') {
      const opts = d.kind === 'toggle' ? ['on', 'off'] : (d.options ?? []);
      const optEntries: MenuEntry[] = [
        { label: '(use model default)', value: { clear: true } as const },
        ...opts.map((o) => ({ label: o, value: { val: o } as const })),
      ];
      const sel = await requestMenu(optEntries, { title: d.label });
      if (sel.cancelled) continue;
      const sv = sel.item.value as { clear: true } | { val: string };
      if ('clear' in sv) delete values[d.id];
      else values[d.id] = d.kind === 'toggle' ? sv.val === 'on' : sv.val;
    } else {
      const isFloat = d.kind === 'range';
      const bounds = `${d.min ?? '−∞'}–${d.max ?? '∞'}`;
      const res = await requestTextInput({
        label: `${d.label} (${bounds}; empty = default)`,
        initialValue: values[d.id] !== undefined ? String(values[d.id]) : '',
      });
      if (res.cancelled) continue;
      const raw = res.raw.trim();
      if (raw === '') {
        delete values[d.id];
        continue;
      }
      const parsed = isFloat ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
      if (
        Number.isNaN(parsed) ||
        (!isFloat && String(parsed) !== raw) ||
        (d.min !== undefined && parsed < d.min) ||
        (d.max !== undefined && parsed > d.max)
      ) {
        flashToast(
          `${d.label} must be a ${isFloat ? 'number' : 'whole number'} in ${bounds}.`,
          'error',
        );
        continue;
      }
      values[d.id] = parsed;
    }
  }

  const cleaned = validateModelParams(provider, model, values, sdk);
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

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
  roleLabel?: string,
): Promise<LineupSlot | null> {
  const slotLabel = (t: LineupTier): string =>
    roleLabel ? `${roleLabel} / ${t.toUpperCase()}` : `${t.toUpperCase()}`;
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
      title: `Pick provider for ${slotLabel(tier)} slot`,
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
    // Free-type is offered for every provider, not just custom ones: the
    // built-in catalog (Vercel AI Gateway) omits some real models (e.g. xAI's
    // grok-code-fast-1 isn't proxied under the `xai/` prefix), so without this
    // escape hatch those models are unreachable through the picker.
    const FREE_TYPE = '+ Type a new model name…';
    const items: string[] = [...models, FREE_TYPE];

    if (items.length === 0) {
      flashToast(`No models known for provider "${provider}".`, 'error');
      continue;
    }

    const currentModelForProvider = provider === current.provider ? current.model : undefined;
    const initialIndex =
      currentModelForProvider && models.includes(currentModelForProvider)
        ? models.indexOf(currentModelForProvider)
        : 0;

    const result = await requestGridMenu(items, {
      title: `Pick ${providerDisplayName(provider)} model for ${slotLabel(tier)} slot`,
      footer: formatCatalogFooter(),
      initialIndex,
      currentItem: currentModelForProvider,
    });
    if (result.cancelled) continue; // back to provider step

    const sdk = config.customProviders?.[provider]?.sdk;
    // Pre-fill the params editor with the slot's existing params only when the
    // provider+model are unchanged — switching model shouldn't carry stale knobs.
    const paramsFor = (model: string): ModelParams | undefined =>
      provider === current.provider && model === current.model ? current.params : undefined;

    const picked = items[result.index];
    if (picked === FREE_TYPE) {
      const modelRes = await requestTextInput({ label: `New model name for ${provider}` });
      if (modelRes.cancelled || !modelRes.raw.trim()) continue;
      const model = modelRes.raw.trim();
      // Only the custom-provider store remembers typed model names; built-in
      // providers draw their list from the catalog, so a free-typed built-in
      // model is used as-is for this slot without persisting it there.
      if (isCustom) {
        rememberCustomModel(provider, model);
        config.customProviders = loadCustomProviders();
      }
      const params = await pickGenerationParamsInk(
        provider,
        model,
        sdk,
        paramsFor(model),
        requestMenu,
        requestTextInput,
        flashToast,
      );
      return { provider, model, ...(params ? { params } : {}) };
    }
    const params = await pickGenerationParamsInk(
      provider,
      picked,
      sdk,
      paramsFor(picked),
      requestMenu,
      requestTextInput,
      flashToast,
    );
    return { provider, model: picked, ...(params ? { params } : {}) };
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

/** One-line `premium · mid · cheap` summary of a role's cost ladder. */
function summarizeRoleSlots(slots: RoleSlots): string {
  return (
    `premium ${slots.premium.provider}/${slots.premium.model} · ` +
    `mid ${slots.mid.provider}/${slots.mid.model} · ` +
    `cheap ${slots.cheap.provider}/${slots.cheap.model}`
  );
}

/**
 * Right-pane detail card content for the split-layout lineup editor (Style 2).
 * A role row shows its premium/mid/cheap ladder, the role description, and an
 * "edit" hint; a lineup-level action row shows a one-line explainer + hint. The
 * overlay supplies the surrounding border and the row's label as the card title.
 */
/** Compact one-line summary of a slot's generation params, '' when none. */
function formatParamsSummary(params?: ModelParams): string {
  if (!params) return '';
  const parts = Object.entries(params).map(([k, v]) => `${k} ${v}`);
  return parts.length > 0 ? parts.join(', ') : '';
}

function renderLineupDetail(item: MenuItem, draft: Lineup): ReactNode {
  const colors = getThemeColors();
  const value = item.value as
    | { kind: 'role'; roleId: RoleId }
    | { kind: 'rename' | 'save' | 'save-new' | 'delete' | 'cancel' };

  if (value.kind === 'role') {
    const role = getRole(value.roleId);
    const slots = draft.roles[value.roleId];
    // Dotted-leader rows: `tier ......... provider/model`, value right-aligned
    // against a fixed inner width so the three tiers line up like a contents list.
    const LEADER_WIDTH = 44;
    return (
      <Box flexDirection="column">
        <Text dimColor>{role.description}</Text>
        <Text> </Text>
        {LINEUP_TIERS.map((tier) => {
          const val = `${slots[tier].provider}/${slots[tier].model}`;
          const dots = '.'.repeat(Math.max(2, LEADER_WIDTH - tier.length - val.length));
          const params = formatParamsSummary(slots[tier].params);
          return (
            <Text key={tier}>
              {tier}
              <Text dimColor>{dots}</Text>
              <Text color={colors.accent}>{val}</Text>
              {params ? <Text dimColor> · {params}</Text> : null}
            </Text>
          );
        })}
        <Text> </Text>
        <Text dimColor>What to look for when selecting:</Text>
        <Text>{role.lookFor}</Text>
        <Text> </Text>
        <Text color={colors.accent}>↵ edit this role</Text>
      </Box>
    );
  }

  const actionDetail: Record<string, { explain: string; hint: string }> = {
    rename: { explain: 'Give this lineup a new display name.', hint: '↵ rename' },
    save: { explain: 'Persist your edits to this lineup.', hint: '↵ save' },
    'save-new': {
      explain: 'Clone the current grid into a new lineup under a name you choose.',
      hint: '↵ save as new',
    },
    delete: { explain: 'Remove this lineup (refuses if it is the last one).', hint: '↵ delete' },
    cancel: { explain: 'Discard changes and close the editor.', hint: '↵ cancel' },
  };
  const { explain, hint } = actionDetail[value.kind];
  return (
    <Box flexDirection="column">
      <Text dimColor>{explain}</Text>
      <Text> </Text>
      <Text color={colors.accent}>{hint}</Text>
    </Box>
  );
}

/**
 * Level-2 editor: the three cost-tier slots (premium / mid / cheap) for one
 * role. Mutates a copy of `slots` and returns it on both `← Back` and Esc —
 * edits are applied live into the returned ladder, so cancel and back are
 * equivalent (there is no discard path here; the parent editor owns that).
 * Selecting a tier opens the provider→model picker.
 */
async function runRoleSlotsEditorInk(
  roleId: RoleId,
  initial: RoleSlots,
  config: BernardConfig,
  requestMenu: RequestMenu,
  requestGridMenu: RequestGridMenu,
  requestTextInput: RequestTextInput,
  flashToast: FlashToast,
): Promise<RoleSlots> {
  const role = getRole(roleId);
  let slots: RoleSlots = {
    premium: { ...initial.premium },
    mid: { ...initial.mid },
    cheap: { ...initial.cheap },
  };
  while (true) {
    const tierRows: MenuEntry[] = LINEUP_TIERS.map((tier) => {
      const params = formatParamsSummary(slots[tier].params);
      return {
        label: `${tier.toUpperCase()}`,
        annotation: `→ ${slots[tier].provider} / ${slots[tier].model}${params ? ` · ${params}` : ''}`,
        value: { kind: 'tier', tier },
      };
    });
    const entries: MenuEntry[] = [
      ...tierRows,
      { type: 'section', title: '' },
      { label: '← Back to roles', value: { kind: 'back' } },
    ];
    const pick = await requestMenu(entries, {
      title: `${role.label} — pick cost tier to bind`,
      headerLines: [role.description],
    });
    if (pick.cancelled) return slots;
    const value = pick.item.value as { kind: 'tier'; tier: LineupTier } | { kind: 'back' };
    if (value.kind === 'back') return slots;
    const next = await pickLineupSlotInk(
      config,
      value.tier,
      slots[value.tier],
      requestMenu,
      requestGridMenu,
      requestTextInput,
      flashToast,
      role.label,
    );
    if (next) slots = { ...slots, [value.tier]: next };
  }
}

/**
 * Editor for one lineup. Two levels: the top menu lists the functional roles
 * (orchestrator / executor / …), each showing its current premium·mid·cheap
 * binding; selecting a role opens its three cost-tier slots. Plus rename and
 * either "Save" (existing) or "Save as new" (draft). Returns the persisted
 * lineup on save, or `null` on cancel.
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
  // Snapshot the starting shape so we can tell whether the user actually
  // changed anything. The multi-level editor only persists on an explicit
  // "Save changes", so without this a user who edits roles and then backs out
  // (Esc / Cancel) silently loses all their work — the #1 "lineups don't save"
  // complaint. We compare against this baseline to decide whether to guard the
  // exit. Rename keys off `name`; role edits off the per-role slot ladders.
  const baseline = stableStringify({ name: initial.name, roles: initial.roles });
  const isDirty = (): boolean =>
    stableStringify({ name: draft.name, roles: draft.roles }) !== baseline;

  /** Persist the current draft. Returns the saved lineup, or null on error. */
  const commit = (asNew: boolean): Lineup | null => {
    try {
      return saveLineup({
        // Omit id for "save as new" so saveLineup slugs a fresh one from name.
        ...(asNew ? {} : { id: draft.id }),
        name: draft.name,
        roles: draft.roles,
      });
    } catch (err) {
      flashToast(`Failed to save: ${(err as Error).message}`, 'error');
      return null;
    }
  };

  /**
   * Common exit path for Esc / Cancel. If there are unsaved edits, prompt
   * rather than silently discarding them. Returns `{ done: true, result }` to
   * leave the editor, or `{ done: false }` to keep editing.
   */
  const handleExit = async (): Promise<{ done: true; result: Lineup | null } | { done: false }> => {
    if (!isDirty()) return { done: true, result: null };
    const confirm = await requestMenu(
      [
        { label: opts.isNew ? 'Save as new lineup' : 'Save changes', value: 'save' },
        { label: 'Discard changes', value: 'discard' },
        { label: 'Keep editing', value: 'keep' },
      ],
      { title: 'You have unsaved lineup changes' },
    );
    // Esc on the guard itself = "keep editing" (safest — never lose work).
    if (confirm.cancelled) return { done: false };
    const action = confirm.item.value as 'save' | 'discard' | 'keep';
    if (action === 'keep') return { done: false };
    if (action === 'discard') return { done: true, result: null };
    const saved = commit(opts.isNew ?? false);
    // Save failed (toast already shown) → fall back to keep-editing so the
    // user doesn't lose their draft to a transient validation error.
    return saved ? { done: true, result: saved } : { done: false };
  };

  while (true) {
    // Left-pane rows stay lean (just the role/action label); the right-pane
    // detail card carries the premium/mid/cheap ladder and the description.
    const roleRows: MenuEntry[] = MODEL_ROLES.map((role) => ({
      label: role.label,
      value: { kind: 'role', roleId: role.id },
    }));
    const dirtyMark = isDirty() ? ' •' : '';
    const entries: MenuEntry[] = [
      ...roleRows,
      { type: 'section', title: '' },
      { label: 'Rename lineup', value: { kind: 'rename' } },
      ...(opts.isNew
        ? [{ label: 'Save as new lineup', value: { kind: 'save-new' } } as MenuEntry]
        : [
            { label: `Save changes${dirtyMark}`, value: { kind: 'save' } } as MenuEntry,
            { label: 'Save as new lineup', value: { kind: 'save-new' } } as MenuEntry,
            { label: 'Delete lineup', value: { kind: 'delete' } } as MenuEntry,
          ]),
      { label: 'Cancel', value: { kind: 'cancel' } },
    ];
    const pick = await requestMenu(entries, {
      title: `Lineup: ${draft.name}${opts.isNew ? ' (draft)' : ''}${
        dirtyMark ? ' — unsaved changes' : ''
      } — pick a role`,
      layout: 'split',
      renderDetail: (item) => renderLineupDetail(item, draft),
    });
    if (pick.cancelled) {
      const exit = await handleExit();
      if (exit.done) return exit.result;
      continue;
    }
    const value = pick.item.value as
      | { kind: 'role'; roleId: RoleId }
      | { kind: 'rename' | 'save' | 'save-new' | 'delete' | 'cancel' };
    if (value.kind === 'cancel') {
      const exit = await handleExit();
      if (exit.done) return exit.result;
      continue;
    }
    if (value.kind === 'role') {
      const nextSlots = await runRoleSlotsEditorInk(
        value.roleId,
        draft.roles[value.roleId],
        config,
        requestMenu,
        requestGridMenu,
        requestTextInput,
        flashToast,
      );
      draft = {
        ...draft,
        roles: { ...draft.roles, [value.roleId]: nextSlots },
      };
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
      const saved = commit(false);
      if (saved) return saved;
      continue;
    }
    if (value.kind === 'save-new') {
      const saved = commit(true);
      if (saved) return saved;
      continue;
    }
    if (value.kind === 'delete') {
      if (!(await confirmDeletion(requestMenu, draft.name))) continue;
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
 * Keeps the confirm-allow session memo stable across re-renders that reshuffle
 * object key order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** djb2 over the stable-JSON form. */
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
