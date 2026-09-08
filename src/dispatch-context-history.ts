import { DISPATCH_CONTEXT_FILE } from './paths.js';
import { PerTurnStore } from './per-turn-store.js';

/**
 * What one dispatch was given (#512).
 *
 * You could not see this. `ContextViewer` reads `agent.getTurnContext()`, and
 * `turnContext.push` happens at exactly one site — inside
 * `Agent.processInput` — so **no sub-agent, task, specialist, delegate or cron
 * dispatch's context assembly was recorded anywhere**. The only trace was
 * `context:section-sizes`, a debug-only log line carrying no agent identity, so
 * a main-agent line and a sub-agent line were indistinguishable in the JSONL.
 *
 * That matters more once retrieval is relevance-dependent: the surviving memory
 * subset then varies turn to turn with the request, so a standing instruction
 * can be present on one dispatch and absent the next with no signal beyond a
 * count.
 *
 * Sibling of {@link TurnContextRecord}, not a replacement: that one is the
 * main agent's *pre-turn pipeline* (typed vs. rewritten input, resolved
 * references, recalled facts), this one is what the *assembly* produced, for
 * every dispatch. Neither subsumes the other.
 */
export interface DispatchContextRecord {
  /** Correlates with `agent:dispatch:*` and `http:*` in the session log. */
  dispatchId: string;
  /** The `AgentDefinition.id` that ran — `main`, `sub`, `specialist`, … */
  definitionId: string;
  /** The ledger label this dispatch's spend was attributed to. */
  telemetrySite: string;
  timestamp: number;
  /** Rendered body length per emitted section. */
  sections: Record<string, number>;
  /** Curated memory keys that were rendered, in render order. */
  memoryKept?: string[];
  /** Curated memory keys the byte cap dropped. */
  memoryDropped?: string[];
  /** The query this dispatch retrieved for, when it retrieved (#510). */
  retrievalQuery?: string;
  /**
   * The memory-key fence this dispatch ran under, when it declared one (#511).
   *
   * Recorded because a fence and a bad retrieval look identical from the
   * outside: both surface as a standing instruction simply not being there.
   * `memoryKept` alone cannot tell them apart — an empty array reads the same
   * whether the store had nothing to give or the dispatch was not allowed to
   * ask. Absent means unscoped, which is every dispatch today.
   */
  memoryScope?: string[];
  /** The RAG domains this dispatch could retrieve from, when fenced (#511). */
  knowledgeScope?: string[];
  /** Knowledge libraries this dispatch could read (#516). */
  corpusScope?: string[];
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isDispatchContextRecord(entry: unknown): entry is DispatchContextRecord {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Partial<DispatchContextRecord>;
  return (
    typeof e.dispatchId === 'string' &&
    typeof e.definitionId === 'string' &&
    typeof e.telemetrySite === 'string' &&
    typeof e.timestamp === 'number' &&
    typeof e.sections === 'object' &&
    e.sections !== null &&
    !Array.isArray(e.sections) &&
    // Optional, and a non-array is corruption rather than "not recorded" — the
    // rule `isTurnContextRecord` already applies to `injectedMemoryKeys`.
    (e.memoryKept === undefined || isStringArray(e.memoryKept)) &&
    (e.memoryDropped === undefined || isStringArray(e.memoryDropped)) &&
    (e.retrievalQuery === undefined || typeof e.retrievalQuery === 'string') &&
    (e.memoryScope === undefined || isStringArray(e.memoryScope)) &&
    (e.knowledgeScope === undefined || isStringArray(e.knowledgeScope)) &&
    (e.corpusScope === undefined || isStringArray(e.corpusScope))
  );
}

/**
 * How many dispatch records are kept in memory.
 *
 * Bounded because a single coordinator turn fans out — `withSlot` allows four
 * concurrent dispatches and each MCP delegation adds another — so this grows
 * far faster than the per-turn stores it sits beside, and `PerTurnStore.save`
 * is uncapped and pretty-printed.
 */
const MAX_RECORDS = 200;

/**
 * The in-process recorder.
 *
 * Module-level, following `providers/request-counter.ts`: `runDefinition` is a
 * free function with no field to hang state on, and threading a sink through
 * `AgentContext` would mean every context builder — including the four in
 * tests — opting in to a record that is pure diagnostics.
 *
 * Kept in memory and flushed once at exit, never written per dispatch: this
 * sits inside the step loop's caller, and a `writeFileSync` there would put
 * disk I/O on the path between assembling a prompt and sending it.
 */
const records: DispatchContextRecord[] = [];
let enabled = false;

export function recordDispatchContext(record: DispatchContextRecord): void {
  if (!enabled) return;
  records.push(record);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

/**
 * Newest last, matching the two per-turn stores.
 *
 * A new array over the same record objects, like `Agent.getTurnContext`'s
 * `[...this.turnContext]` — so a caller cannot re-order or truncate the
 * recorder, but the records themselves are **read-only by convention**, not by
 * copy. Deep-cloning up to 200 records on every read would be real work to
 * defend against a caller mutating a diagnostics row.
 */
export function getDispatchContexts(): DispatchContextRecord[] {
  return [...records];
}

/**
 * Turns recording on for this process.
 *
 * Off by default, and that is the point: `recordDispatchContext` fires per LLM
 * call in **every** process, but only an interactive REPL ever reads the
 * records back. A cron daemon or applet host would otherwise accumulate and
 * retain the bound's worth of rows — plus a reference to every pack's key
 * arrays — that nothing will ever look at. The same shape as
 * `def.streaming && getOutputSink()`: a producer that stays quiet until
 * something is listening.
 */
export function enableDispatchContextRecording(): void {
  enabled = true;
}

/** Seeds from a resumed session, then continues appending. */
export function setDispatchContexts(loaded: DispatchContextRecord[]): void {
  records.length = 0;
  records.push(...loaded.slice(-MAX_RECORDS));
}

export function clearDispatchContexts(): void {
  records.length = 0;
}

/**
 * Persists the per-dispatch context records. The third {@link PerTurnStore}
 * subclass, beside `TurnContextStore` and `ProvenanceHistoryStore`.
 *
 * Module-private: the records live in this module, so a caller that holds the
 * store still has to fetch the data from here — which is how `/clear` ended up
 * needing two calls to be correct. {@link loadDispatchContexts} /
 * {@link saveDispatchContexts} are the whole surface.
 */
class DispatchContextStore extends PerTurnStore<DispatchContextRecord> {
  constructor() {
    super({ filePath: DISPATCH_CONTEXT_FILE, validate: isDispatchContextRecord });
  }
}

let store: DispatchContextStore | undefined;
function fileStore(): DispatchContextStore {
  store ??= new DispatchContextStore();
  return store;
}

/** Seeds the recorder from the last session's file. */
export function loadDispatchContexts(): void {
  setDispatchContexts(fileStore().load());
}

/**
 * Flushes to disk. Called **once, at exit** — never per turn.
 *
 * `PerTurnStore.save` pretty-prints and rewrites the whole array, measured at
 * 0.65 ms and 354 KB at the record bound; running that inside every turn's
 * `finally`, on the Ink render path, for a diagnostics record nothing reads
 * until the session ends, is work for its own sake.
 */
export function saveDispatchContexts(): void {
  fileStore().save(getDispatchContexts());
}

/** Drops both the in-memory records and the file, for `/clear`. */
export function clearDispatchContextStore(): void {
  clearDispatchContexts();
  fileStore().clear();
}
