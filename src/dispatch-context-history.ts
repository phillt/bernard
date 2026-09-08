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
    (e.retrievalQuery === undefined || typeof e.retrievalQuery === 'string')
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

export function recordDispatchContext(record: DispatchContextRecord): void {
  records.push(record);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

/** Newest last, matching the two per-turn stores. */
export function getDispatchContexts(): DispatchContextRecord[] {
  return [...records];
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
 */
export class DispatchContextStore extends PerTurnStore<DispatchContextRecord> {
  constructor() {
    super({ filePath: DISPATCH_CONTEXT_FILE, validate: isDispatchContextRecord });
  }
}
