import { type CoreMessage, type UserContent } from 'ai';
import { getModelProfile } from './providers/index.js';
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
import { debugLog } from './logger.js';
import {
  shouldCompress,
  compressHistory,
  truncateToolResults,
  estimateHistoryTokens,
  emergencyTruncate,
  isTokenOverflowError,
  getContextWindow,
} from './context.js';
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
import { DefaultPolicyEngine, isReactEffective } from './policy/index.js';
import type { PolicyEngine, PolicyResult } from './policy/index.js';
import { extractCitationMarkers, type SourceItem, type TurnProvenance } from './provenance.js';
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
import { REACT_COORDINATOR_PROMPT } from './react.js';
export {
  REACT_COORDINATOR_PROMPT,
  shouldEnforcePlan,
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
  /** Most recent per-turn rubric (#145). Composed at end of `processInput`. */
  private lastRubric: Rubric | null = null;
  private abortController: AbortController | null = null;
  private lastPromptTokens: number = 0;
  // Public so tokenStatsHook (an external module) can mutate these in place
  // after each agent step. See src/framework/hooks/token-stats.ts.
  lastStepPromptTokens: number = 0;
  spinnerStats: SpinnerStats | null = null;
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
   * Returns the live `AgentContext` (with the most recent `policyDecision`
   * threaded in by `processInput`). The Agent class re-points `this.ctx`
   * on every turn, so callers that need to invoke a definition outside the
   * normal turn loop (e.g. the correction agent at REPL shutdown) should
   * read this fresh rather than caching the value handed back at startup.
   */
  getContext(): AgentContext {
    return this.ctx;
  }

  /** Returns step limit hit info from last processInput, or null if limit wasn't hit. */
  getStepLimitHit(): { currentLimit: number; hitCount: number } | null {
    if (!this.lastStepLimitHit) return null;
    return { currentLimit: this.config.maxSteps, hitCount: this.stepLimitHitCount };
  }

  /** Attaches a spinner stats object that will be updated with token usage during generation. */
  setSpinnerStats(stats: SpinnerStats): void {
    this.spinnerStats = stats;
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
  ): Promise<void> {
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

    this.abortController = new AbortController();
    this.lastStepPromptTokens = 0;
    this.lastRAGResults = [];
    this.lastSources = [];
    this.lastCitedSources = [];
    // Fresh per-turn provenance — sources from prior turns don't leak across.
    this.ctx.provenance.clear();

    try {
      // Check if context compression is needed
      const imageTokens = images ? images.length * IMAGE_TOKEN_ESTIMATE : 0;
      const newMessageEstimate = Math.ceil(wrappedInput.length / 4) + imageTokens;
      if (
        shouldCompress(
          this.lastPromptTokens,
          newMessageEstimate,
          this.config.model,
          this.config.tokenWindow,
        )
      ) {
        printInfo('Compressing conversation context...');
        this.history = await compressHistory(this.history, this.config, this.ragStore);
      }

      // RAG search for relevant memories with sliding-window query
      let ragResults: RAGSearchResult[] | undefined;
      if (this.ragStore) {
        try {
          // Build context-enriched query from recent user messages and tool calls
          const recentTexts = extractRecentUserTexts(this.history.slice(0, -1), 2);
          const toolContext = extractRecentToolContext(this.history.slice(0, -1));
          const ragQuery = buildRAGQuery(userInput, recentTexts, {
            toolContext: toolContext || undefined,
          });

          // Search with enriched query
          const rawResults = await this.ragStore.search(ragQuery);

          // Apply stickiness from previous turn
          ragResults = applyStickiness(rawResults, this.previousRAGFacts);
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

          if (ragResults.length > 0) {
            const logQuery = ragQuery.replace(/^\[tools: [^\]]*]\. ?/, '').slice(0, 100);
            debugLog('agent:rag', { query: logQuery, results: ragResults.length });
          }
        } catch (err) {
          debugLog('agent:rag:error', err instanceof Error ? err.message : String(err));
        }
      }

      const routineSummaries = this.routineStore.getSummaries();
      const specialistSummaries = this.specialistStore.getSummaries();
      const specialistMatches = matchSpecialists(userInput, specialistSummaries);

      const inputBase = {
        userInput,
        ragResults,
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
      const contextWindow = getContextWindow(this.config.model, this.config.tokenWindow);
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
      const effectiveSystemPromptChars =
        systemForEstimate.length +
        contextMsgChars +
        (reactActiveForEstimate ? REACT_COORDINATOR_PROMPT.length + 2 : 0);
      const estimatedTokens =
        estimateHistoryTokens(this.history) + Math.ceil(effectiveSystemPromptChars / 4);
      const hardLimit = contextWindow * HARD_LIMIT_RATIO;
      // `emergencyTruncate` deducts the length of its `systemPromptStr` arg
      // from the available budget. Pass a string that includes both the
      // SYSTEM prompt AND the per-turn context message, otherwise post-#172
      // truncation under-counts by the context-message size and the resulting
      // history can still exceed the wire-payload limit.
      const systemPlusContextForBudget =
        systemForEstimate + (contextMsgChars > 0 ? '\n'.repeat(contextMsgChars) : '');
      let preflightTruncated = false;
      if (estimatedTokens > hardLimit) {
        printInfo('Context approaching limit, emergency truncating...');
        this.history = emergencyTruncate(
          this.history,
          hardLimit,
          systemPlusContextForBudget,
          userInput,
        );
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
              // Also include the per-turn context-message size so the retry
              // budget matches the actual wire payload (issue #172 follow-up).
              const baseSystem = iterOpts.systemSuffix
                ? `${systemForEstimate}\n\n${iterOpts.systemSuffix}`
                : systemForEstimate;
              // Recompute context-message size from the live stores instead of
              // reusing the preflight value. A tool may have written a memory
              // or scratch entry between preflight and this retry; reusing
              // `contextMsgChars` would under-count and leave the retry payload
              // over the wire limit.
              const retryContextMsgs = buildMainContextMessages(this.ctx, inputBase);
              const retryContextMsgChars = retryContextMsgs.reduce(
                (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
                0,
              );
              const baseSystemPlusContext =
                baseSystem + (retryContextMsgChars > 0 ? '\n'.repeat(retryContextMsgChars) : '');
              this.history = emergencyTruncate(
                this.history,
                contextWindow * retryRatio,
                baseSystemPlusContext,
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
              content:
                '[Your previous response was cut off. Please continue exactly where you left off.]',
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

          if (result.finishReason === 'tool-calls' && result.steps.length >= maxStepsForCall) {
            this.lastStepLimitHit = true;
            this.stepLimitHitCount++;
            const msg =
              this.stepLimitHitCount >= 2
                ? `Stopped at loop limit of ${maxStepsForCall}. Use /options max-steps to adjust permanently.`
                : `Stopped at loop limit of ${maxStepsForCall}.`;
            printWarning(msg);
          } else {
            this.lastStepLimitHit = false;
          }

          return result;
        };

      let runOut;
      try {
        runOut = await runDefinition(this.ctx, mainAgentDefinition, input, {
          abortSignal: this.abortController!.signal,
          seedMessages: () => this.history,
          planStore: this.planStore,
          wrapIterate,
        });
      } catch (apiErr: unknown) {
        if (this.abortController?.signal.aborted) return;
        throw apiErr;
      }
      const result = runOut.result;

      // Track token usage for compression decisions — use last step's prompt tokens
      // (result.usage.promptTokens is the aggregate across ALL steps, not the last step)
      this.lastPromptTokens = this.lastStepPromptTokens ?? result.usage?.promptTokens ?? 0;

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
      // message. Derived from history so it's also correct on resume.
      if (this.lastSources.length > 0) {
        const userTurnCount = this.history.filter((m) => m.role === 'user').length;
        this.turnProvenance.push({
          turnIndex: Math.max(0, userTurnCount - 1),
          userInput: userInput,
          sources: this.lastSources.map((s) => ({ ...s })),
          citedIds: [...citedIds],
          timestamp: Date.now(),
        });
      }

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
      // If aborted by user, return silently — user message stays in history
      if (this.abortController?.signal.aborted) return;

      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Agent error: ${message}`);
    } finally {
      this.abortController = null;
      this.spinnerStats = null;
    }
  }

  /** Compresses conversation history in-place, returning token usage stats. */
  async compactHistory(): Promise<CompactResult> {
    const tokensBefore = estimateHistoryTokens(this.history);
    const compressed = await compressHistory(this.history, this.config, this.ragStore);
    const compacted = compressed !== this.history;
    if (compacted) {
      this.history = compressed;
      this.lastPromptTokens = estimateHistoryTokens(this.history);
    }
    const tokensAfter = estimateHistoryTokens(this.history);
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
    this.ctx.verification.clear();
    this.ctx.provenance.clear();
    this.ctx.postWriteChecks.length = 0;
    this.ctx.verificationTracker.clear();
    this.lastRubric = null;
    if (this.ctx.policyDecision) {
      this.ctx = { ...this.ctx, policyDecision: undefined };
    }
  }
}
