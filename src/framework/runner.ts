import crypto from 'node:crypto';
import {
  generateText,
  streamText,
  type CoreMessage,
  type GenerateTextResult,
  type LanguageModel,
  type Tool,
  type ToolCallRepairFunction,
} from 'ai';
import { debugLog, isDebugEnabled } from '../logger.js';
import { toolBlockBytes } from '../tool-bytes.js';
import type { AgentHook, StepFinishPayload } from './hooks/types.js';
import { runWithDispatchId } from './dispatch-context.js';
import { normalizeUsage } from './hooks/token-stats.js';
import {
  DISPATCH_ABORT_NAME,
  markProviderStall,
  providerStallInfo,
  type ProviderStallInfo,
} from '../error-taxonomy.js';
import { withStallBudget } from '../providers/stall-guard.js';

const WATCHDOG_INTERVAL_MS = 30_000;

/**
 * Default mid-stream stall budget (#325). `BERNARD_PROVIDER_STALL_TIMEOUT_MS`
 * (#302) bounds the wait for the FIRST byte; once headers arrive the body
 * streams with nothing watching it, leaving undici's 300 s `bodyTimeout` as the
 * only backstop — five minutes of a dead turn, unattended.
 *
 * Deliberately above the 90 s first-byte budget. An agent loop runs every step
 * inside one `streamText` call, so the HTTP round trip that opens step N+1
 * happens *inside* the stream with no parts flowing. That gap is already the
 * first-byte guard's job; if this budget were lower we would race it and
 * misreport a slow-but-live request as a stall.
 */
const STREAM_STALL_TIMEOUT_MS = 120_000;

/**
 * Builds a promise that rejects with the canonical AbortError when the signal
 * fires (immediately if it already has). A no-op rejection handler is attached
 * at construction so the promise can never surface as an unhandled rejection —
 * e.g. when the run unwinds via a provider-side error before any race observes
 * it, and the user only presses Esc afterwards. Each `Promise.race` attaches
 * its own handlers, so the races still see the rejection normally.
 */
function makeAbortPromise(abortSignal: AbortSignal): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    if (abortSignal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    abortSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
      once: true,
    });
  });
  p.catch(() => {});
  return p;
}

function parseDispatchTimeoutMs(): number | null {
  const raw = process.env.BERNARD_DISPATCH_TIMEOUT_MS;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Tick period for the watchdog. The stall guard can only fire on a tick, so a
 * fixed 30 s period would detect a 120 s stall somewhere in 120–150 s — fine —
 * but would detect a user-configured 5 s budget no sooner than 30 s, silently
 * ignoring the setting. Track the smaller of the two, floored so a very small
 * budget can't turn into a busy timer.
 */
function watchdogIntervalMs(stallMs: number | null): number {
  if (stallMs === null) return WATCHDOG_INTERVAL_MS;
  return Math.max(100, Math.min(WATCHDOG_INTERVAL_MS, stallMs));
}

/**
 * Mid-stream stall budget (#325). Unlike {@link parseDispatchTimeoutMs} this is
 * opt-OUT: absent means the default applies, `0` (or a non-numeric value)
 * disables the guard. Read per call rather than at module load, matching the
 * first-byte guard — `.env` is parsed by `loadConfig` after this module is
 * imported, so a captured value would silently ignore the user's setting.
 */
function parseStreamStallTimeoutMs(): number | null {
  const raw = process.env.BERNARD_STREAM_STALL_TIMEOUT_MS;
  if (raw === undefined || raw === '') return STREAM_STALL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Liveness callback handed to the streaming branch (#325). Internal to this
 * module — deliberately NOT part of {@link AgentSpec}, because it is not a
 * caller-supplied hook: `runAgentInner` owns both the clock and the watchdog
 * that reads it, and a caller passing its own would be able to hold the guard
 * open. The part `type` is passed so the guard can pause across tool execution.
 */
interface StreamProgress {
  onPart: (type: string) => void;
}

/**
 * Declarative spec for one `generateText` invocation. Callers pre-resolve the
 * model (via `getModelForConfig`) and pass the result here. The runner is
 * intentionally policy-free: retry loops, plan enforcement, critic dispatch,
 * and post-processing all live in the caller.
 */
export interface AgentSpec {
  model: LanguageModel;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  /**
   * Top-level generation params (issue #286): `temperature`, `topP`,
   * `maxOutputTokens`. Resolved per lineup slot by `resolveSiteModel` and
   * spread into the `generateText`/`streamText` call alongside `providerOptions`.
   */
  params?: Record<string, unknown>;
  tools?: Record<string, Tool>;
  maxSteps?: number;
  maxTokens?: number;
  system?: string;
  messages: CoreMessage[];
  abortSignal?: AbortSignal;
  /**
   * Ceiling on every liveness budget for this dispatch, in ms — the transport's
   * header and body-inactivity guards and the mid-stream watchdog alike.
   *
   * Set only by the stall-recovery loop in `agents/run.ts`, and only on RETRY
   * attempts. It can only SHORTEN: each budget takes `min(configured, this)`, so
   * an off switch stays off and no caller can lengthen a liveness guard.
   *
   * This is not a policy knob on the runner — the runner still owns no retry.
   * It is one number the caller of a retry needs to be able to say, because
   * three attempts at the full budget is a six-minute wait and the whole point
   * of recovering is that it is faster than not recovering.
   */
  stallTimeoutMs?: number;
  /** AI SDK accepts at most one — top-level field, not a hook. */
  prepareStep?: Parameters<typeof generateText>[0]['experimental_prepareStep'];
  /** AI SDK accepts at most one — top-level field, not a hook. */
  repair?: ToolCallRepairFunction<any>;
  /** Observer hooks composed in-order on `onStepFinish`. */
  hooks?: AgentHook[];
  /**
   * Phase C (#214): opt-in switch from `generateText` to `streamText` for
   * this run. Only the main-agent dispatch sets this — and only when an
   * output sink is registered, so the deltas have a consumer. Leaving it
   * `false`/undefined keeps every other call site (sub-agents, wrappers,
   * pre-turn LLM passes, context summarization) on the unchanged
   * `generateText` path.
   */
  useStreaming?: boolean;
  /**
   * Called once per text-delta chunk when `useStreaming` is true. The runner
   * still resolves the final {@link AgentResult} after the stream drains, so
   * callers downstream of `runAgent` see the same shape they always did.
   */
  onTextDelta?: (delta: string) => void;
  /**
   * Fired the moment the model finishes emitting a complete tool call (i.e.
   * the AI SDK's `tool-call` event in `fullStream`). Lets the caller surface
   * a `⚙ toolName` row in the UI while the tool's `execute` is still running,
   * which would otherwise stay invisible until the entire step finished.
   */
  onToolCallStart?: (event: { callId: string; toolName: string; args: unknown }) => void;
  /**
   * Fired when a tool's `execute` returns. Pairs with `onToolCallStart` by
   * `callId`. Useful for live-updating the result block under the call row.
   */
  onToolResult?: (event: { callId: string; toolName: string; result: unknown }) => void;
  /**
   * The id this run is logged under, when the caller already knows it (#512).
   *
   * A caller cannot get it from the ALS — `runDefinition` assembles its context
   * message *before* calling `runAgent` and would read whichever ancestor's
   * scope it happens to be nested in, attributing a sub-agent's context
   * decision to its parent's dispatch. So the id flows IN rather than back out
   * through a callback: with a callback, the caller has to hold its report in a
   * mutable slot spanning two closures and clear it by hand so iterate N's
   * report cannot attach to iterate N+1's id. Passing the id removes the slot
   * and the hazard with it.
   *
   * Omitted by every other caller, which mints one here as before.
   */
  dispatchId?: string;
}

/** Result type re-exported so callers needn't depend on `ai` directly. */
export type AgentResult = GenerateTextResult<any, any>;

/**
 * Composes hook `onStepFinish` callbacks into a single AI-SDK callback.
 * Hooks fire in declaration order; an error propagates and aborts the chain.
 */
function composeOnStepFinish(
  hooks: AgentHook[] | undefined,
): ((payload: StepFinishPayload) => Promise<void>) | undefined {
  if (!hooks || hooks.length === 0) return undefined;
  const observers = hooks.filter(
    (h): h is AgentHook & { onStepFinish: NonNullable<AgentHook['onStepFinish']> } =>
      Boolean(h.onStepFinish),
  );
  if (observers.length === 0) return undefined;
  return async (payload: StepFinishPayload) => {
    for (const hook of observers) {
      await hook.onStepFinish(payload);
    }
  };
}

/**
 * Single entry point used by the agent-loop sites that share boilerplate:
 * main agent, subagent, specialist, task, tool-wrapper, cron, critic.
 * Other `generateText` callers (`context.ts`, `prompt-rewriter.ts`,
 * `reference-resolver.ts`, `repl.ts`) are single-shot helpers that do not
 * need the hook chain and stay on the direct AI-SDK call.
 *
 * Cross-cutting behaviors (print-with-prefix, token tracking, structured-log
 * accumulation) are provided by hooks under `src/framework/hooks/`.
 *
 * Phase C goal: zero observable behavior change for the migrated sites. The
 * runner is a thin shim; the only delta vs. inline `generateText` is that
 * `onStepFinish` and `experimental_repairToolCall` are sourced from spec
 * hooks/factories.
 */
/**
 * A fresh dispatch id. Exported so a caller that needs to know the id BEFORE
 * the call can mint one and pass it in — see {@link AgentSpec.dispatchId}.
 */
export function newDispatchId(): string {
  return crypto.randomBytes(4).toString('hex');
}

export async function runAgent(spec: AgentSpec): Promise<AgentResult> {
  const dispatchId = spec.dispatchId ?? newDispatchId();
  // Always establish the dispatch-id ALS context (not just under debug). It is
  // near-free and it's what lets the token hooks stamp `callId`/`parentCallId`
  // onto every telemetry record so the session trace forms a real tree. The
  // watchdog / step debug logs inside `runAgentInner` stay debug-gated.
  const run = (): Promise<AgentResult> => runAgentInner(spec, dispatchId);
  // A retry's shortened budget has to reach a `fetch` the AI SDK calls several
  // frames below anything we hand it, so it rides the same ALS mechanism the
  // dispatch id already uses to cross that gap.
  return runWithDispatchId(dispatchId, () =>
    spec.stallTimeoutMs === undefined ? run() : withStallBudget(spec.stallTimeoutMs, run),
  );
}

async function runAgentInner(spec: AgentSpec, dispatchId: string): Promise<AgentResult> {
  const dispatchStartedAt = Date.now();
  const modelId = (spec.model as unknown as { modelId?: string }).modelId ?? String(spec.model);
  const debug = isDebugEnabled();

  // Per-step boundary instrumentation. We track stepN locally so step:start
  // (fired from a wrapped `prepareStep`) and step:end (fired from a prepended
  // `onStepFinish` observer) share the same counter, and so the watchdog can
  // read `lastStepEndAt` / `stepsCompleted` without coupling to the AI SDK
  // step accounting.
  let stepN = 0;
  let lastStepEndAt = dispatchStartedAt;
  let stepsCompleted = 0;
  let lastStepStartAt = dispatchStartedAt;

  const wrappedPrepareStep: AgentSpec['prepareStep'] = debug
    ? async (opts) => {
        stepN += 1;
        lastStepStartAt = Date.now();
        debugLog('step:start', { dispatchId, n: stepN });
        return spec.prepareStep ? await spec.prepareStep(opts) : undefined;
      }
    : spec.prepareStep;

  const stepObserver: AgentHook = {
    onStepFinish: (payload) => {
      lastStepEndAt = Date.now();
      // NOT `stepsCompleted += 1` — `stepCounter` below owns that now, and it is
      // composed ahead of this hook. Incrementing here too made `step:end`'s `n`
      // report 2, 4, 6… and doubled the count in `agent:dispatch:end`/`:error`
      // whenever debug was on, which is the only time those lines are written.
      if (debug) {
        const stepCache = normalizeUsage(payload.usage, payload.providerMetadata);
        debugLog('step:end', {
          dispatchId,
          n: stepsCompleted,
          finishReason: payload.finishReason,
          toolCalls: payload.toolCalls.map((c) => c.toolName),
          textChars: payload.text?.length ?? 0,
          promptTokens: stepCache.promptTokens,
          completionTokens: stepCache.completionTokens,
          // Prompt-cache counters (#269), normalized across providers — reading
          // `providerMetadata.anthropic` directly would log 0 for every
          // xAI/OpenAI call, i.e. blind in exactly the sessions where cache
          // accounting is being debugged.
          cacheReadTokens: stepCache.cacheReadTokens,
          cacheWriteTokens: stepCache.cacheWriteTokens,
          ttlms: Date.now() - lastStepStartAt,
        });
      }
    },
  };
  // Attach on BOTH branches (#253). This used to be `debug && !spec.useStreaming`,
  // reasoning that "the streaming branch already emits per-token / per-tool-call
  // events through the sink, so a per-step boundary event would be redundant
  // noise." That holds for *content* — but `StreamEvent` is only
  // `text-delta | tool-call | tool-result` and carries no usage at all, so the
  // rule also suppressed every per-step token and cache counter for the one
  // dispatch that streams: the main agent.
  //
  // Cost was still recorded in aggregate (`tokenStatsHook` → spinner, /usage,
  // telemetry), but nothing showed how a turn's prefix grew step to step, or
  // whether the prompt cache was being written vs. read. The gap is not
  // hypothetical: it let a sub-agent's `promptTokens` be read as the main
  // agent's when sizing #253, because main emitted no step lines to compare to.
  //
  // Still `debug`-only — otherwise this would force `onStepFinish` to be defined
  // on every dispatch even when the caller passed no hooks, breaking the
  // param-parity contract.
  // Counting steps is NOT debug-only, and that is a safety requirement rather
  // than tidiness. `stepsCompleted` used to move only inside the debug-gated
  // observer above, so in production it was permanently 0 — and stall recovery
  // reads it to decide whether re-running a dispatch would re-execute tool calls
  // that already ran. A retry that re-sends six completed steps' worth of writes
  // must not be gated on whether someone happened to set BERNARD_DEBUG.
  //
  // Separate from the logging observer so the debug gate keeps its stated
  // meaning (no per-step log lines unless asked) while the fact itself is always
  // available. Composed FIRST, so the observer's `n` reads the incremented value.
  const stepCounter: AgentHook = {
    onStepFinish: async () => {
      stepsCompleted += 1;
    },
  };
  const composedHooks: AgentHook[] = debug
    ? [stepCounter, stepObserver, ...(spec.hooks ?? [])]
    : [stepCounter, ...(spec.hooks ?? [])];
  const onStepFinish = composeOnStepFinish(composedHooks);

  debugLog('agent:dispatch:start', {
    dispatchId,
    model: modelId,
    streaming: spec.useStreaming === true,
    systemLen: spec.system?.length ?? 0,
    messagesLen: spec.messages.length,
    toolCount: spec.tools ? Object.keys(spec.tools).length : 0,
    // Wire size of the tool block, not just its cardinality (#253). Counting
    // tools alone is actively misleading when sizing prefix cost: the 18
    // `cron_*` tools are 37% of main's tool COUNT but 28% of its BYTES, and two
    // single tools (`lineup_edit`, `specialist`) outweigh six cron tools each.
    toolBytes: debug ? toolBlockBytes(spec.tools) : undefined,
    maxSteps: spec.maxSteps,
  });

  // Mid-stream progress clock (#325). `lastStepEndAt` cannot serve as one: it
  // moves only at step boundaries, so it climbs monotonically while tokens are
  // pouring in and aborting on it would kill healthy long steps — the false
  // positive #302's acceptance criteria forbid. `runStreaming` stamps this on
  // every part it pulls off `fullStream`, which is the only point in the
  // process that knows a byte arrived.
  //
  // `inFlightTools` gates the guard because a silent stream is not the same as
  // a dead one: `fullStream` emits `tool-call` when the model finishes emitting
  // the call, then nothing until `tool-result`. A `task` / `subagent` /  MCP
  // call legitimately occupies minutes of that silence. We pause the clock for
  // the span instead of raising the budget past it, so the guard keeps its
  // teeth for the case it exists for. If a tool-result never arrives the count
  // never returns to zero and the guard stays disabled for the rest of the
  // dispatch — fail-open, which is the right direction: losing the guard costs
  // us a slow failure, a false abort costs the user completed work.
  let lastProgressAt = dispatchStartedAt;
  let inFlightTools = 0;
  // Whether ANY part reached the consumer — deltas, tool calls and tool results
  // alike, not only `text-delta`. That is deliberately more conservative than
  // the duplication argument alone would need: a `text-delta` is what visibly
  // stutters when a dispatch is re-run against an append-only `OutputSink`, but
  // a `tool-call` already emitted means the model got that far, and re-running
  // re-executes it. Counted here because this callback is the only place that
  // knows a part was pulled off the stream.
  let partsSeen = 0;
  const progress: StreamProgress = {
    onPart: (type) => {
      partsSeen += 1;
      lastProgressAt = Date.now();
      if (type === 'tool-call') inFlightTools += 1;
      else if (type === 'tool-result' && inFlightTools > 0) inFlightTools -= 1;
    },
  };

  // The stall guard only applies to the streaming branch. `generateText` is one
  // opaque await with no per-byte signal, so `lastProgressAt` would never move
  // and every non-streaming dispatch would be killed at the budget. That branch
  // stays covered by the first-byte guard plus step boundaries; the asymmetry is
  // real and stating it beats pretending the fix is symmetric.
  const configuredStallMs = spec.useStreaming ? parseStreamStallTimeoutMs() : null;
  // `min`, never the override alone: a disabled guard must stay disabled, and a
  // retry may only tighten a liveness budget (see `AgentSpec.stallTimeoutMs`).
  const stallMs =
    configuredStallMs !== null && spec.stallTimeoutMs !== undefined
      ? Math.min(configuredStallMs, spec.stallTimeoutMs)
      : configuredStallMs;

  // Optional per-dispatch timeout. Chains a fresh AbortController off the
  // caller's signal so we don't leak a timer past dispatch completion. The
  // stall guard needs the same chained controller, so build it when either is
  // active.
  const timeoutMs = parseDispatchTimeoutMs();
  let timeoutHandle: NodeJS.Timeout | null = null;
  // One variable, not a flag per reason: the catch used to re-derive the choice
  // with a branch per source, and stall unconditionally won even when the
  // dispatch timer had fired first. `??=` reports whichever actually caused the
  // abort, and a third reason needs no new arm.
  let selfAbortMessage: string | null = null;
  // Set only by the STALL arm, never the dispatch-timeout arm. The distinction
  // is the point: a stall is the provider going quiet and is worth re-issuing,
  // while `BERNARD_DISPATCH_TIMEOUT_MS` is a wall clock the operator set and
  // silently retrying past it would defeat what they asked for.
  let selfAbortStall: ProviderStallInfo | null = null;
  let effectiveSignal = spec.abortSignal;
  let abortChained: (() => void) | null = null;
  if (timeoutMs !== null || stallMs !== null) {
    const ac = new AbortController();
    if (spec.abortSignal) {
      if (spec.abortSignal.aborted) ac.abort();
      else spec.abortSignal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    abortChained = () => ac.abort();
    effectiveSignal = ac.signal;
  }
  if (timeoutMs !== null) {
    timeoutHandle = setTimeout(() => {
      debugLog('agent:dispatch:timeout', {
        dispatchId,
        model: modelId,
        ms: timeoutMs,
      });
      selfAbortMessage ??= `Dispatch timed out after ${timeoutMs} ms (BERNARD_DISPATCH_TIMEOUT_MS)`;
      abortChained?.();
    }, timeoutMs);
    timeoutHandle.unref?.();
  }

  // Watchdog. No longer debug-gated: with `stallMs` it is the thing that ends a
  // dead stream, and gating it on debug would mean the guard protects only
  // sessions someone already suspected. Still `unref()`ed, so it cannot hold
  // the event loop open, and it does nothing but compare two numbers. Cleared
  // in the finally block whether the dispatch ends, errors, or aborts.
  //
  // SCOPE, precisely: `useStreaming` is `sink !== null` (`agents/run.ts`), and
  // the sink is registered only by `<App>`. `streaming: true` is declared on
  // exactly one definition, `main`. So this guard covers the main agent in a
  // mounted Ink REPL and NOTHING else — not cron, sub-agents, tool wrappers,
  // PAC phases, or delegate helpers, all of which are non-streaming and get
  // `stallMs === null`. That is the opposite of where an unattended hang
  // hurts most, and it is a property of the layer, not an oversight: a
  // per-part clock can only exist where parts exist. Covering the rest means
  // moving body-inactivity detection down to `providers/stall-guard.ts`,
  // which already wraps every client's `fetch` for the first-byte case —
  // filed as a follow-up.
  const watchdog =
    debug || stallMs !== null
      ? setInterval(() => {
          const now = Date.now();
          const sinceProgress = now - lastProgressAt;
          if (debug) {
            debugLog('agent:dispatch:stuck', {
              dispatchId,
              model: modelId,
              ms: now - dispatchStartedAt,
              sinceLastStepMs: now - lastStepEndAt,
              sinceLastProgressMs: sinceProgress,
              inFlightTools,
              stepsCompleted,
            });
          }
          if (stallMs !== null && inFlightTools === 0 && sinceProgress >= stallMs) {
            debugLog('agent:dispatch:stalled', {
              dispatchId,
              model: modelId,
              sinceLastProgressMs: sinceProgress,
              stepsCompleted,
            });
            selfAbortMessage ??=
              `Provider stream timed out — no data received for ${sinceProgress} ms ` +
              `(BERNARD_STREAM_STALL_TIMEOUT_MS)`;
            selfAbortStall ??= { phase: 'stream', producedOutput: partsSeen > 0 };
            abortChained?.();
          }
        }, watchdogIntervalMs(stallMs))
      : null;
  watchdog?.unref?.();

  try {
    const result = spec.useStreaming
      ? await runStreaming({ ...spec, abortSignal: effectiveSignal }, onStepFinish, progress)
      : await runNonStreaming(
          { ...spec, abortSignal: effectiveSignal, prepareStep: wrappedPrepareStep },
          onStepFinish,
        );
    debugLog('agent:dispatch:end', {
      dispatchId,
      model: modelId,
      durationMs: Date.now() - dispatchStartedAt,
      steps: result.steps?.length ?? 0,
      finishReason: result.finishReason,
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
    });
    return result;
  } catch (err) {
    // A timeout or stall abort fires the *chained* controller, not the caller's
    // signal, so the agent's catch can't tell it apart from a generic abort
    // (`this.abortController.signal.aborted` stays false) and would render a
    // bare "Agent error: Aborted" — i.e. nothing, since the REPL treats aborts
    // as "user pressed Esc". Re-shape into a self-describing error here, where
    // the context still exists. The message says "timed out" so
    // `error-taxonomy.ts` categorises it as `timeout` without new vocabulary;
    // the NAME is what marks it as ours, since a provider's own network
    // timeout says the same thing and is a retryable work failure.
    const ourAbort =
      err instanceof Error && err.name === 'AbortError' && !spec.abortSignal?.aborted;
    let wrapped: unknown = err;
    if (ourAbort && selfAbortMessage) {
      const self = new Error(selfAbortMessage, { cause: err });
      // Names it as ours so `isDispatchCancellation` can tell this from a
      // provider's (retryable) network timeout without reading the message.
      self.name = DISPATCH_ABORT_NAME;
      // The brand rides ALONGSIDE that name rather than replacing it: recovery
      // reads the brand, and once recovery gives up the five dispatch
      // boundaries still need the name to unwind instead of handing the model a
      // stall message as a successful tool result.
      if (selfAbortStall) markProviderStall(self, selfAbortStall);
      wrapped = self;
    }
    // Correct `producedOutput` with what the DISPATCH knows, whatever branded
    // it. The transport cannot answer this: `stall-guard.ts` mints `false` for a
    // headers-phase stall, which is true of that one HTTP REQUEST and says
    // nothing about the dispatch — and `partsSeen` only moves on the streaming
    // branch, so every non-streaming dispatch (`sub`, `task`, `specialist`,
    // `tool-wrapper`, the PAC phases, `cron`, `mcp-delegate`) reported `false`
    // permanently. Recovery would then re-run a sub-agent that stalled on step 7
    // from step 1, re-executing six steps of tool calls — including writes.
    //
    // `providerStallInfo` walks outermost-in, so re-marking here shadows the
    // transport's optimistic value rather than fighting it.
    const stall = providerStallInfo(wrapped);
    if (stall && !stall.producedOutput && (stepsCompleted > 0 || partsSeen > 0)) {
      markProviderStall(wrapped as Error, {
        ...stall,
        producedOutput: true,
        // Which half made it unsafe, so the decline can say so. `partsSeen`
        // moves only on the streaming branch, so `steps` is what every
        // ephemeral dispatch reports — the case the old single message named
        // wrongly.
        completedWork: partsSeen > 0 ? 'output' : 'steps',
      });
    }
    debugLog('agent:dispatch:error', {
      dispatchId,
      model: modelId,
      durationMs: Date.now() - dispatchStartedAt,
      message: wrapped instanceof Error ? wrapped.message : String(wrapped),
    });
    throw wrapped;
  } finally {
    if (watchdog) clearInterval(watchdog);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Non-streaming branch with a defensive abort race. The streaming branch has
 * carried this pattern for a while (see the comment on `raceAbort` below);
 * we mirror it here because the same provider-side hang ("internal await
 * deadlocked, but the fetch was cancelled") can land on `generateText`. The
 * race adds no work on the happy path — it just means a fired abort signal
 * unwinds the await immediately instead of waiting for the SDK to settle.
 */
async function runNonStreaming(
  spec: AgentSpec,
  onStepFinish: ((payload: StepFinishPayload) => Promise<void>) | undefined,
): Promise<AgentResult> {
  const gen = generateText({
    model: spec.model,
    providerOptions: spec.providerOptions,
    tools: spec.tools,
    maxSteps: spec.maxSteps,
    maxTokens: spec.maxTokens,
    system: spec.system,
    messages: spec.messages,
    abortSignal: spec.abortSignal,
    experimental_prepareStep: spec.prepareStep,
    experimental_repairToolCall: spec.repair,
    onStepFinish,
    // Per-slot params last so a slot-set temperature/topP/maxTokens overrides
    // the defaults above (issue #286).
    ...spec.params,
  });
  const abortSignal = spec.abortSignal;
  if (!abortSignal) return gen;
  return Promise.race([gen, makeAbortPromise(abortSignal)]);
}

/**
 * `streamText` branch (Phase C, #214). Pushes deltas to `spec.onTextDelta` as
 * they arrive, then assembles a `GenerateTextResult`-shaped object from the
 * `StreamTextResult` promises so callers downstream — strategies, plan
 * enforcement, provenance, format hooks — see no shape difference. The
 * `onStepFinish` hook still fires per step exactly as in the non-streaming
 * path, so tool-call / tool-result events route through `outputHook` to the
 * sink alongside the per-token deltas.
 */
async function runStreaming(
  spec: AgentSpec,
  onStepFinish: ((payload: StepFinishPayload) => Promise<void>) | undefined,
  progress?: StreamProgress,
): Promise<AgentResult> {
  // `streamText` accepts a subset of `generateText` settings — no
  // `experimental_prepareStep`. The main agent (the only `streaming: true`
  // definition) doesn't use prepareStep, so this is sound. If a future
  // streaming-capable definition needs prepareStep, the AI SDK has
  // `experimental_continueSteps` for the equivalent steering on this path.
  const stream = streamText({
    model: spec.model,
    providerOptions: spec.providerOptions,
    tools: spec.tools,
    maxSteps: spec.maxSteps,
    maxTokens: spec.maxTokens,
    system: spec.system,
    messages: spec.messages,
    abortSignal: spec.abortSignal,
    experimental_repairToolCall: spec.repair,
    onStepFinish,
    // Per-slot params last so they override the defaults above (issue #286).
    ...spec.params,
  });
  // Defensive: race every await against the parent abort signal. The AI SDK
  // is supposed to settle `textStream` and the result promises when its own
  // `abortSignal` fires, but in practice some providers leave the stream
  // pending after the underlying fetch is cancelled (observed on the OpenAI
  // path mid-reasoning). Without this race the REPL hangs on Esc because the
  // for-await never throws. We pin a single rejecting promise to the signal
  // and race it against each await so an abort always unwinds the runner.
  const abortSignal = spec.abortSignal;
  const abortPromise = abortSignal ? makeAbortPromise(abortSignal) : null;
  const raceAbort = async <T>(p: Promise<T>): Promise<T> =>
    abortPromise ? (Promise.race([p, abortPromise]) as Promise<T>) : p;

  // Drain the full stream. `fullStream` (vs `textStream`) emits tool-call /
  // tool-result events as they arrive, so the renderer can show `⚙ toolName`
  // the moment the model finishes the call — without that, MCP tools that
  // sit in `execute` for several seconds look indistinguishable from the
  // model still reasoning. Text deltas remain forwarded via `onTextDelta` so
  // existing callers see no behavior change.
  try {
    const iter = stream.fullStream[Symbol.asyncIterator]();
    while (true) {
      const next = await raceAbort(iter.next());
      if (next.done) break;
      // The stall guard's only progress signal (#325). Stamped before any
      // per-part branching so it covers every part type — including ones this
      // switch ignores (`reasoning`, `step-start`, …), which are still proof
      // the connection is alive.
      progress?.onPart((next.value as { type?: string }).type ?? '');
      // The AI SDK narrows `tool-call` / `tool-result` parts on the `TOOLS`
      // generic; since we type-erase tools to `Record<string, Tool>` for the
      // shared runner, those branches collapse to `never`. Cast through
      // `unknown` so we can pattern-match on `type` without coupling the
      // runner to a specific tool set.
      const part = next.value as {
        type: string;
        textDelta?: string;
        toolCallId?: string;
        toolName?: string;
        args?: unknown;
        result?: unknown;
        error?: unknown;
      };
      if (part.type === 'text-delta') {
        if (part.textDelta) spec.onTextDelta?.(part.textDelta);
      } else if (part.type === 'tool-call') {
        // Skip malformed events: an empty callId would collide across tool
        // pairings in the sink, and an empty name renders as a blank `⚙ `.
        if (part.toolCallId && part.toolName) {
          spec.onToolCallStart?.({
            callId: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
          });
        }
      } else if (part.type === 'tool-result') {
        if (part.toolCallId && part.toolName) {
          spec.onToolResult?.({
            callId: part.toolCallId,
            toolName: part.toolName,
            result: part.result,
          });
        }
      } else if (part.type === 'error') {
        // Surface stream errors immediately rather than waiting for the
        // settled promises below to re-throw — keeps the original stack.
        // Providers occasionally emit a non-Error value (string, plain
        // object); wrap so downstream `err.message` / `err.name` checks work.
        if (part.error instanceof Error) throw part.error;
        const wrapped = new Error(
          typeof part.error === 'string' ? part.error : JSON.stringify(part.error),
        );
        throw wrapped;
      }
    }
  } catch (err) {
    // Swallow the abort here so the result-promise awaits below can throw the
    // canonical AbortError from the race, keeping the error shape consistent.
    // Gate on `signal.aborted` so a provider-side AbortError (server timeout,
    // internal cancellation) still propagates — otherwise the turn ends with
    // no text and no diagnostic.
    const isUserAbort =
      err instanceof Error && err.name === 'AbortError' && abortSignal?.aborted === true;
    if (!isUserAbort) throw err;
  }
  // The other promises (toolCalls, toolResults, steps, etc.) are already
  // resolved once textStream completes — awaiting them is cheap.
  const [
    text,
    steps,
    finishReason,
    usage,
    warnings,
    toolCalls,
    toolResults,
    reasoning,
    reasoningDetails,
    providerMetadata,
    request,
    response,
    files,
    sources,
  ] = await raceAbort(
    Promise.all([
      stream.text,
      stream.steps,
      stream.finishReason,
      stream.usage,
      stream.warnings,
      stream.toolCalls,
      stream.toolResults,
      stream.reasoning,
      stream.reasoningDetails,
      stream.providerMetadata,
      stream.request,
      stream.response,
      stream.files,
      stream.sources,
    ]),
  );
  return {
    text,
    steps,
    finishReason,
    usage,
    warnings,
    toolCalls,
    toolResults,
    reasoning,
    reasoningDetails,
    providerMetadata,
    experimental_providerMetadata: providerMetadata,
    request,
    response,
    files,
    sources,
    experimental_output: undefined as never,
  } as unknown as AgentResult;
}
