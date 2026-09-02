import { type CoreMessage, type UserContent } from 'ai';
import { getModelProfile } from './providers/index.js';
import { getProviderRequestCount } from './providers/request-counter.js';
import {
  printInfo,
  printWarning,
  startSpinner,
  buildSpinnerMessage,
  type SpinnerStats,
} from './output.js';
import { runDefinition, registerBuiltinDefinitions } from './framework/agents/index.js';
import {
  mainAgentDefinition,
  buildMainSystemPrompt,
  buildMainContextMessages,
  type MainInput,
} from './framework/agents/main.js';
import { type IterateFn } from './framework/strategies/index.js';
import { debugLog, isDebugEnabled } from './logger.js';
import {
  shouldCompress,
  compressHistory,
  truncateToolResults,
  estimateHistoryTokens,
  estimatePrefixTokens,
  emergencyTruncate,
  isTokenOverflowError,
  getContextWindow,
} from './context.js';
import { resolveMainModel } from './model-policy.js';
import { saveActiveSettings } from './profiles.js';
import type { AskUserBatchResult } from './tools/types.js';
import type { BernardConfig } from './config.js';
import type { MemoryStore } from './memory.js';
import type { RAGStore, RAGSearchResult } from './rag.js';
import { RoutineStore } from './routines.js';
import { SpecialistStore } from './specialists.js';
import { CorrectionCandidateStore } from './correction-candidates.js';
import { matchSpecialists } from './specialist-matcher.js';
import {
  extractRecentUserTexts,
  extractRecentToolContext,
  buildRAGQuery,
  applyStickiness,
} from './rag-query.js';
import { timestampUserMessage } from './tools/datetime.js';
import { type ImageAttachment, IMAGE_TOKEN_ESTIMATE } from './image.js';
import { PlanStore } from './plan-store.js';
import { type ResolvedEntry } from './reference-resolver.js';
import type { AgentContext } from './framework/context.js';
import { recordTurnUsage } from './framework/hooks/token-stats.js';
import { telemetryFromUsageRecord } from './session-telemetry.js';
import { computeTurnUsageReport } from './usage-report.js';
import { CONTINUATION_PREFIX } from './session-markers.js';
import { DefaultPolicyEngine, isReactEffective } from './policy/index.js';
import type { PolicyDecision, PolicyEngine, PolicyResult } from './policy/index.js';
import { extractCitationMarkers, type SourceItem, type TurnProvenance } from './provenance.js';
import { type TurnContextRecord } from './turn-context.js';
import { SemanticResponseCache } from './semantic-cache.js';
import { isPureQuestion } from './policy/tool-mode.js';
import type { Step } from './plan-store.js';
import type { VerificationEntry } from './agent-status.js';
import { verdictOf, renderRubricLine, type Check, type Rubric } from './rubric.js';

// `buildSystemPrompt` lives in agent-prompt.ts (extracted to avoid a circular
// import with framework/agents/main.ts). Re-exported here so existing imports
// from './agent.js' continue to work.
export {
  buildSystemPrompt,
  BASE_SYSTEM_PROMPT,
  SHARE_REASONING_PROMPT,
  REASONING_FAMILIES,
} from './agent-prompt.js';

// ReAct primitives live in ./react.js so tools/* can use them without forming
// a circular import via agent.ts. Re-exported here because agent.test.ts and
// other callers import them from './agent.js'.
import {
  REACT_COORDINATOR_PROMPT,
  REACT_MAX_STEPS_CEILING,
  STEP_LIMIT_MAX_EXPANSIONS,
} from './react.js';
export {
  REACT_COORDINATOR_PROMPT,
  shouldEnforcePlan,
  computePlanNeeds,
  REACT_MAX_STEPS_CEILING,
  computeEffectiveMaxSteps,
  REACT_ENFORCEMENT_MAX_RETRIES,
  REACT_AUTO_CANCEL_NOTE,
  buildEnforcementFeedback,
} from './react.js';

export interface CompactResult {
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Core agent that manages a multi-step conversation loop with tool calling via the Vercel AI SDK.
 *
 * Maintains conversation history, handles context compression when token limits
 * approach, performs RAG lookups, and orchestrates LLM calls via
 * {@link runDefinition} against {@link mainAgentDefinition}. The definition
 * owns prompt + tool assembly + strategy + step budget; this class retains
 * the main-only concerns of persistent history, compression, emergency
 * truncation, auto-continue, and IO wiring.
 */
/**
 * Orders memory keys the way `renderPersistentMemory` packs them, so the
 * per-turn context record leads with the entries most likely to have survived
 * a budget trim. Mirrors `orderForPacking`; kept separate because that operates
 * on entries and this on bare keys, and the record is a display artefact.
 */
function orderMemoryKeysForDisplay(keys: string[], priority?: string[]): string[] {
  if (!priority || priority.length === 0) return keys;
  const rank = new Map(priority.map((k, i) => [k, i]));
  const last = priority.length;
  return [...keys].sort((a, b) => (rank.get(a) ?? last) - (rank.get(b) ?? last));
}

export class Agent {
  private history: CoreMessage[] = [];
  private config: BernardConfig;
  private memoryStore: MemoryStore;
  private alertContext?: string;
  private ragStore?: RAGStore;
  private previousRAGFacts: Set<string> = new Set();
  private lastRAGResults: RAGSearchResult[] = [];
  private lastSources: SourceItem[] = [];
  private lastCitedSources: SourceItem[] = [];
  /**
   * Per-turn citation snapshots for the whole current conversation —
   * powers the Shift+Tab full-screen citation viewer. Issue #211. Cleared
   * by {@link clearHistory}; loaded on resume via {@link setTurnProvenance}.
   */
  private turnProvenance: TurnProvenance[] = [];
  /**
   * Per-turn prompt/context snapshots for the whole current conversation —
   * powers the Shift+Tab "Prompt & Context" viewer. Cleared by
   * {@link clearHistory}; loaded on resume via {@link setTurnContext}.
   */
  private turnContext: TurnContextRecord[] = [];
  /**
   * Semantic response cache (#269, Layer 3). Opt-in via `config.semanticCache`.
   * Only consulted/populated for read-only Q&A turns (no tool actions).
   */
  private semanticCache = new SemanticResponseCache();
  /** Most recent per-turn rubric (#145). Composed at end of `processInput`. */
  private lastRubric: Rubric | null = null;
  private abortController: AbortController | null = null;
  // Partial-progress recorder for the in-flight LLM call (issue: history lost
  // on Esc). `partialStepMessages` holds the AI SDK's cumulative
  // `response.messages` snapshot from the last completed step;
  // `partialText` accumulates streamed deltas of the step still in flight.
  // Both reset at the start of every inner iterate call (see the
  // `partialObserver` passed to `runDefinition`) and flush into `history`
  // only on user abort.
  private partialStepMessages: CoreMessage[] = [];
  private partialText: string = '';
  private lastPromptTokens: number = 0;
  /**
   * Wire size of the main agent's tool block, in characters (#323).
   *
   * Measured once, on the first dispatch of the session, and reused: the main
   * tool set is session-stable — the same invariant `BERNARD_PROMPT_CACHE`
   * depends on and `main.tool-block-stability.test.ts` pins — so re-measuring
   * per turn would pay an O(schema-size) conversion for an unchanging number.
   *
   * `undefined` until that first dispatch returns, which is correct rather than
   * merely tolerable for a fresh session: there is no history to overflow with
   * yet. It IS a real gap on a *resumed* session, whose turn 1 carries a full
   * loaded history but still budgets the tool block at 0 — fixing that means
   * measuring at tool assembly rather than off a dispatch result, which is the
   * deeper restructure noted on #323.
   */
  private mainToolBytes: number | undefined;
  // Public so tokenStatsHook (an external module) can mutate these in place
  // after each agent step. See src/framework/hooks/token-stats.ts.
  lastStepPromptTokens: number = 0;
  spinnerStats: SpinnerStats | null = null;
  /**
   * True between `beginTurnStats()` and the end of the following `processInput`
   * (#258). When the REPL opens a turn it calls `beginTurnStats()` *before* the
   * pre-turn pipeline so resolver/rewriter tokens land in the ledger; the flag
   * then suppresses `processInput`'s own reset so those entries survive. Direct
   * callers (cron, tests) never set it, so `processInput` resets as before.
   */
  private turnStatsBegun = false;
  /**
   * The execution strategy chosen for the current (or most recent) turn,
   * resolved by the Policy Engine + Qualifier. `null` between turns. Read by
   * the StatusBar to render the coordinator/normal indicator. Mutated on
   * `processInput` start and cleared in its `finally`.
   */
  currentStrategy: 'react' | 'normal' | null = null;
  private routineStore: RoutineStore;
  private specialistStore: SpecialistStore;
  private correctionStore: CorrectionCandidateStore;
  private stepLimitHitCount: number = 0;
  private lastStepLimitHit: boolean = false;
  private planStore: PlanStore = new PlanStore();
  private policyEngine: PolicyEngine = new DefaultPolicyEngine();
  private lastPolicyResult?: PolicyResult;
  private lastUserInput: string | null = null;
  private lastResolvedReferences: ResolvedEntry[] = [];

  private ctx: AgentContext;

  constructor(ctx: AgentContext, opts?: { alertContext?: string; initialHistory?: CoreMessage[] }) {
    this.ctx = ctx;
    this.config = ctx.config;
    this.memoryStore = ctx.stores.memory;
    this.alertContext = opts?.alertContext;
    this.ragStore = ctx.rag;
    this.routineStore = ctx.stores.routines;
    this.specialistStore = ctx.stores.specialists;
    this.correctionStore = ctx.stores.correction;
    registerBuiltinDefinitions();
    if (opts?.initialHistory) {
      this.history = [...opts.initialHistory];
      this.lastPromptTokens = Math.ceil(JSON.stringify(opts.initialHistory).length / 4);
    }
  }

  /** Returns the current conversation message history. */
  getHistory(): CoreMessage[] {
    return this.history;
  }

  /** Returns the store that queues tool-wrapper correction candidates for this session. */
  getCorrectionStore(): CorrectionCandidateStore {
    return this.correctionStore;
  }

  /** Returns the specialist store used by this agent. */
  getSpecialistStore(): SpecialistStore {
    return this.specialistStore;
  }

  /** Returns the RAG search results from the most recent `processInput` call. */
  getLastRAGResults(): RAGSearchResult[] {
    return this.lastRAGResults;
  }

  /**
   * Every source registered during the last turn (web, RAG, memory, file
   * reads), regardless of whether the response cited it. Powers the
   * Shift+Tab "Sources" viewer. Issue #173.
   */
  getLastSources(): SourceItem[] {
    return this.lastSources;
  }

  /**
   * Sources actually cited by the last response — every item whose id
   * appeared as a `[^Sn]` marker in the model's text. Subset of
   * {@link getLastSources}. Issue #173.
   */
  getLastCitedSources(): SourceItem[] {
    return this.lastCitedSources;
  }

  /**
   * Returns a snapshot of every completed turn's provenance for this
   * conversation. Powers the Shift+Tab full-screen citation viewer.
   * Issue #211.
   */
  getTurnProvenance(): TurnProvenance[] {
    return [...this.turnProvenance];
  }

  /**
   * Restores per-turn citation snapshots when a session is resumed. Replaces
   * any in-memory records. Issue #211.
   */
  setTurnProvenance(records: TurnProvenance[]): void {
    this.turnProvenance = [...records];
  }

  /**
   * Returns a snapshot of every completed turn's prompt/context trail for this
   * conversation. Powers the Shift+Tab "Prompt & Context" viewer.
   */
  getTurnContext(): TurnContextRecord[] {
    return [...this.turnContext];
  }

  /** Restores per-turn context snapshots when a session is resumed. */
  setTurnContext(records: TurnContextRecord[]): void {
    this.turnContext = [...records];
  }

  /**
   * Most recent per-turn evaluation rubric — the composed pass/warn/fail
   * verdict + the list of contributing checks. Null before the first turn or
   * after `clearHistory`. Issue #145.
   */
  getLastRubric(): Rubric | null {
    return this.lastRubric;
  }

  /** Cancels the in-flight LLM request, if any. Safe to call when no request is active. */
  abort(): void {
    this.abortController?.abort();
  }

  /** Returns the most recent Policy Engine result, or undefined before any turn has run. */
  getLastPolicyDecision(): PolicyResult | undefined {
    return this.lastPolicyResult;
  }

  /** Most recent raw user input. `null` before any turn. Issue #140. */
  getLastUserInput(): string | null {
    return this.lastUserInput;
  }

  /** Reference-resolver entries from the most recent turn. Issue #140. */
  getLastResolvedReferences(): ResolvedEntry[] {
    return [...this.lastResolvedReferences];
  }

  /** Most recent PAC critic verdict (or null). Issue #140. */
  getLastVerification(): VerificationEntry | null {
    return this.ctx.verification.getLast();
  }

  /** Snapshot of the current plan (in-memory, per-turn). Issue #140. */
  getPlanSnapshot(): Step[] {
    return this.planStore.view();
  }

  /**
   * Subscribes to plan mutations (create/add/update/clear/cancel). Returns an
   * unsubscribe function. Used by `<PlanPanel>` for live mid-turn updates.
   */
  subscribeToPlanStore(cb: () => void): () => void {
    return this.planStore.subscribe(cb);
  }

  /**
   * Returns the live `AgentContext` (with the most recent `policyDecision`
   * threaded in by `processInput`). The Agent class re-points `this.ctx`
   * on every turn, so callers that need to invoke a definition outside the
   * normal turn loop (e.g. the correction agent at REPL shutdown) should
   * read this fresh rather than caching the value handed back at startup.
   */
  getContext(): AgentContext {
    return this.ctx;
  }

  /**
   * Resolves a {@link PolicyDecision} for a dispatch that runs OUTSIDE the
   * normal `processInput` turn loop (e.g. `/task`, `task-` routines). Between
   * turns `this.ctx.policyDecision` is `undefined`, so a definition dispatched
   * directly via `runDefinition` would inherit no decision — and the augment
   * gate would default `confirmThreshold` to `'high'`, silently ignoring the
   * user's `skipPermissions` / `confirmMode` / `toolMode` settings. Callers
   * should spread the returned decision onto the ctx they hand to
   * `runDefinition` so out-of-turn tasks honor the same per-turn policy a
   * chat turn would.
   */
  resolvePolicyDecisionFor(userInput: string): PolicyDecision {
    return this.policyEngine.decide({
      userInput,
      config: this.config,
      previousUserInput: extractRecentUserTexts(this.history, 1)[0],
    }).decision;
  }

  /**
   * Zero the per-turn ↑/↓ + prompt-cache token odometers (#234, #269). Single
   * source of truth so the normal turn start, the semantic-cache-hit
   * short-circuit, and `clearHistory` never drift on which counters to reset.
   */
  private resetTurnTokenOdometer(): void {
    if (!this.spinnerStats) return;
    this.spinnerStats.turnPromptTokens = 0;
    this.spinnerStats.turnCompletionTokens = 0;
    this.spinnerStats.turnCacheReadTokens = 0;
    this.spinnerStats.turnCacheWriteTokens = 0;
    this.spinnerStats.turnLedger?.clear();
  }

  /**
   * Opens a new turn's stats window (#258). The REPL calls this at the true turn
   * boundary — before the pre-turn pipeline (reference-resolver, rewriter) runs —
   * so those LLM calls accumulate into the same per-turn ledger as the main loop.
   * Resets the odometer + ledger and marks the turn begun so the subsequent
   * `processInput` won't reset again and wipe the pre-turn entries.
   */
  beginTurnStats(): void {
    this.turnStatsBegun = true;
    this.resetTurnTokenOdometer();
    // Advance the durable session-telemetry turn counter so this turn's calls
    // are grouped under it. The per-turn odometer/ledger reset above does NOT
    // touch the cross-turn telemetry sink.
    this.spinnerStats?.sessionTelemetry?.beginTurn();
  }

  /**
   * Closes the just-ended turn's stats window (#258 follow-up). Prices the
   * still-populated per-turn ledger, folds the priced total into the
   * session-cumulative `sessionCostUsd` (which survives the next turn's reset),
   * and returns this turn's cost so the REPL can stamp it onto the transcript.
   * Returns `undefined` when there are no stats or no priced rows. Must run before
   * the next `beginTurnStats()` clears the ledger.
   */
  finalizeTurnStats(): number | undefined {
    if (!this.spinnerStats) return undefined;
    const report = computeTurnUsageReport(this.spinnerStats);
    this.spinnerStats.sessionCostUsd += report.totalCostUsd ?? 0;
    // Sticky: once any turn contained an unpriced row the session total is a
    // floor, not a total, and the StatusBar must say so rather than show $0.00.
    // One of two writers; rationale on `SpinnerStats.sessionCostPartial` (#311).
    if (report.partial) this.spinnerStats.sessionCostPartial = true;
    return report.totalCostUsd ?? undefined;
  }

  /** Returns step limit hit info from last processInput, or null if limit wasn't hit. */
  getStepLimitHit(): { currentLimit: number; hitCount: number } | null {
    if (!this.lastStepLimitHit) return null;
    return { currentLimit: this.config.maxSteps, hitCount: this.stepLimitHitCount };
  }

  /** Attaches a spinner stats object that will be updated with token usage during generation. */
  setSpinnerStats(stats: SpinnerStats): void {
    this.spinnerStats = stats;
    // Expose this Agent (a TokenStatsTarget) on the shared context so
    // `runDefinition` can route non-main dispatches' usage into the same
    // per-turn odometer (#234). Set here — the moment the Agent is fully wired
    // for interactive use — rather than at context-assembly time when
    // spinnerStats is still null.
    this.ctx.statsTarget = this;
  }

  /** Updates the alert context injected into the system prompt (e.g., specialist candidates). */
  setAlertContext(ctx: string): void {
    this.alertContext = ctx;
  }

  /**
   * Sends user input through the agent loop: RAG retrieval, context compression, LLM generation, and tool execution.
   *
   * Appends the user message and all response messages (including tool calls) to the conversation history.
   * Automatically retries with emergency truncation on token overflow errors.
   * @param userInput - The raw text from the user's REPL input
   * @throws Error wrapping the underlying API error if generation fails for non-abort, non-overflow reasons
   */
  async processInput(
    userInput: string,
    images?: ImageAttachment[],
    resolvedReferences?: ResolvedEntry[],
    options?: {
      ragResults?: RAGSearchResult[];
      /** Curator outputs; see `recall-filter.ts` and `orderForPacking` (#371). */
      recallReconciliation?: string;
      memoryPriority?: string[];
      originalInput?: string;
    },
  ): Promise<void> {
    const turnStartedAt = Date.now();
    let turnAborted = false;
    debugLog('turn:start', {
      inputLen: userInput.length,
      hasImages: !!(images && images.length > 0),
      refCount: resolvedReferences?.length ?? 0,
      historyLen: this.history.length,
    });
    this.lastStepLimitHit = false;
    // Cache per-turn snapshot inputs for the Agent Status overlay (#140).
    // Last-write-wins — the overlay is a snapshot, not a log.
    this.lastUserInput = userInput;
    this.lastResolvedReferences = resolvedReferences ?? [];
    this.ctx.verification.clear();
    // Reset per-turn rubric inputs (#145): post-write hooks, tool-attestation
    // tracker, and the cached snapshot. Both sinks are shared by reference
    // into sub-agent / tool-wrapper contexts via `runDefinition`, so clearing
    // here also clears for nested dispatches. `lastRubric` is reset here too
    // — if the turn throws before composition, callers should see `null`
    // rather than the previous turn's verdict.
    this.ctx.postWriteChecks.length = 0;
    this.ctx.verificationTracker.clear();
    this.lastRubric = null;

    // Resolve every cross-cutting heuristic for this turn in one place.
    // Sub-systems read the decision off `this.ctx.policyDecision` (e.g.
    // strategy selection in `mainAgentDefinition.strategy`) or off the
    // result returned here. Reasons go to `debugLog('policy:decide', ...)`.
    // History hasn't been mutated yet — the most recent user-text in history
    // IS the previous turn's input (undefined on first turn).
    const previousUserInput = extractRecentUserTexts(this.history, 1)[0];
    const policyResult = this.policyEngine.decide({
      userInput,
      config: this.config,
      previousUserInput,
    });
    this.lastPolicyResult = policyResult;
    this.ctx = { ...this.ctx, policyDecision: policyResult.decision };
    this.currentStrategy = isReactEffective(this.config, policyResult.decision)
      ? 'react'
      : 'normal';

    if (policyResult.decision.scratch?.resetPlanOnly) {
      this.planStore.clear();
    }
    if (policyResult.decision.scratch?.deletePlanKey) {
      this.memoryStore.deleteScratch('plan');
    }
    if (policyResult.decision.scratch?.resetAll) {
      this.memoryStore.clearScratch();
    }

    const profile = getModelProfile(
      this.config.provider,
      this.config.model,
      this.config.customProviders?.[this.config.provider]?.sdk,
    );
    // Wrap is outermost so `<user_request>` / `# Request` opens the text at position 0;
    // the timestamp prefix lives inside the wrapper.
    const wrappedInput = profile.wrapUserMessage(timestampUserMessage(userInput));

    if (images && images.length > 0) {
      const contentParts: UserContent = [
        { type: 'text', text: wrappedInput },
        ...images.map((img) => ({
          type: 'image' as const,
          image: img.data,
          mimeType: img.mimeType,
        })),
      ];
      this.history.push({ role: 'user', content: contentParts });
    } else {
      this.history.push({ role: 'user', content: wrappedInput });
    }

    // Snapshot the conversation turn position NOW, before the run — the
    // maxTokens-continuation and empty-answer-retry loops in `wrapIterate` push
    // synthetic `role:'user'` messages into history, so counting after the run
    // would inflate the index for turns that hit those paths (#211 viewers).
    const userTurnIndex = Math.max(0, this.history.filter((m) => m.role === 'user').length - 1);

    this.abortController = new AbortController();
    this.lastStepPromptTokens = 0;
    this.lastRAGResults = [];
    this.lastSources = [];
    this.lastCitedSources = [];
    // Fresh per-turn provenance — sources from prior turns don't leak across.
    this.ctx.provenance.clear();

    // Semantic response cache (#269, Layer 3). Opt-in; read-only Q&A turns only
    // (no images, no tool actions). On a near-identical hit, answer from the
    // cache and skip the model call entirely. The pushed assistant message is
    // committed to the transcript by App's post-turn history commit, so no
    // streaming-sink work is needed. Fails open.
    // Eligible only when the turn is self-contained: opt-in flag on, no images,
    // a pure question, AND no resolved references (a reference-dependent ask like
    // "summarize §3" keys only on the raw text, so a same-worded ask resolving to
    // different content would collide). The store-on-miss path below reuses the
    // same gate.
    const semanticEligible =
      this.config.semanticCache &&
      !images?.length &&
      !resolvedReferences?.length &&
      isPureQuestion(userInput);
    if (semanticEligible) {
      const hit = await this.semanticCache.get(userInput);
      if (hit !== null && !this.abortController.signal.aborted) {
        // The hit short-circuits before the normal per-turn reset below, so zero
        // the odometers here — otherwise the spinner shows the prior turn's
        // token/⚡cached counts for a turn that made no model call. Skip the reset
        // when the REPL opened the turn via `beginTurnStats()`: the ledger then
        // already holds *this* turn's pre-turn pipeline spend (resolver/rewriter),
        // which a reset would silently drop from the cost label + session total.
        if (!this.turnStatsBegun) this.resetTurnTokenOdometer();
        this.history.push({ role: 'assistant', content: hit });
        return;
      }
    }

    try {
      // Resolve the model we're actually talking to for this turn (lineup +
      // model-mode aware), not the stale `config.model` base field (#233).
      // Refresh the spinner/status-gauge denominator here so mid-session
      // `/model` / `/lineups` / `/profiles` switches take effect next turn —
      // the App.tsx mount-seed only fires once.
      const mainModel = resolveMainModel(this.config);
      if (this.spinnerStats) {
        this.spinnerStats.model = mainModel;
        this.spinnerStats.contextWindowOverride = this.config.tokenWindow || undefined;
        // Reset the per-turn ↑/↓ odometer + ledger at the start of every turn
        // (#234). This single reset point is what makes the readout per-turn:
        // this turn's main-agent steps AND any sub-agents / tool-wrappers / PAC
        // phases it spawns then accumulate into a fresh zero via the token hooks
        // (main: tokenStatsHook; non-main: tokenTotalsHook).
        //
        // SKIP when the REPL already opened the turn via `beginTurnStats()`
        // (#258): the pre-turn pipeline ran since that reset and recorded into
        // the ledger, so resetting again here would wipe those entries.
        if (!this.turnStatsBegun) this.resetTurnTokenOdometer();
      }

      // Check if context compression is needed
      const imageTokens = images ? images.length * IMAGE_TOKEN_ESTIMATE : 0;
      const newMessageEstimate = Math.ceil(wrappedInput.length / 4) + imageTokens;
      if (
        shouldCompress(
          this.lastPromptTokens,
          newMessageEstimate,
          mainModel,
          this.config.tokenWindow,
        )
      ) {
        const beforeCompress = this.history;
        this.history = await compressHistory(
          this.history,
          this.config,
          this.ragStore,
          // Count compression's off-loop LLM calls toward the per-turn ledger (#258).
          this.spinnerStats ? (rec) => recordTurnUsage(this.spinnerStats!, rec) : undefined,
          // Announce only once compaction commits to the work. `shouldCompress`
          // stays true after a run the reclaim floor skipped (nothing changed,
          // so nothing re-baselines), so printing before the call would show
          // this every turn for a compaction that never happens.
          () => printInfo('Compressing conversation context...'),
        );
        // Re-baseline the compression trigger (#310). `lastPromptTokens` is the
        // real prompt size of the LAST call, so after a successful compaction it
        // describes a history that no longer exists — and `shouldCompress` would
        // keep firing off the stale number, paying for a compaction per turn
        // that reclaims progressively less. `compactHistory` (the manual
        // `/compact` path) has always done this; the automatic path did not.
        if (this.history !== beforeCompress) {
          this.lastPromptTokens = estimateHistoryTokens(this.history);
        }
      }

      // Recalled memory for this turn. `rawResults` comes from one of two
      // sources: a pre-filtered set injected by the recall-filter pre-turn pass
      // (`options.ragResults`), or — the legacy path — this agent's own
      // sliding-window `ragStore.search()`. Either way stickiness, provenance
      // registration, and `previousRAGFacts` tracking are applied identically,
      // so citations and turn-over-turn stickiness behave the same.
      let ragResults: RAGSearchResult[] | undefined;
      try {
        let rawResults: RAGSearchResult[] | undefined;
        if (options?.ragResults !== undefined) {
          // Injected by the recall-filter pass. An empty array is meaningful —
          // the filter's LLM ran and kept nothing — so it must suppress the
          // agent's own search, not fall through to it (a truthy check would
          // treat `[]` as "no injection" and re-inject the rejected facts).
          rawResults = options.ragResults;
          debugLog('agent:rag', { source: 'recall-filter', results: rawResults.length });
        } else if (this.ragStore) {
          // Build context-enriched query from recent user messages and tool calls
          const recentTexts = extractRecentUserTexts(this.history.slice(0, -1), 2);
          const toolContext = extractRecentToolContext(this.history.slice(0, -1));
          const ragQuery = buildRAGQuery(userInput, recentTexts, {
            toolContext: toolContext || undefined,
          });

          // Search with enriched query
          rawResults = await this.ragStore.search(ragQuery);

          if (rawResults.length > 0) {
            const logQuery = ragQuery.replace(/^\[tools: [^\]]*]\. ?/, '').slice(0, 100);
            debugLog('agent:rag', { query: logQuery, results: rawResults.length });
          }
        }

        if (rawResults !== undefined) {
          // Apply stickiness from previous turn. On the injected recall-filter
          // path the LLM already selected the relevant subset (from a set the
          // filter widened to top-8/domain), so suppress stickiness's default
          // top-5/domain + max-15 caps — otherwise, once sticky facts exist,
          // they'd silently re-narrow the curated set and drop facts the filter
          // kept (and left recordAccess's TTL bumps tracking). Boost + re-sort
          // still apply; only the hard cap is lifted.
          ragResults =
            options?.ragResults !== undefined
              ? applyStickiness(rawResults, this.previousRAGFacts, {
                  topKPerDomain: Infinity,
                  maxResults: Infinity,
                })
              : applyStickiness(rawResults, this.previousRAGFacts);
          this.lastRAGResults = ragResults;

          // Register each RAG hit as a citeable source. The id is exposed
          // to the model via the `<available_sources>` block built by
          // `buildContextMessage` so it can attach `[^Sn]` markers when
          // referencing recalled context.
          for (const r of ragResults) {
            this.ctx.provenance.add({
              kind: 'rag',
              label: r.fact.slice(0, 80),
              contentPreview: r.fact,
              rawRef: `rag:${r.domain}:${r.fact.slice(0, 60)}`,
            });
          }

          // Track for next turn
          this.previousRAGFacts = new Set(ragResults.map((r) => r.fact));
        }
      } catch (err) {
        debugLog('agent:rag:error', err instanceof Error ? err.message : String(err));
      }

      const routineSummaries = this.routineStore.getSummaries();
      const specialistSummaries = this.specialistStore.getSummaries();
      const specialistMatches = matchSpecialists(userInput, specialistSummaries);

      const inputBase = {
        userInput,
        ragResults,
        recallReconciliation: options?.recallReconciliation,
        memoryPriority: options?.memoryPriority,
        resolvedReferences,
        routineSummaries,
        specialistSummaries,
        specialistMatches,
        alertContext: this.alertContext,
        statsTarget: this,
        planStore: this.planStore,
      };
      // Pre-render the system prompt once so a single `getModelProfile` call
      // shapes both the preflight estimate and the runDefinition call.
      const systemForEstimate = buildMainSystemPrompt(this.ctx, inputBase, profile);
      const input: MainInput = { ...inputBase, systemPrompt: systemForEstimate };
      const HARD_LIMIT_RATIO = 0.9;
      const contextWindow = getContextWindow(mainModel, this.config.tokenWindow);
      // The per-turn `<system_provided_context>` message is no longer in the
      // SYSTEM prompt (issue #172) — account for it separately in the
      // preflight estimate so token budgeting stays accurate.
      const contextMsgsForEstimate = buildMainContextMessages(this.ctx, inputBase);
      const contextMsgChars = contextMsgsForEstimate.reduce(
        (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
        0,
      );
      // Coordinator prompt is appended by `ReActStrategy.run` whenever the
      // turn ends up React-effective — that's both `coordinatorMode === 'on'`
      // and `'auto'` turns the Qualifier escalated. Mirror the same gate here
      // so the preflight budget stays accurate.
      const reactActiveForEstimate = isReactEffective(this.config, policyResult.decision);
      // Everything sent alongside the history: SYSTEM prompt, the per-turn
      // context message (moved out of SYSTEM by #172), the coordinator prompt
      // when React is effective, and the tool block (~5.3k tokens on the main
      // agent, omitted from this estimate entirely before #323). One number,
      // used by both the "are we over?" test and the truncation that follows,
      // so they cannot disagree about the budget.
      const prefixChars =
        systemForEstimate.length +
        contextMsgChars +
        (reactActiveForEstimate ? REACT_COORDINATOR_PROMPT.length + 2 : 0) +
        (this.mainToolBytes ?? 0);
      const estimatedTokens =
        estimateHistoryTokens(this.history) + estimatePrefixTokens(prefixChars);
      const hardLimit = contextWindow * HARD_LIMIT_RATIO;
      let preflightTruncated = false;
      if (estimatedTokens > hardLimit) {
        printInfo('Context approaching limit, emergency truncating...');
        this.history = emergencyTruncate(this.history, hardLimit, prefixChars, userInput);
        preflightTruncated = true;
      }

      // wrapIterate adds the main-only concerns on top of the framework's
      // inner iterate: push strategy-supplied extras into persistent history,
      // recover from token-overflow API errors via emergency-truncate, and
      // auto-continue when the model truncates due to `maxTokens`.
      const wrapIterate =
        (inner: IterateFn): IterateFn =>
        async (iterOpts) => {
          if (iterOpts.extra.length > 0) {
            this.history.push(...iterOpts.extra);
          }
          // Already-pushed extras are visible via the seedMessages getter; pass
          // `extra: []` so the inner iterate doesn't double-append.
          const innerOpts = { ...iterOpts, extra: [] as CoreMessage[] };

          let result;
          try {
            result = await inner(innerOpts);
          } catch (apiErr: unknown) {
            if (this.abortController?.signal.aborted) throw apiErr;
            const apiMessage = apiErr instanceof Error ? apiErr.message : String(apiErr);
            if (isTokenOverflowError(apiMessage)) {
              const retryRatio = preflightTruncated ? 0.6 : 0.8;
              printInfo('Context too large, truncating and retrying...');
              // Build the effective base system prompt the same way the inner
              // iterate would: `systemForEstimate` + optional strategy suffix.
              const baseSystemChars =
                systemForEstimate.length +
                (iterOpts.systemSuffix ? iterOpts.systemSuffix.length + 2 : 0);
              // Recompute context-message size from the live stores instead of
              // reusing the preflight value. A tool may have written a memory
              // or scratch entry between preflight and this retry; reusing
              // `contextMsgChars` would under-count and leave the retry payload
              // over the wire limit.
              const retryContextMsgs = buildMainContextMessages(this.ctx, inputBase);
              const retryPrefixChars =
                baseSystemChars +
                retryContextMsgs.reduce(
                  (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
                  0,
                ) +
                (this.mainToolBytes ?? 0);
              this.history = emergencyTruncate(
                this.history,
                contextWindow * retryRatio,
                retryPrefixChars,
                userInput,
              );
              result = await inner(innerOpts);
            } else {
              throw apiErr;
            }
          }

          const MAX_CONTINUATIONS = 3;
          let continuations = 0;
          let continuationTokens = 0;
          const maxStepsForCall = iterOpts.maxStepsOverride ?? this.config.maxSteps;

          while (result.finishReason === 'length' && continuations < MAX_CONTINUATIONS) {
            if (this.abortController?.signal.aborted) break;
            continuationTokens += result.usage?.completionTokens ?? 0;
            continuations++;

            printWarning(
              `Response truncated (hit ${this.config.maxTokens} token limit). Auto-continuing... (${continuations}/${MAX_CONTINUATIONS})`,
            );

            const partialMessages = truncateToolResults(result.response.messages as CoreMessage[]);
            this.history.push(...partialMessages);
            this.history.push({
              role: 'user' as const,
              content: `${CONTINUATION_PREFIX}. Please continue exactly where you left off.]`,
            });

            if (this.spinnerStats) {
              startSpinner(() => buildSpinnerMessage(this.spinnerStats!));
            }

            result = await inner(innerOpts);
          }

          if (continuations > 0) {
            const totalCompletionTokens =
              continuationTokens + (result.usage?.completionTokens ?? 0);
            const recommended = Math.ceil((totalCompletionTokens * 1.25) / 1024) * 1024;

            if (result.finishReason === 'length') {
              printWarning(
                `Response still incomplete after ${MAX_CONTINUATIONS} continuations. ` +
                  `Increase the token limit: /options max-tokens ${recommended}`,
              );
            } else {
              printInfo(
                `Tip: Response needed ~${totalCompletionTokens} tokens (limit: ${this.config.maxTokens}). ` +
                  `To avoid future truncation: /options max-tokens ${recommended}`,
              );
            }
          }

          // Reasoning-model safety net: some reasoning models end a turn having
          // emitted only *reasoning* content and an EMPTY answer — finishReason
          // 'stop', completion tokens spent, but `result.text` is blank. The
          // user sees the thinking trail cut off mid-sentence ("...the dates
          // are:") with no actual answer. The `length` loop above doesn't catch
          // this (finishReason isn't 'length'), so without a guard the blank
          // turn is accepted as "complete." Nudge the model to write its answer
          // as plain text. Bounded and abort-aware like the length path.
          const MAX_EMPTY_ANSWER_RETRIES = 2;
          let emptyAnswerRetries = 0;
          // Trigger only on the "reasoning dump" signature: the model produced
          // reasoning but routed its whole answer there, leaving `text` blank.
          // An empty-text 'stop' with NO reasoning is a legitimately silent turn
          // (e.g. a model that has nothing more to say) and must NOT loop.
          const hasReasoning = (reasoning: unknown): boolean => {
            if (typeof reasoning === 'string') return reasoning.trim().length > 0;
            if (Array.isArray(reasoning)) return reasoning.length > 0;
            return false;
          };
          while (
            emptyAnswerRetries < MAX_EMPTY_ANSWER_RETRIES &&
            result.finishReason === 'stop' &&
            (result.text ?? '').trim() === '' &&
            (result.usage?.completionTokens ?? 0) > 0 &&
            hasReasoning((result as { reasoning?: unknown }).reasoning)
          ) {
            if (this.abortController?.signal.aborted) break;
            emptyAnswerRetries++;
            debugLog('agent:empty-answer-continue', {
              attempt: emptyAnswerRetries,
              completionTokens: result.usage?.completionTokens ?? 0,
            });

            const partialMessages = truncateToolResults(result.response.messages as CoreMessage[]);
            this.history.push(...partialMessages);
            this.history.push({
              role: 'user' as const,
              content:
                '[You produced reasoning but no visible answer. Write your final answer to me now, as plain text.]',
            });

            if (this.spinnerStats) {
              startSpinner(() => buildSpinnerMessage(this.spinnerStats!));
            }

            result = await inner(innerOpts);
          }

          // Step-limit continuation. When the model still wants to call tools
          // but has spent the whole per-turn step budget, don't silently yield
          // mid-task (the old path only logged an invisible `printWarning`). In
          // the interactive REPL, surface a visible prompt offering to continue
          // with a doubled budget — and let the user persist the larger budget
          // for the session or their profile, mirroring the "allow once /
          // session / always" permission ladder. Bounded by
          // STEP_LIMIT_MAX_EXPANSIONS and REACT_MAX_STEPS_CEILING. Headless runs
          // (cron: no `askUser`) skip the loop and fall through to the warn+yield
          // below unchanged.
          const askUserForSteps = this.ctx.toolOptions?.askUser;
          let stepBudget = maxStepsForCall;
          let stepExpansions = 0;
          while (
            askUserForSteps &&
            result.finishReason === 'tool-calls' &&
            result.steps.length >= stepBudget &&
            stepBudget < REACT_MAX_STEPS_CEILING &&
            stepExpansions < STEP_LIMIT_MAX_EXPANSIONS &&
            !this.abortController?.signal.aborted
          ) {
            const nextBudget = Math.min(stepBudget * 2, REACT_MAX_STEPS_CEILING);
            const CONTINUE_ONCE = `Continue — ${nextBudget} steps for this turn`;
            const CONTINUE_SESSION = `Continue — use ${nextBudget} steps for the rest of this session`;
            const CONTINUE_SAVE = `Continue — save ${nextBudget} as my default step budget`;
            const STOP = `Stop here — I'll pick it up later`;

            let answer: AskUserBatchResult;
            try {
              answer = await askUserForSteps(
                [
                  {
                    question: `I've used all ${stepBudget} steps for this turn and there's still work to do. How should I proceed?`,
                    choices: [CONTINUE_ONCE, CONTINUE_SESSION, CONTINUE_SAVE, STOP],
                    allowOther: false,
                  },
                ],
                this.abortController?.signal,
              );
            } catch {
              break; // prompt channel failed — fall through to warn+yield.
            }
            if (!('answers' in answer)) break; // cancelled (Esc) → treat as stop.
            const raw = answer.answers[0];
            const picked = Array.isArray(raw) ? raw[0] : raw;
            if (!picked || picked === STOP) break;

            // Classify the once/session/profile scope once, then drive every
            // side effect (live bump, disk persist, telemetry) off it.
            const scope =
              picked === CONTINUE_SAVE
                ? 'profile'
                : picked === CONTINUE_SESSION
                  ? 'session'
                  : 'once';
            if (scope !== 'once') {
              this.config.maxSteps = nextBudget; // live session bump (shared config ref).
            }
            if (scope === 'profile') {
              try {
                saveActiveSettings({ maxSteps: nextBudget });
              } catch {
                /* best-effort persist — the session bump above still applies. */
              }
            }
            debugLog('agent:step-limit-continue', {
              from: stepBudget,
              to: nextBudget,
              scope,
              expansion: stepExpansions + 1,
            });

            const partial = truncateToolResults(result.response.messages as CoreMessage[]);
            this.history.push(...partial);
            stepBudget = nextBudget;
            stepExpansions++;
            if (this.spinnerStats) {
              startSpinner(() => buildSpinnerMessage(this.spinnerStats!));
            }
            result = await inner({ ...innerOpts, maxStepsOverride: nextBudget });
          }

          if (result.finishReason === 'tool-calls' && result.steps.length >= stepBudget) {
            this.lastStepLimitHit = true;
            this.stepLimitHitCount++;
            const msg =
              this.stepLimitHitCount >= 2
                ? `Stopped at loop limit of ${stepBudget}. Use /options max-steps to adjust permanently.`
                : `Stopped at loop limit of ${stepBudget}.`;
            printWarning(msg);
          } else {
            this.lastStepLimitHit = false;
          }

          return result;
        };

      const runOut = await runDefinition(this.ctx, mainAgentDefinition, input, {
        abortSignal: this.abortController!.signal,
        seedMessages: () => this.history,
        planStore: this.planStore,
        wrapIterate,
        partialObserver: {
          onIterateStart: () => {
            this.partialStepMessages = [];
            this.partialText = '';
          },
          onStepMessages: (msgs) => {
            // Cumulative snapshot — replace, don't append. A finished step's
            // text is already inside its messages, so deltas accumulated past
            // this point belong to the NEXT in-flight step.
            this.partialStepMessages = msgs;
            this.partialText = '';
          },
          onTextDelta: (delta) => {
            this.partialText += delta;
          },
        },
      });
      const result = runOut.result;
      // Session-stable, so pay the measurement on the first dispatch only.
      this.mainToolBytes ??= runOut.toolBytes();

      // Track token usage for compression decisions — use last step's prompt tokens
      // (result.usage.promptTokens is the aggregate across ALL steps, not the last step)
      // `lastStepPromptTokens` is a plain number reset to 0 each turn, so `??`
      // never reaches the fallback — use a truthiness check so a dispatch whose
      // steps reported no usage still falls through to the aggregate.
      this.lastPromptTokens = this.lastStepPromptTokens || (result.usage?.promptTokens ?? 0);

      // Populate the semantic response cache (#269, Layer 3) — only for read-only
      // Q&A turns that took NO tool actions, so a future near-duplicate ask can
      // be answered without a model call. Gated identically to the lookup above.
      const usedTools = (result.steps ?? []).some((s) => (s.toolCalls?.length ?? 0) > 0);
      if (semanticEligible && !usedTools && result.text?.trim()) {
        void this.semanticCache.put(userInput, result.text);
      }

      // Snapshot provenance for the REPL viewer. `lastSources` is everything
      // registered this turn; `lastCitedSources` is the subset whose ids
      // appeared as `[^Sn]` markers anywhere in the turn's emitted text.
      // `result.text` is only the *final* step's prose; if the model emits
      // markers in an earlier step and ends with a tool call, they would be
      // missed. Scan every step plus the final text. Issues #173, #211.
      this.lastSources = this.ctx.provenance.list();
      const stepTexts = (result.steps ?? [])
        .map((s) => (typeof s.text === 'string' ? s.text : ''))
        .join('\n');
      const citedScanText = stepTexts + '\n' + (result.text ?? '');
      const citedIds = extractCitationMarkers(citedScanText, this.ctx.provenance);
      this.lastCitedSources = citedIds
        .map((id) => this.ctx.provenance.get(id))
        .filter((s): s is SourceItem => s !== undefined);
      if (citedIds.length === 0 && this.lastSources.length > 0) {
        debugLog('agent:citations', {
          available: this.lastSources.length,
          cited: 0,
        });
      }

      // Append a per-turn snapshot for the Shift+Tab full-screen viewer
      // (#211). Only record turns that actually had something to cite —
      // empty turns would clutter the history view. `turnIndex` is the
      // *conversation* turn position (0-based count of user messages in
      // history), not the index within `turnProvenance` — otherwise turns
      // that registered no sources would compress the indices and the
      // viewer would show "Turn 2" for what the user typed as their 5th
      // message. `userTurnIndex` was snapshotted before the run so synthetic
      // continuation messages don't inflate it.
      if (this.lastSources.length > 0) {
        this.turnProvenance.push({
          turnIndex: userTurnIndex,
          userInput: userInput,
          // `verifyText` is dropped: this snapshot is persisted to
          // `provenance-history.json` and reloaded on resume, and the field can
          // be 20k per source. Verification runs in the turn that retrieved the
          // text, so nothing downstream of the snapshot needs it.
          sources: this.lastSources.map(({ verifyText: _verifyText, ...s }) => s),
          citedIds: [...citedIds],
          timestamp: Date.now(),
        });
      }

      // Parallel snapshot for the Shift+Tab "Prompt & Context" viewer: the
      // prompt-assembly trail (original vs. rewritten input, resolved refs,
      // recalled facts). Recorded for every completed turn. Intentionally does
      // NOT capture the system prompt — that's internal infra, not for disk/UI.
      this.turnContext.push({
        turnIndex: userTurnIndex,
        timestamp: Date.now(),
        originalInput: options?.originalInput ?? userInput,
        rewrittenInput: userInput,
        resolvedReferences: this.lastResolvedReferences.map((e) => ({ ...e })),
        recalledFacts: this.lastRAGResults.map((f) => ({ ...f })),
        // Read at snapshot rather than threaded out of `buildContextMessage`:
        // under budget injection is unconditional, so the store's key list IS
        // what went in. Over budget it is NOT — `renderPersistentMemory` drops
        // the tail, and this would then report a memory as injected on exactly
        // the turn it was dropped, which is the only turn anyone looks. So
        // apply the same ordering the renderer used and record the ranked keys
        // first; the viewer's list then leads with what actually survived.
        // (A write during the turn can still drift by one entry — acceptable
        // for a display record. Making this exact needs the renderer to report
        // what it kept; see #371 follow-ups.)
        injectedMemoryKeys: orderMemoryKeysForDisplay(
          this.memoryStore.listMemory(),
          options?.memoryPriority,
        ),
      });

      // Per-turn qualifier outcome (#167). One structured line that pairs the
      // strategy the policy picked, the reason code, the realized step count,
      // and whether enforcement / step-limit fired. Use this to retrofit a
      // learned router later — every field is the data such training needs.
      debugLog('qualifier:outcome', {
        strategyId: policyResult.decision.strategyId ?? 'normal',
        reason: policyResult.reasons.strategy ?? '',
        steps: result.steps?.length ?? 0,
        hitStepLimit: this.lastStepLimitHit,
        coordinatorMode: this.config.coordinatorMode,
      });

      // Per-turn token + cost ledger (#258). The full per-tier/model breakdown
      // (including pre-turn pipeline + compressor) for session-JSONL analysis,
      // paired with the strategy line above. Guarded on spinnerStats (headless)
      // and on the debug gate so the report isn't computed then thrown away when
      // BERNARD_DEBUG is off (the common case).
      if (isDebugEnabled() && this.spinnerStats) {
        // Provider request accounting (#308). Attempts are counted at the fetch
        // wrapper, records at `onStepFinish` — so a persistent excess is spend
        // that per-call accounting cannot see (SDK retries, or calls that failed
        // before producing a usage payload).
        debugLog('provider:requests', {
          attempts: getProviderRequestCount(),
          records: this.spinnerStats.sessionTelemetry?.calls ?? 0,
        });
        const report = computeTurnUsageReport(this.spinnerStats);
        debugLog('turn-stats', {
          rows: report.rows,
          totalPromptTokens: report.totalPromptTokens,
          totalCompletionTokens: report.totalCompletionTokens,
          totalCacheReadTokens: report.totalCacheReadTokens,
          totalCalls: report.totalCalls,
          totalCostUsd: report.totalCostUsd,
          partial: report.partial,
        });
      }

      // Compose per-turn rubric (#145). Combines:
      //   - PlanStore.evaluateRubric (steps-terminal, signoffs, error-step count)
      //   - Post-write hook results recorded by augmentTools
      //   - Attestation: did the model run something matching each step's
      //     declared `verification` text?
      //   - The most recent `evaluate` tool's structured checks, if any
      // Worst-of aggregation: any fail → fail, any warn → warn, else pass.
      const planRubric = this.planStore.evaluateRubric();
      const attestationChecks = this.ctx.verificationTracker.attestAll(this.planStore.view());
      const evalChecks = this.ctx.verification.getLast()?.checks ?? [];
      const allChecks: Check[] = [
        ...planRubric.checks,
        ...this.ctx.postWriteChecks,
        ...attestationChecks,
        ...evalChecks,
      ];
      const turnVerdict = verdictOf(allChecks);
      this.lastRubric = { verdict: turnVerdict, checks: allChecks };
      debugLog('rubric:turn', {
        verdict: turnVerdict,
        checks: allChecks.length,
        summary: renderRubricLine(this.lastRubric),
      });

      // Truncate large tool results before adding to history
      const truncatedMessages = truncateToolResults(result.response.messages as CoreMessage[]);
      this.history.push(...truncatedMessages);
    } catch (err: unknown) {
      // If aborted by user, preserve whatever the turn produced before the
      // interrupt — completed steps (tool calls + results, already API-valid
      // because a step only finishes after its tools execute) plus the
      // streamed text of the step in flight — so "please continue" resumes
      // from the interruption point instead of restarting the turn.
      if (this.abortController?.signal.aborted) {
        turnAborted = true;
        const partial = truncateToolResults(this.partialStepMessages);
        const text = this.partialText.trim();
        // The marker lands unconditionally (#403). It used to be gated on
        // `partial.length > 0`, so an Esc that arrived before the first step
        // completed left the model's history holding a user message with no
        // reply at all — the same turn reads on a later resume as one the model
        // simply never answered, and "please continue" has nothing to continue
        // from. `processInput` pushes the user message synchronously before its
        // first await, so history here always ends with that message (or with
        // this turn's tool results), and an assistant message after either is
        // API-valid.
        if (text) {
          partial.push({ role: 'assistant', content: `${text}\n\n[interrupted by user]` });
        } else {
          partial.push({ role: 'assistant', content: '[interrupted by user]' });
        }
        this.history.push(...partial);
        // The clean-exit path below assigns `lastPromptTokens`, and this branch
        // returns before it. Without this, Esc-ing out of large turns grows the
        // history while the compression trigger stays frozen at the last
        // cleanly-finished turn's prompt size — so compaction never fires even
        // as the context keeps climbing. Completed steps already reported their
        // usage through the token-stats hook, so `lastStepPromptTokens` is the
        // right value; leave it alone when no step finished before the abort.
        if (this.lastStepPromptTokens > 0) {
          this.lastPromptTokens = this.lastStepPromptTokens;
        }
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      debugLog('error:turn', {
        message,
        stack: err instanceof Error ? err.stack : undefined,
        durationMs: Date.now() - turnStartedAt,
      });
      throw new Error(`Agent error: ${message}`, { cause: err });
    } finally {
      this.abortController = null;
      this.currentStrategy = null;
      // Close this turn's stats window (#258) so the next turn that doesn't go
      // through `beginTurnStats()` (cron / direct callers) resets normally.
      this.turnStatsBegun = false;
      // Drop any unflushed partials so a stale snapshot can never leak into a
      // later turn's abort flush.
      this.partialStepMessages = [];
      this.partialText = '';
      debugLog('turn:end', {
        durationMs: Date.now() - turnStartedAt,
        aborted: turnAborted,
      });
    }
  }

  /** Compresses conversation history in-place, returning token usage stats. */
  async compactHistory(): Promise<CompactResult> {
    const tokensBefore = estimateHistoryTokens(this.history);
    // Manual /compact runs between turns, so its summarizer + domain-extraction
    // LLM spend can't ride a turn's ledger (the next `beginTurnStats()` would
    // clear it). Price it here and fold it straight into the session total so the
    // footer's "session ~$" doesn't silently undercount (#258), AND record it into
    // the durable session-telemetry sink directly (bypassing the turn ledger) so
    // it also shows up in the per-layer `bernard usage` breakdown under
    // `compressor` — otherwise the breakdown would under-attribute vs. the total.
    let compactionCostUsd = 0;
    const stats = this.spinnerStats;
    const compressed = await compressHistory(
      this.history,
      this.config,
      this.ragStore,
      stats
        ? (rec) => {
            // Mint the record once (the single pricing path): read its cost for
            // the between-turn session-total tally, and record it into the sink
            // for the per-layer breakdown. Works with no sink attached too
            // (still tallies the scalar cost; just doesn't record).
            const sink = stats.sessionTelemetry;
            const tel = telemetryFromUsageRecord(sink?.sessionId ?? '', sink?.turn ?? 0, rec);
            if (tel.costUsd != null) compactionCostUsd += tel.costUsd;
            // Unpriced compaction spend still counts against the session total's
            // completeness — otherwise it silently vanishes into a clean $0.00.
            // Second of two writers; rationale on `SpinnerStats.sessionCostPartial`.
            else stats.sessionCostPartial = true;
            sink?.record(tel);
          }
        : undefined,
    );
    if (stats) stats.sessionCostUsd += compactionCostUsd;
    const compacted = compressed !== this.history;
    if (compacted) {
      this.history = compressed;
      this.lastPromptTokens = estimateHistoryTokens(this.history);
    }
    const tokensAfter = estimateHistoryTokens(this.history);
    // Drop the status-bar gauge to the new (smaller) context size immediately
    // rather than waiting for the next turn to re-measure it (#234). The
    // compression input `lastPromptTokens` is already updated above; this is the
    // gauge's separate per-step field. The per-turn ↑/↓ odometer is left alone —
    // compaction happens between turns and the next turn resets it.
    if (compacted && this.spinnerStats) {
      this.spinnerStats.latestPromptTokens = tokensAfter;
    }
    return { compacted, tokensBefore, tokensAfter };
  }

  /** Resets conversation history, scratch notes, and RAG tracking state for a fresh session. */
  clearHistory(): void {
    this.history = [];
    this.memoryStore.clearScratch();
    this.previousRAGFacts = new Set();
    this.lastRAGResults = [];
    this.stepLimitHitCount = 0;
    this.lastStepLimitHit = false;
    this.planStore.clear();
    this.lastPolicyResult = undefined;
    // Drop per-turn snapshots so the Shift+Tab viewer doesn't show prior-
    // session goal / assumptions / sources / verification after a reset.
    this.lastUserInput = null;
    this.lastResolvedReferences = [];
    this.lastSources = [];
    this.lastCitedSources = [];
    this.turnProvenance = [];
    this.turnContext = [];
    this.ctx.verification.clear();
    this.ctx.provenance.clear();
    this.ctx.postWriteChecks.length = 0;
    this.ctx.verificationTracker.clear();
    this.lastRubric = null;
    // Reset token accounting so the status bar reflects the now-empty
    // conversation the moment /clear finishes, instead of lingering on the old
    // fullness until the next turn runs (#234). `lastPromptTokens` and
    // `lastStepPromptTokens` both feed compression headroom (the latter is the
    // per-step prompt size the next compaction reads); zeroing them avoids a
    // spurious compaction on the first post-clear turn. The gauge's own source,
    // `spinnerStats.latestPromptTokens`, is emptied separately below.
    this.lastPromptTokens = 0;
    this.lastStepPromptTokens = 0;
    if (this.spinnerStats) {
      this.spinnerStats.latestPromptTokens = 0; // empty the bar
      this.resetTurnTokenOdometer();
      // `sessionCostUsd` is deliberately NOT zeroed here: the footer's "session"
      // total is REPL-process-lifetime spend (#258), independent of /clear, which
      // only drops the conversation context.
    }
    if (this.ctx.policyDecision) {
      this.ctx = { ...this.ctx, policyDecision: undefined };
    }
  }
}
