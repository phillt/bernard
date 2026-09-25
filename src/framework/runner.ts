import crypto from 'node:crypto';
import { generateText, streamText } from 'ai';
import type {
  CoreMessage,
  GenerateTextResult,
  LanguageModel,
  TextStreamPart,
  Tool,
  ToolCallRepairFunction,
} from './sdk.js';
import type { z } from 'zod';
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
import { withStallBudget, DEFAULT_STALL_TIMEOUT_MS } from '../providers/stall-guard.js';
import { inFlightForDispatch } from '../tools/in-flight.js';

/**
 * A tool set concrete enough for the SDK's own `TextStreamPart` union to stay
 * whole — type-only, never constructed.
 *
 * `ToolSet` is `Record<string, Tool>` and `Tool.execute` is OPTIONAL, so
 * `ToolResultUnion<ToolSet>` maps over "tools that can produce a result" and
 * finds none: the `tool-result` arm of `TextStreamPart<ToolSet>` collapses to
 * `never`. Naming one tool that HAS an `execute` keeps the arm, and typing its
 * args and result as `unknown` keeps it honest — the runner erases tools on
 * purpose, so it genuinely does not know what a part carries.
 */
type StreamProbeTools = {
  probe: Tool<z.ZodType<unknown>, unknown> & {
    execute: (args: unknown, options: never) => PromiseLike<unknown>;
  };
};

/**
 * The `fullStream` parts this runner acts on, **derived from the SDK's union**
 * rather than hand-written (#sdk-boundary).
 *
 * What stood here was a local all-optional literal —
 * `{type: string; textDelta?: string; toolCallId?: string; toolName?: string;
 * args?: unknown; result?: unknown; error?: unknown}` — and it was the largest
 * silent surface in the repo. Every field being optional means a rename
 * upstream does not fail to compile: `part.textDelta` simply becomes
 * `undefined`, so the streaming REPL renders no text at all; `part.args`
 * becomes `undefined`, so every tool row shows a call with no arguments; and
 * `part.result` becomes `undefined`, so `detectToolError` sees no failures and
 * `successCount` climbs on calls that failed — the #363 accounting bug,
 * restored by a type nobody would think to look at.
 *
 * Derived, a rename lands as a compile error at the read site. The `type`
 * discriminator does the narrowing, so no field is read off an arm that does
 * not declare it.
 */
type StreamPart = TextStreamPart<StreamProbeTools>;

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
 * How late a watchdog tick may be before it is read as the whole process having
 * been frozen rather than as this dispatch having been silent (#607).
 *
 * One second, absolute. Ordinary timer jitter is milliseconds, so anything at
 * this scale is a blocking `spawnSync` in a sibling dispatch, a long GC pause,
 * a suspended machine, or an NTP step — none of which say anything about the
 * dispatch this timer belongs to.
 */
const FROZEN_LOOP_TOLERANCE_MS = 1_000;

/**
 * How many provider round trips one non-streaming step can contain (#607).
 *
 * The model call, plus at most one `makeRepairHook` retry — that hook re-prompts
 * exactly once on an `InvalidToolArgumentsError` / `NoSuchToolError`, and its
 * retry is a second full `generateText` inside the same step, invisible to every
 * budget below this one. The number is what relates this branch's liveness
 * budget to the transport's first-byte ceiling, at the default AND on a retry.
 */
const STEP_ROUND_TRIPS = 2;

/**
 * Default liveness budget on the NON-streaming branch (#607).
 *
 * Its sibling above measures inter-TOKEN silence, so any byte resets it and it
 * never has to cover a whole generation. This one has no bytes to watch: a
 * completed step is the only proof of life `generateText` offers, and the clock
 * is paused for the step's own tool calls, so what it must cover is one model
 * round trip — the step's completion plus, at most, `makeRepairHook`'s single
 * retry, which is a second full round trip inside the same step.
 *
 * So the budget is derived rather than guessed: {@link STEP_ROUND_TRIPS} times
 * the transport's own first-byte ceiling, so a step's model call and its repair
 * can each run to the very edge of a guard that already ships without tripping
 * this one. Expressed as a multiple rather than as a literal 180 000 because the
 * relationship is the thing that has to hold — see `stallCeilingFor`, where a
 * retry's shortened transport ceiling has to carry the same factor or the two
 * silently stop being related. The retries the AI SDK *does* make cost almost
 * nothing here — a 429 or a 5xx answers immediately, and the slow failures are
 * our own guards, which throw a plain `Error` the SDK does not retry.
 *
 * Measured against the same quantity: 1,605 telemetry records from the seven
 * sites that build no tool registry at all (`rewriter`, `recall-filter`,
 * `reference-resolver`, `compressor`, `specialist-detector`,
 * `speech-normalizer`, `memory-contradiction`), which is where `latencyMs` IS
 * one round trip and nothing else. p50 4.5 s, p95 9.7 s, p99 13.0 s, max 41.7 s;
 * exactly one over 30 s and none over 60. The PAC phases are deliberately NOT in
 * that set even though they look like single-shot helpers — `pac-planner` and
 * `pac-critic` both declare `tools()`, so their `latencyMs` can carry tool time
 * and would flatter the ceiling.
 *
 * The residual, stated rather than padded away: a step that spends a full
 * first-byte budget on the model call AND another on a repair sums to exactly
 * this. Two consecutive round trips within a second of a guard that has never
 * been within 48 s of firing is not a case worth widening a default for, and `0`
 * is the off switch for anyone who meets it.
 */
const DISPATCH_STALL_TIMEOUT_MS = STEP_ROUND_TRIPS * DEFAULT_STALL_TIMEOUT_MS;

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
 * A liveness budget. Unlike {@link parseDispatchTimeoutMs} these are opt-OUT:
 * absent means the default applies, `0` (or a non-numeric value) disables the
 * guard. Read per call rather than at module load, matching the first-byte guard
 * — `.env` is parsed by `loadConfig` after this module is imported, so a
 * captured value would silently ignore the user's setting.
 */
function parseLivenessBudgetMs(raw: string | undefined, fallbackMs: number): number | null {
  if (raw === undefined || raw === '') return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * The liveness budget for this dispatch, and which branch's it is.
 *
 * **Two knobs rather than one, and the reason is that they measure different
 * quantities.** `BERNARD_STREAM_STALL_TIMEOUT_MS` bounds the gap between two
 * bytes; `BERNARD_DISPATCH_STALL_TIMEOUT_MS` bounds the gap between two step
 * boundaries, net of the step's own tool calls. Tightening the first below a
 * plausible inter-token pause only kills genuinely silent streams; tightening
 * the second below a single completion kills every dispatch there is. A user
 * reaching for one of those should not silently get the other.
 */
function stallBudgetFor(useStreaming: boolean | undefined): number | null {
  return useStreaming
    ? parseLivenessBudgetMs(process.env.BERNARD_STREAM_STALL_TIMEOUT_MS, STREAM_STALL_TIMEOUT_MS)
    : parseLivenessBudgetMs(
        process.env.BERNARD_DISPATCH_STALL_TIMEOUT_MS,
        DISPATCH_STALL_TIMEOUT_MS,
      );
}

/**
 * A retry's ceiling, in THIS branch's units.
 *
 * `AgentSpec.stallTimeoutMs` is a transport-scale number: one producer,
 * `STALL_RETRY_BUDGET_MS`, sized explicitly against time to first byte ("above
 * the 27.4 s worst legitimate TTFB measured across 1,230 instrumented
 * requests"). The streaming budget is on that scale — a gap between two bytes —
 * so it takes the number as given. The non-streaming one is not: it is
 * {@link STEP_ROUND_TRIPS} times the transport ceiling by construction, and
 * applying an unscaled retry ceiling collapses the factor.
 *
 * That collapse is not theoretical. At 30 ms-scale-30 000, a retry would budget
 * a whole step at 30 s against a MEASURED maximum of 41.7 s for a single round
 * trip with no repair at all — so attempts 2 and 3 would abort work that is
 * fine, brand it `phase: 'dispatch'`, and burn straight through to
 * `stall:recovery:exhausted`. A ceiling the measured maximum already exceeds is
 * not a ceiling. New with #607: before it, `configuredStallMs` was `null` off
 * the streaming branch, so the override reached the transport guards and never a
 * dispatch watchdog.
 *
 * Scaling here rather than having `stall-recovery.ts` hand down two numbers: the
 * retry loop knows how hard it wants to squeeze, and only the runner knows what
 * a step is made of.
 */
function stallCeilingFor(
  useStreaming: boolean | undefined,
  stallTimeoutMs: number | undefined,
): number | undefined {
  if (stallTimeoutMs === undefined) return undefined;
  return useStreaming ? stallTimeoutMs : stallTimeoutMs * STEP_ROUND_TRIPS;
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
   * Ceiling on every liveness budget for this dispatch, in ms, **on the
   * transport's scale** — one time-to-first-byte.
   *
   * The scale is part of the contract rather than a detail (#607). Three of the
   * four consumers measure that quantity directly and take the number as given:
   * the header guard, the body-inactivity guard, and the mid-stream watchdog,
   * whose budget is a gap between two bytes. The non-streaming watchdog does
   * not — its budget is {@link STEP_ROUND_TRIPS} times a transport ceiling by
   * construction — so it scales the number rather than applying it, in
   * `stallCeilingFor`. A caller passes one number on one scale; the runner
   * converts.
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
  /**
   * Messages the user sent while this run was working (#200), drained by the
   * runner before every model request on the streaming branch.
   *
   * A drain rather than a list, so the runner holds nothing: whatever it takes
   * is appended to the conversation the next request carries and to
   * `response.messages`, and whatever it never takes stays with the caller —
   * which is what lets a message that arrives after the model's last step be
   * handed back and run as the next turn instead of being lost.
   *
   * Consulted only by `runStreaming`, which is the main agent alone. Nothing
   * else takes user input mid-run, so the non-streaming branch keeps the SDK's
   * own loop.
   */
  takeInterjections?: () => CoreMessage[];
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
  // The liveness clock both branches are judged against. Declared here because
  // `stepCounter` below stamps it; the guard that reads it, and the argument for
  // what counts as a sign of life, are at the watchdog further down.
  let lastProgressAt = dispatchStartedAt;

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
  // Counting steps is also what gives the NON-streaming branch a progress signal
  // (#607). It is stamped here rather than in the debug-gated observer below for
  // exactly the reason `stepsCompleted` moved here: a liveness guard that only
  // works when somebody set `BERNARD_DEBUG` is not a guard. It stamps on both
  // branches — on the streaming one it is a no-op in effect, since parts fire far
  // more often, and `lastProgressAt` then means one thing everywhere: the last
  // time this dispatch showed a sign of life.
  const stepCounter: AgentHook = {
    onStepFinish: async () => {
      stepsCompleted += 1;
      lastProgressAt = Date.now();
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
  // positive #302's acceptance criteria forbid. `runStreaming` stamps
  // `lastProgressAt` on every part it pulls off `fullStream`, which is the only
  // point in the process that knows a byte arrived.
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
  //
  // **#594 revisited this exemption and kept it; #607 kept it again and gave the
  // other branch one of its own.** #594 names the exemption as one of four gaps
  // behind a 35-minute hang: the tool that hung was MCP, and this guard is
  // written not to fire while a tool is in flight. The exemption is still right,
  // because this layer cannot tell a wedged proxy from a sub-agent doing its job
  // — that is a property of WHICH tool is running, and only the tool layer knows
  // it. So the deadline went where the knowledge is: `mcp.ts` races every
  // `tools/call` against `BERNARD_MCP_CALL_TIMEOUT_MS`.
  //
  // What #594 left open was the OTHER inhabitant: a `task` / `subagent` call had
  // no clock of its own unless the operator set `BERNARD_DISPATCH_TIMEOUT_MS`,
  // which is unset by default. That is now closed, and the shape of the fix is
  // worth stating because the issue proposed a different one.
  //
  // #607 proposed a WALL CLOCK derived from the dispatch's own step budget.
  // Measurement says that is the wrong instrument, for a reason that only became
  // true once #302/#325/#350/#594 had all landed: every layer beneath a dispatch
  // is now individually bounded — 90 s to first byte, 120 s of body silence, 60 s
  // per MCP call, `shellTimeout` per shell call — so a dispatch's total time is
  // already the product of a bounded per-step ceiling and its step budget. A wall
  // clock over that product is ~26 minutes for a 13-step sub-agent. It bounds the
  // failure; it does not end it in any time a person would call bounded. It also
  // has to count time spent inside `ask_user`, which a `delegate_<server>` helper
  // is explicitly told to call and which is legitimately unbounded — the one
  // false positive #302's criteria forbid, minted by the instrument itself.
  //
  // What was actually missing is that nothing noticed when a step made no
  // progress AT ALL — the one failure the transport guards structurally cannot
  // see, because it is `generateText` sitting on a fetch that already settled
  // (`runNonStreaming`'s abort race was written for exactly that, and nothing
  // fires the signal it races). So the non-streaming branch gets a liveness clock
  // too: silence since the last completed step, paused while this dispatch has a
  // tool of its own in flight. Same question the stream guard asks, same answer
  // to the `ask_user` case, and it catches the same population at three minutes
  // rather than twenty-six.
  //
  // A dispatch that never returns is either stuck inside one of its own tools,
  // or stuck outside them — and only the second is this guard's to catch. The
  // first is covered rung by rung: the MCP deadline for a `tools/call`,
  // `shellTimeout` for `shell`, `FETCH_TIMEOUT_MS` for `web_read` /
  // `web_search`, `MAX_WAIT_SECONDS` for `wait`, `BERNARD_EMBEDDING_IDLE_TIMEOUT_MS`
  // for `knowledge` and every RAG search, and a nested dispatch's own copy of
  // this guard for `subagent` / `task` / `specialist_run` / `delegate_<server>`.
  // `ask_user` is the deliberate exception: paused forever, on purpose, because
  // a person is thinking.
  //
  // The last of those is new. The model load was the one built-in bounded by
  // nothing — a cold-cache download reachable from a dispatch's own tool — and
  // this guard pausing for it was correct while the inner bound was missing.
  // It is bounded by SILENCE rather than by elapsed time, for the reason
  // `embeddings.ts` sets out at length: a load is 180 ms warm and minutes on a
  // slow link, so no duration is both a bound and safe.
  //
  // **What makes that list complete is a sweep, not an invariant, and the
  // difference is worth stating.** Every built-in that reaches the network does
  // so through `web.ts`, `web-search.ts`, MCP, the provider clients, or
  // `getEmbeddingProvider` — checked by walking `src/tools/` for `fetch` and for
  // a dynamic import, at the commit that closed the last one. Nothing mechanical
  // stops a sixth from arriving unbounded: "does this tool have a bound" is not
  // decidable from the registry the way `meta-coverage.test.ts`'s checks are.
  //
  // The two branches read their busy signal from different places, and the
  // streaming one is deliberately NOT moved onto the tool registry even though
  // it would be strictly better there (`runTracked` decrements in a `finally`,
  // so the fail-open two paragraphs up cannot happen). #350's rule: removing a
  // working liveness guard in the same change that adds another doubles the
  // blast radius. Available, not taken.
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

  const configuredStallMs = stallBudgetFor(spec.useStreaming);
  // `min`, never the override alone: a disabled guard must stay disabled, and a
  // retry may only tighten a liveness budget (see `AgentSpec.stallTimeoutMs`).
  const ceilingMs = stallCeilingFor(spec.useStreaming, spec.stallTimeoutMs);
  const stallMs =
    configuredStallMs !== null && ceilingMs !== undefined
      ? Math.min(configuredStallMs, ceilingMs)
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
  // Unchaining matters now that the non-streaming branch has a default budget
  // (#607): the condition below used to be false for every dispatch but the
  // main agent's, and it is now true for all of them. The caller's signal is one
  // turn-scoped controller shared by every dispatch in the turn, so a `{once}`
  // listener that is never removed retains one chained controller per dispatch
  // until the turn ends — dozens, for a coordinator turn. No
  // `MaxListenersExceededWarning` (an `AbortSignal` is uncapped unless someone
  // calls `events.setMaxListeners` on it), which is exactly why it would have
  // stayed invisible.
  let unchain: (() => void) | null = null;
  if (timeoutMs !== null || stallMs !== null) {
    const ac = new AbortController();
    if (spec.abortSignal) {
      if (spec.abortSignal.aborted) ac.abort();
      else {
        const parent = spec.abortSignal;
        const onParentAbort = (): void => ac.abort();
        parent.addEventListener('abort', onParentAbort, { once: true });
        unchain = () => parent.removeEventListener('abort', onParentAbort);
      }
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
  // SCOPE: every dispatch, on both branches, since #607. It used to be the main
  // agent in a mounted Ink REPL and nothing else — `useStreaming` is
  // `sink !== null` (`agents/run.ts`), the sink is registered only by `<App>`,
  // and `streaming: true` is declared on exactly one definition — so cron,
  // sub-agents, tool wrappers, PAC phases and delegate helpers all resolved
  // `stallMs === null`, which was the opposite of where an unattended hang hurts
  // most. What differs between the branches now is only the two inputs below:
  // what counts as progress, and what counts as busy.
  //
  // The tick is SELF-CHECKING, because this clock measures one process's
  // silence and can be frozen by work that is not this dispatch's (#607).
  // `shell` is `spawnSync` (`tools/shell.ts`), which blocks the whole process
  // and is raisable to `MAX_SHELL_TIMEOUT_MS` (10 min) through the timeout
  // offer — a hazard `timeout-offer.ts` already names. Four dispatches run
  // concurrently by default, so while dispatch A sits in a synchronous spawn,
  // sibling B cannot stamp `lastProgressAt`; and when the loop resumes the
  // TIMERS phase runs before the POLL phase, so this interval fires with a
  // `sinceProgress` covering the freeze and kills B before B's already-arrived
  // response is delivered. Measured: with a 300 ms budget and a 900 ms
  // synchronous freeze, a dispatch whose `readFile` completion was queued and
  // waiting was rejected at 930 ms. A wall-clock jump does the same thing for
  // free — a laptop lid closed for an hour makes every non-streaming dispatch
  // in the process look stalled at the first tick after resume.
  //
  // So the clock is RESTARTED rather than the tick being skipped. Skipping is
  // not enough — `lastProgressAt` is stale by the frozen duration, so the next
  // tick sees the same stale value. And crediting only the measured overrun is
  // not enough either: the watchdog knows the EXCESS over its period was frozen
  // and cannot know how much of the period before it was, so a credit of the
  // excess alone still charges the dispatch one whole period of somebody else's
  // spawn — which, for any budget at or below the 30 s tick, is the entire
  // budget. Measured: a 1.5 s freeze on a 300 ms budget still fired, at exactly
  // 300 ms, with the credit in place.
  //
  // Restarting is the fail-open direction this guard already chose (#325:
  // "losing the guard costs us a slow failure, a false abort costs the user
  // completed work"), and the cost is bounded — the only blocking call in the
  // product is `spawnSync`, itself bounded by `shellTimeout`.
  const tickMs = watchdogIntervalMs(stallMs);
  let lastTickAt = Date.now();
  const watchdog =
    debug || stallMs !== null
      ? setInterval(() => {
          const now = Date.now();
          // Ordinary timer jitter is milliseconds; a second of drift is the
          // process having been somewhere else. Deliberately absolute rather
          // than a multiple of the period, so a user-configured small budget
          // (and therefore a small period) does not make every ordinary tick
          // look like a freeze.
          const drift = now - lastTickAt - tickMs;
          lastTickAt = now;
          if (drift > FROZEN_LOOP_TOLERANCE_MS) {
            debugLog('agent:dispatch:clock-drift', { dispatchId, driftMs: drift });
            lastProgressAt = now;
          }
          const sinceProgress = now - lastProgressAt;
          // Streaming counts parts, which is the finer signal and the one this
          // branch has; non-streaming asks the tool registry, which is the only
          // place that knows a `generateText` step is parked inside `ask_user`
          // or a nested dispatch rather than wedged. Resolved once and used for
          // both the gate and the log, so `agent:dispatch:stuck` reports the
          // number the guard actually read — on the non-streaming branch
          // `inFlightTools` is permanently 0, and logging that beside a guard
          // that is silently paused is the shape of diagnostic #594 is about.
          const toolsInFlight = spec.useStreaming ? inFlightTools : inFlightForDispatch(dispatchId);
          if (debug) {
            debugLog('agent:dispatch:stuck', {
              dispatchId,
              model: modelId,
              ms: now - dispatchStartedAt,
              sinceLastStepMs: now - lastStepEndAt,
              sinceLastProgressMs: sinceProgress,
              inFlightTools: toolsInFlight,
              stepsCompleted,
            });
          }
          if (stallMs !== null && toolsInFlight === 0 && sinceProgress >= stallMs) {
            debugLog('agent:dispatch:stalled', {
              dispatchId,
              model: modelId,
              sinceLastProgressMs: sinceProgress,
              // What it was waiting FOR, not only how long it waited. The line
              // carried the elapsed time alone, which cannot distinguish the two
              // branches' budgets from each other, nor either of them from a
              // retry's shortened ceiling — the three numbers a triage most
              // needs to tell apart, and the three `stallCeilingFor` exists to
              // keep on their own scales.
              budgetMs: stallMs,
              stepsCompleted,
            });
            selfAbortMessage ??= spec.useStreaming
              ? `Provider stream timed out — no data received for ${sinceProgress} ms ` +
                `(BERNARD_STREAM_STALL_TIMEOUT_MS)`
              : `Dispatch timed out — no step completed for ${sinceProgress} ms with no tool ` +
                `running (BERNARD_DISPATCH_STALL_TIMEOUT_MS)`;
            // `producedOutput` is minted the same way on both branches and is
            // deliberately pessimistic here: `partsSeen` never moves off the
            // streaming branch, so this always mints `false` and the catch below
            // widens it with `stepsCompleted`. One rule, expressed once.
            selfAbortStall ??= {
              phase: spec.useStreaming ? 'stream' : 'dispatch',
              producedOutput: partsSeen > 0,
            };
            abortChained?.();
          }
        }, tickMs)
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
      markProviderStall(wrapped as Error, { ...stall, producedOutput: true });
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
    unchain?.();
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
 * they arrive, then assembles a `GenerateTextResult`-shaped object so callers
 * downstream — strategies, plan enforcement, provenance, format hooks — see no
 * shape difference. The `onStepFinish` hook still fires per step exactly as in
 * the non-streaming path, so tool-call / tool-result events route through
 * `outputHook` to the sink alongside the per-token deltas.
 *
 * **Bernard owns the step loop on this branch (#200).** Each step is its own
 * `streamText({maxSteps: 1})` call, and the next one is issued here rather than
 * inside the SDK. That is what gives the main agent a yield point: before every
 * model request the runner asks {@link AgentSpec.takeInterjections} for
 * anything the user typed while it worked, and appends it to the conversation
 * the request carries.
 *
 * `ai@4.3.19` offers no such point on its own loop — CLAUDE.md's #200 entry
 * records the three candidates checked against the installed bundle and why
 * each fails. SDK 5's `prepareStep` can rewrite messages and would replace this
 * loop; until then, this is the seam.
 *
 * **It costs nothing in tokens or bytes, and a little CPU.** The SDK re-sends
 * the whole conversation on every step anyway, as the initial messages plus
 * the accumulated response messages — exactly what each call is handed, and
 * `runner.owned-loop.test.ts` asserts every provider prompt is identical. What
 * is new is `standardizePrompt`: the SDK validates the prompt against its
 * message schema once per `streamText` call, which was once per turn and is
 * now once per step. Measured at ~0.12 ms per message — about 130 ms over a
 * typical ten-step turn, and a 30-70 ms pause before each late step of a
 * 150-step one. Small beside the round trips, and gone with SDK 5.
 *
 * **The continuation rule is the SDK's, copied rather than approximated**: the
 * next step runs iff this one made tool calls, every call produced a result,
 * and the step budget has room. `experimental_continueSteps` is not used here,
 * so its `length` branch never applies.
 *
 * **The safe point is "before a request", and that is what makes it safe.**
 * Tools execute inside a step, so a drain between steps cannot land in the
 * middle of a tool call. It runs before step 0 as well, so a message typed
 * during the pre-turn pipeline reaches the first request.
 *
 * **The aggregate reproduces `streamText`'s own, which differs from
 * `generateText`'s in two fields**: `text` is every step's text concatenated
 * (`recordedFullText`), and `sources` accumulate across steps. Everything else
 * that is per-step comes from the last step, `usage` is summed, and
 * `response.messages` is cumulative — interjections included, in the position
 * they were sent, which is how they reach persistent history with no plumbing
 * of their own.
 */
async function runStreaming(
  spec: AgentSpec,
  onStepFinish: ((payload: StepFinishPayload) => Promise<void>) | undefined,
  progress?: StreamProgress,
): Promise<AgentResult> {
  const maxSteps = spec.maxSteps ?? 1;
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

  // Everything generated after `spec.messages`, in order: each step's response
  // messages and any interjection drained between them.
  const accumulated: CoreMessage[] = [];
  const steps: unknown[] = [];
  const sources: unknown[] = [];
  let fullText = '';
  // Summed exactly as the SDK's `addLanguageModelUsage` sums them: raw, so a
  // provider that reports no count still yields `NaN` rather than a plausible 0.
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let last: Awaited<ReturnType<typeof streamOneStep>> | undefined;

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    accumulated.push(...(spec.takeInterjections?.() ?? []));
    const stepType = stepIndex === 0 ? 'initial' : 'tool-result';
    // `accumulated` does not change while the call runs, so the hook payload
    // and the recorded step get the same prefix.
    const call = await streamOneStep(
      spec,
      [...spec.messages, ...accumulated],
      onStepFinish
        ? (payload) => onStepFinish(withPrefix(payload, accumulated, stepType))
        : undefined,
      progress,
      raceAbort,
    );
    last = call;
    fullText += call.text;
    sources.push(...call.sources);
    usage = {
      promptTokens: usage.promptTokens + call.usage.promptTokens,
      completionTokens: usage.completionTokens + call.usage.completionTokens,
      totalTokens: usage.totalTokens + call.usage.totalTokens,
    };
    // `maxSteps: 1`, so each call is exactly one step.
    steps.push(withPrefix(call.steps[0], accumulated, stepType));
    accumulated.push(...(call.response.messages as CoreMessage[]));

    const allCallsAnswered =
      call.toolCalls.length > 0 && call.toolResults.length === call.toolCalls.length;
    if (!allCallsAnswered) break;
  }

  // What `streamText` itself says to `maxSteps: 0`: the loop above would issue
  // no request at all, and there is no step to build a result from.
  if (!last) throw new Error('maxSteps must be at least 1');
  return {
    text: fullText,
    steps,
    finishReason: last.finishReason,
    usage,
    warnings: last.warnings,
    toolCalls: last.toolCalls,
    toolResults: last.toolResults,
    reasoning: last.reasoning,
    reasoningDetails: last.reasoningDetails,
    providerMetadata: last.providerMetadata,
    experimental_providerMetadata: last.providerMetadata,
    request: last.request,
    response: { ...last.response, messages: accumulated },
    files: last.files,
    sources,
    experimental_output: undefined as never,
  } as unknown as AgentResult;
}

/**
 * A one-step call's step, as the SDK's own loop would have reported it.
 *
 * The SDK's step results carry a CUMULATIVE `response.messages`, and
 * `partialObserver.onStepMessages` (agents/run.ts) keeps partial work on abort
 * by that contract; a one-step call only knows its own messages, so the prefix
 * goes back on. `stepType` is restored for the same reason — every one-step
 * call calls itself `initial`.
 */
function withPrefix<T extends { response?: { messages?: CoreMessage[] } }>(
  step: T,
  prefix: CoreMessage[],
  stepType: 'initial' | 'tool-result',
): T {
  return {
    ...step,
    stepType,
    response: { ...step.response, messages: [...prefix, ...(step.response?.messages ?? [])] },
  } as T;
}

/**
 * One `streamText({maxSteps: 1})` call: drain its `fullStream` into the
 * caller's callbacks, then settle the result promises.
 */
async function streamOneStep(
  spec: AgentSpec,
  messages: CoreMessage[],
  onStepFinish: ((payload: StepFinishPayload) => Promise<void>) | undefined,
  progress: StreamProgress | undefined,
  raceAbort: <T>(p: Promise<T>) => Promise<T>,
) {
  const abortSignal = spec.abortSignal;
  const stream = streamText({
    model: spec.model,
    providerOptions: spec.providerOptions,
    tools: spec.tools,
    maxSteps: 1,
    maxTokens: spec.maxTokens,
    system: spec.system,
    messages,
    abortSignal,
    experimental_repairToolCall: spec.repair,
    onStepFinish,
    // Per-slot params last so they override the defaults above (issue #286).
    ...spec.params,
  });

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
      // The runner type-erases tools to `Record<string, Tool>`, so the stream
      // it holds is `TextStreamPart<ToolSet>`, whose `tool-result` arm is
      // `never` (see {@link StreamProbeTools}). One cast, to the SDK-DERIVED
      // union — so the discriminator and every field below are the SDK's own
      // and a rename is a compile error, which the hand-written literal this
      // replaces could not be.
      const part = next.value as unknown as StreamPart;
      // The stall guard's only progress signal (#325). Stamped before any
      // per-part branching so it covers every part type — including ones this
      // switch ignores (`reasoning`, `step-start`, …), which are still proof
      // the connection is alive.
      progress?.onPart(part.type);
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
  // resolved once the stream completes — awaiting them is cheap.
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
    request,
    response,
    files,
    sources,
  };
}
