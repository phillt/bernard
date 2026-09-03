import { capSubagentResult } from './tools/result-cap.js';
import { isMCPErrorResult, isPlainObject } from './tool-result-shape.js';

/**
 * MCP result-shaping mode (#297). `off` passes results through untouched;
 * `cap` bounds an over-budget result with a **structure-aware** truncation that
 * never severs JSON mid-token (unlike the blunt char-chop `truncateToolResults`
 * applies to history). A future `summarize` mode (LLM digest on the cheap tier)
 * is a documented follow-up and not wired yet.
 */
export type MCPResultShapingMode = 'off' | 'cap';

/** Default character budget for a capped MCP result. Generous so only genuinely
 * large payloads (long lists, full email bodies) are bounded; small results pass
 * through untouched. */
export const DEFAULT_MCP_RESULT_MAX_CHARS = 8000;

export interface MCPResultShapingConfig {
  mode: MCPResultShapingMode;
  maxChars: number;
}

/**
 * How an over-budget result was bounded. `shrink` and `fields` keep the
 * payload's shape; `wrapper` replaces it with a preview and is the only
 * strategy that can lose a field without naming it.
 */
export type ShapeStrategy = 'string' | 'items' | 'fields' | 'shrink' | 'wrapper';

/** What one capping decision did, for the caller to log (#459). */
export interface ShapeStats {
  rawChars: number;
  keptChars: number;
  strategy: ShapeStrategy;
  /** True when the payload arrived as JSON inside a `content[].text` entry. */
  unwrapped: boolean;
}

/**
 * Reports a capping decision to the caller.
 *
 * A callback rather than a `debugLog` import, so this module stays a leaf that
 * touches nothing but its two pure siblings — the same reasoning
 * `apps/capabilities.ts` gives for `MintObserver`, and that keeps `tool-bytes.ts`
 * and `mcp-names.ts` off the modules they measure. It also keeps this module's
 * tests free of a logger mock.
 *
 * Only fires when something was actually cut: an under-budget result is not a
 * decision worth a log line, and it is the overwhelming majority of calls.
 *
 * The stats arrive as a THUNK so `keptChars` — a full extra stringify of the
 * shaped result — is not computed when no observer is listening. Same rule this
 * change applies to `tool:execute:end`, where the payload is built inside an
 * `isDebugEnabled()` guard for exactly this reason.
 */
export type ShapeObserver = (stats: ShapeStats) => void;

/**
 * Reports to `onCap` without ever throwing into the caller.
 *
 * `mcp.ts` calls the shaper INSIDE the try whose catch reconnects the server
 * and retries the tool — so an observer that threw would be indistinguishable
 * from a failed tool call and would tear down a healthy stdio connection. Same
 * defensive treatment `capabilities.ts` gives `onMint`, and the same reason the
 * `truncatedWrapper` catch exists.
 */
function report(onCap: ShapeObserver | undefined, stats: () => ShapeStats): void {
  if (!onCap) return;
  try {
    onCap(stats());
  } catch {
    // A logging failure must never cost a tool result.
  }
}

/** Serialized size of a value in characters (strings measured directly). */
function serializedSize(v: unknown): number {
  if (typeof v === 'string') return v.length;
  try {
    return JSON.stringify(v)?.length ?? Infinity;
  } catch {
    return Infinity;
  }
}

/**
 * A string cut to fit `budget`, saying how much it lost.
 *
 * The marker is INSIDE the budget, so the return is always `<= budget` — the
 * same contract `capSubagentResult` gives, and what lets `shrinkLargest` size a
 * slot without a hand-tuned allowance for the marker's own length. The wording
 * differs from that helper deliberately: it names the LOSS (`N chars omitted`),
 * matching `capArray`'s sentinel and `headAndTail`'s marker, because inside a
 * shaped payload what a reader needs is how much is missing, not what the
 * budget was.
 */
function truncatedString(s: string, budget: number): string {
  if (s.length <= budget) return s;
  // Solved against the final length: the marker names the count it is itself
  // part of, so a fixed-width estimate would either overshoot the budget or
  // understate the loss.
  const marker = (n: number) => `…[${n} chars omitted]`;
  let keep = Math.max(0, budget - marker(s.length).length);
  while (keep > 0 && keep + marker(s.length - keep).length > budget) keep--;
  return s.slice(0, keep) + marker(s.length - keep);
}

/**
 * Caps an array to fit `budget` characters: keeps as many leading items as fit,
 * then appends a single string sentinel naming how many were dropped. The result
 * is always a valid JSON array.
 */
function capArray(arr: unknown[], budget: number): unknown[] {
  const kept: unknown[] = [];
  let used = 2; // the surrounding `[]`
  for (let i = 0; i < arr.length; i++) {
    const itemSize = serializedSize(arr[i]) + 1; // +1 for the comma
    // `kept.length === i` here, so this sentinel is also the one we append on
    // the break path — build it once.
    const sentinel = `… ${arr.length - i} more items omitted`;
    if (used + itemSize + serializedSize(sentinel) + 1 > budget && kept.length > 0) {
      kept.push(sentinel);
      return kept;
    }
    kept.push(arr[i]);
    used += itemSize;
  }
  return kept;
}

/** Returns the key of the plain object's largest array-valued property, if any. */
function largestArrayKey(obj: Record<string, unknown>): string | undefined {
  let best: string | undefined;
  let bestSize = -1;
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      const s = serializedSize(v);
      if (s > bestSize) {
        bestSize = s;
        best = k;
      }
    }
  }
  return best;
}

/**
 * The maximum depth {@link collectSlots} descends. A bound rather than a
 * cycle-detecting visited set, because a cyclic value already measures
 * `Infinity` and {@link shrinkLargest} refuses it before walking — so the only
 * thing depth buys is a guarantee that a very deep acyclic payload cannot spend
 * the whole budget being walked.
 */
const MAX_WALK_DEPTH = 8;

/**
 * Passes {@link shrinkLargest} may take. Each pass shrinks exactly one slot, so
 * a payload with several similarly-sized blobs legitimately needs several; the
 * bound is what stops a slot that only ever gives back a character or two from
 * spinning.
 */
const MAX_SHRINK_PASSES = 24;

/**
 * A slot is worth shrinking only if it could plausibly close the gap. Below
 * this the recursion re-serializes the whole payload per pass to reclaim almost
 * nothing — measured at ~33 ms for a 500-key escape-heavy object that was
 * always going to end at the wrapper anyway.
 */
const MIN_SHRINK_SLOT = 64;

/** A settable array/string position in the tree, with the value it holds now. */
interface Slot {
  value: unknown;
  set: (v: unknown) => void;
  size: number;
}

/**
 * Every array and string reachable from `root`, as settable slots.
 *
 * Records the *container plus key* rather than the value, because the caller
 * has to write a smaller value back in place — which is what lets the shrink
 * keep the payload's shape instead of replacing it with a preview. Only plain
 * objects and arrays are descended (the `isPlainObject` rule the rest of this
 * module follows), so the walk cannot reach a prototype chain or a class
 * instance.
 */
function collectSlots(root: unknown, out: Slot[] = [], depth = 0): Slot[] {
  if (depth > MAX_WALK_DEPTH) return out;
  const visit = (container: Record<string, unknown>, key: string) => {
    // Never take `__proto__` as a slot. MCP output is untrusted, and `JSON.parse`
    // — which the envelope unwrap now runs on a server's own text — makes
    // `__proto__` a real own property, unlike an object literal. Writing through
    // it later would retarget the clone's prototype instead of a field. Benign
    // today (the own property shadows the inherited setter), which is precisely
    // why it is worth refusing rather than relying on.
    if (key === '__proto__') return;
    const v = container[key];
    if (Array.isArray(v) || typeof v === 'string') {
      out.push({
        value: v,
        set: (nv) => {
          container[key] = nv;
        },
        size: serializedSize(v),
      });
    }
    if (Array.isArray(v) || isPlainObject(v)) collectSlots(v, out, depth + 1);
  };
  if (Array.isArray(root)) {
    const asRecord = root as unknown as Record<string, unknown>;
    for (let i = 0; i < root.length; i++) visit(asRecord, String(i));
  } else if (isPlainObject(root)) {
    for (const k of Object.keys(root)) visit(root, k);
  }
  return out;
}

/**
 * Shrinks the biggest thing anywhere in the tree, repeatedly, until the whole
 * value fits — the layer that makes the structure-aware cap actually reach the
 * shapes that occur (#458).
 *
 * `capArray` / `largestArrayKey` only ever look at the TOP level, and this
 * reaches the shapes they cannot. Measured, the relationship is **subsumption,
 * not complementary coverage**: this pass also handles everything the object
 * path handles, and the only shape it cannot reach is a bare root array of
 * small elements — because `collectSlots` visits root's children, never root
 * itself. The top-level scans are therefore kept as a **fast path** (they land
 * in one exact-budget pass, where this pays a `structuredClone` and a
 * re-serialize per pass on inputs that can be megabytes) and for their honest
 * strategy labels — not because they cover a case this one misses. A Gmail
 * message keeps its
 * bulk in `payload.parts[].body.data` (a base64 blob) and its identifying
 * fields in `payload.headers` (a nested array), so the top-level scan finds
 * only `labelIds`, saves nothing, and drops the payload into the front-slicing
 * wrapper — which is exactly how a `Cc` header went missing and Bernard
 * reported that a CC it had sent was dropped, then sent a duplicate to fix it.
 *
 * Spending the LARGEST slot first is what keeps the small identifying fields:
 * the blob is orders of magnitude bigger than any header, so it is consumed
 * long before a header is reached. That is a property of these payloads, not a
 * guarantee — hence the `null` return, which hands anything this cannot bound
 * back to the wrapper rather than returning it over budget.
 */
function shrinkLargest(result: unknown, maxChars: number): unknown | null {
  // A cycle (or anything else unserializable) measures `Infinity`, so there is
  // no gap to close and no way to measure progress. The wrapper stringifies
  // defensively and is the right answer for those.
  if (!Number.isFinite(serializedSize(result))) return null;
  let clone: unknown;
  try {
    clone = structuredClone(result);
  } catch {
    // `JSON.stringify` DROPS a function silently, so a result carrying one
    // measures finite, clears the guard above, and then makes `structuredClone`
    // throw `DataCloneError`. `mcp.ts` calls the shaper inside the try whose
    // catch reconnects the server, so a throw here is indistinguishable from a
    // failed tool call and tears down a healthy stdio connection — the same
    // reason `truncatedWrapper` and `report` each carry a catch. The wrapper,
    // which stringifies defensively, is the right answer for an unclonable
    // value anyway.
    return null;
  }
  for (let pass = 0; pass < MAX_SHRINK_PASSES; pass++) {
    const total = serializedSize(clone);
    if (total <= maxChars) return clone;
    const over = total - maxChars;
    const slots = collectSlots(clone).sort((a, b) => b.size - a.size);
    // Refuse a payload no amount of shrinking can bring under budget, before
    // spending a pass on it.
    //
    // Budgeted against the passes actually left, not against every slot: one
    // pass shrinks exactly one slot, so the most that can still be reclaimed is
    // the sum over the largest `remaining` slots. Summing ALL of them instead
    // answers a question nobody asked — 30 fields of 200 KB can clear a 6 MB
    // gap in principle and cannot in 24 passes, so the shrink ran the full 24,
    // re-serialising a 6 MB tree each time, and returned `null` to the wrapper
    // that was the answer from the start: 317 ms of pure loss on a shape
    // CLAUDE.md already names as reachable (a browser accessibility snapshot).
    // Slots are sorted descending, so the slice IS the best case.
    //
    // Still an over-estimate — nested slots are counted twice — which is the
    // safe direction: it can decline to bail on something it might have shrunk,
    // never bail on something it could have. `MIN_SHRINK_SLOT` alone catches
    // neither case: 500 eighty-character fields each clear the floor
    // individually and only their sum does not.
    const remaining = MAX_SHRINK_PASSES - pass;
    const reclaimable = slots
      .slice(0, remaining)
      .reduce((sum, sl) => sum + Math.max(0, sl.size - MIN_SHRINK_SLOT), 0);
    if (reclaimable < over) return null;
    let progressed = false;
    for (const slot of slots) {
      // Sorted descending, so the first slot too small to help means every
      // remaining one is too.
      if (slot.size < MIN_SHRINK_SLOT) break;
      const value = slot.value;
      // No allowance for a marker: `truncatedString` and `capArray` both keep
      // their own markers inside the budget they are handed.
      const target = Math.max(48, slot.size - over);
      const next =
        typeof value === 'string'
          ? truncatedString(value, target)
          : capArray(value as unknown[], target);
      // A slot can refuse to shrink — a one-element array whose sole item is
      // the oversized thing, since `capArray` never drops a leading element.
      // Move to the next-largest rather than giving up: that element's own
      // contents are themselves slots, and that is where the blob is reached.
      if (serializedSize(next) < slot.size) {
        slot.set(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) return null;
  }
  return serializedSize(clone) <= maxChars ? clone : null;
}

/**
 * Last-resort truncation: stringify a value and cap it inside a valid JSON
 * wrapper so the model always receives parseable JSON with an explicit
 * truncation flag. Used whenever the structure-aware cap can't get under budget
 * (e.g. a single leading element that alone exceeds the budget).
 *
 * The `preview` is a JSON string embedded as a *string value*, so when the
 * wrapper is itself serialized its quotes/backslashes get escaped — which can
 * inflate the raw preview length by up to ~2x. Budgeting the raw preview to
 * `maxChars - 40` alone therefore lets the encoded wrapper overshoot `maxChars`.
 * We measure the encoded size and shrink the preview budget until the whole
 * wrapper fits (bounded halving, floor 64) so the cap contract actually holds.
 *
 * The preview keeps the **head and the tail** rather than the head alone. A
 * head-only slice is the worst possible choice for a payload whose identifying
 * fields sit at the end — which is the general form of #458, where a Gmail
 * message's `Cc` sat behind kilobytes of `Received` / `ARC-Seal` noise. The
 * recursive shrink above now carries that case, so this is a second line of
 * defence rather than the fix, but head-only remains wrong for whatever shape
 * reaches here next.
 *
 * A failing MCP result keeps its `isError` flag (#363). This path replaces the
 * envelope wholesale, so without re-stamping it an over-budget failure would
 * arrive downstream looking like an ordinary success — the truncation silently
 * *upgrading* an error. The object path above clones and so keeps it already.
 */
function truncatedWrapper(result: unknown, maxChars: number): Record<string, unknown> {
  let raw: string;
  try {
    raw = JSON.stringify(result) ?? String(result);
  } catch {
    // Non-serializable (e.g. a cycle) — fall back to a plain string form so we
    // never throw out of the shaping path into the MCP retry/reconnect catch.
    raw = String(result);
  }
  let budget = Math.max(64, maxChars - 40);
  const wrapper: Record<string, unknown> = {
    _truncated: true,
    _note:
      'Result was too large and has been truncated. Fields may be missing — re-read more narrowly before asserting anything absent.',
    preview: headAndTail(raw, budget),
  };
  if (isMCPErrorResult(result)) wrapper.isError = true;
  while (serializedSize(wrapper) > maxChars && budget > 64) {
    budget = Math.max(64, Math.floor(budget / 2));
    wrapper.preview = headAndTail(raw, budget);
  }
  return wrapper;
}

/**
 * Keeps the first and last thirds of `raw` within `budget`, naming the gap.
 *
 * Two thirds head, one third tail: the head carries the shape (what kind of
 * object this is, its leading keys) and is what a reader orients by, while the
 * tail is where a record's later fields live. Below a size where both halves
 * can say anything, a plain head slice is more useful than two fragments.
 */
function headAndTail(raw: string, budget: number): string {
  if (raw.length <= budget) return raw;
  if (budget < 256) return capSubagentResult(raw, budget);
  const marker = (n: number) => `\n...[${n} chars omitted]...\n`;
  const omitted = raw.length - budget;
  const room = budget - marker(omitted).length;
  const head = Math.ceil((room * 2) / 3);
  const tail = room - head;
  return raw.slice(0, head) + marker(raw.length - head - tail) + raw.slice(raw.length - tail);
}

function shapeOverBudget(
  result: unknown,
  maxChars: number,
): { value: unknown; strategy: ShapeStrategy } {
  if (typeof result === 'string') {
    // Head AND tail, for the reason `truncatedWrapper` gives: a head-only slice
    // is the worst choice for a payload whose identifying fields sit at the
    // end, and a result that IS one large string is the case where that costs
    // most. (`truncatedString` stays head-only on purpose — the slots it cuts
    // are blobs whose tails are worthless by construction.)
    return { value: headAndTail(result, maxChars), strategy: 'string' };
  }
  if (Array.isArray(result)) {
    const capped = capArray(result, maxChars);
    // `capArray` refuses to drop the first element, so an array whose leading
    // item alone exceeds the budget comes back over-budget. Re-check, then try
    // to shrink *inside* that element before giving up on the structure.
    if (serializedSize(capped) <= maxChars) return { value: capped, strategy: 'items' };
    const shrunk = shrinkLargest(result, maxChars);
    if (shrunk !== null) return { value: shrunk, strategy: 'shrink' };
    return { value: truncatedWrapper(result, maxChars), strategy: 'wrapper' };
  }
  if (isPlainObject(result)) {
    const arrKey = largestArrayKey(result);
    if (arrKey) {
      const clone: Record<string, unknown> = { ...result };
      // Budget for the array = total budget minus everything else in the object.
      const restSize = serializedSize({ ...clone, [arrKey]: [] });
      clone[arrKey] = capArray(result[arrKey] as unknown[], Math.max(64, maxChars - restSize));
      if (serializedSize(clone) <= maxChars) return { value: clone, strategy: 'fields' };
    }
    // Nothing at the top level got us there — the bulk is nested. Shrink the
    // biggest thing anywhere in the tree before falling back to a preview.
    const shrunk = shrinkLargest(result, maxChars);
    if (shrunk !== null) return { value: shrunk, strategy: 'shrink' };
    return { value: truncatedWrapper(result, maxChars), strategy: 'wrapper' };
  }
  // Unreachable: `shapeMCPResult` returns a primitive before ever calling this,
  // so every arm above owns a shape it genuinely reshaped. Kept total rather
  // than thrown, because throwing out of the shaping path lands in `mcp.ts`'s
  // reconnect catch and would tear down a healthy server.
  return { value: result, strategy: 'wrapper' };
}

/**
 * The JSON payload carried inside an MCP `content[].text` entry, if there is
 * exactly one and it parses.
 *
 * This is the shape that actually arrives from a server — `{content: [{type:
 * 'text', text: '<json>'}]}` — and until #458 nothing unwrapped it, so every
 * structure-aware branch above was dead for the dominant case: the envelope is
 * a plain object whose only array is `content`, `capArray` will not drop its
 * sole element, and the whole payload fell to the wrapper.
 *
 * Exactly one entry — a deliberately CONSERVATIVE bound rather than a
 * principled one, and worth saying so. The rule the code actually wants is "if
 * a text entry carries JSON, unwrap it", which has no arity in it; unwrapping
 * each entry needs only a budget split, not the ordering the restriction is
 * usually justified by. Single-entry is what Gmail and the common servers emit,
 * so the narrow fix is what ships here. A multi-entry result still gets bounded
 * by the ordinary paths — nothing is lost unnamed — but its inner payload is
 * cut as opaque text, so the module's "never severs JSON mid-token" promise
 * holds for the envelope and not for that inner value. Non-JSON text is left
 * alone too — plenty of servers return prose, and parsing is not the point.
 *
 * A real cost this introduces, worth stating rather than discovering: the round
 * trip through `JSON.parse`/`JSON.stringify` is **lossy**. Insignificant
 * whitespace and number formatting are lost, and an integer beyond
 * `Number.MAX_SAFE_INTEGER` loses precision. It is paid only by results that
 * were going to be truncated anyway — the under-budget path returns the
 * original object untouched — so the trade is a reformatted large result
 * against a silently gutted one.
 */
function contentJson(
  result: unknown,
): { payload: unknown; rewrap: (payload: unknown) => unknown } | null {
  if (!isPlainObject(result) || !Array.isArray(result.content) || result.content.length !== 1) {
    return null;
  }
  const [entry] = result.content;
  if (!isPlainObject(entry) || typeof entry.text !== 'string') return null;
  const text = entry.text.trim();
  // Cheap reject before paying for a parse of a large prose blob.
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    const payload: unknown = JSON.parse(entry.text);
    // A bare scalar parses but has no structure to shape, so unwrapping it buys
    // nothing and costs a re-serialize.
    if (!isPlainObject(payload) && !Array.isArray(payload)) return null;
    return {
      payload,
      // Spread rather than a fresh `{content:[{type,text}]}`: a real server
      // flags `isError` on a content ENTRY as well as on the envelope, and
      // `detectResultFailure` reads both.
      rewrap: (p) => ({ ...result, content: [{ ...entry, text: JSON.stringify(p) }] }),
    };
  } catch {
    return null;
  }
}

/**
 * Bounds a normalized MCP tool result to a character budget before it enters an
 * agent's context (#297). Small results (≤ `maxChars`) are returned untouched —
 * zero added latency/cost. Over-budget results are truncated structure-aware so
 * the model never sees invalid/mid-token JSON. With per-server delegation (#296)
 * on, this shapes each helper's own accumulating loop context; it also bounds
 * the delegation-off direct path.
 *
 * `onCap` reports what was cut (#459). Tool results were previously bounded with
 * no record anywhere, which is why #458 — a header block silently dropped from a
 * Gmail read — could not be told apart from a server that never sent the header.
 */
export function shapeMCPResult(
  result: unknown,
  config: MCPResultShapingConfig,
  onCap?: ShapeObserver,
): unknown {
  if (config.mode === 'off') return result;
  const rawChars = serializedSize(result);
  if (rawChars <= config.maxChars) return result;
  // A primitive over budget means a budget smaller than `null` serializes to.
  // There is nothing to cut, so returning it is right — but firing `onCap`
  // would record a capping decision for a value nothing touched, and a log that
  // reports work it did not do is what #459 exists to remove. Decided here, so
  // every arm of `shapeOverBudget` owns a shape it genuinely reshaped.
  if (result === null || (typeof result !== 'object' && typeof result !== 'string')) return result;

  // Unwrap `content[].text` so the structure-aware paths see the real payload,
  // then re-emit the envelope. Re-emitting rather than returning the bare
  // object keeps `detectResultFailure`'s `mcpFailureText` walk working and
  // keeps `isError` meaningful downstream (#363).
  const inner = contentJson(result);
  if (inner) {
    // The envelope's own keys cost characters the payload cannot use.
    const overhead = serializedSize(inner.rewrap(''));
    let budget = Math.max(64, config.maxChars - overhead);
    let shaped = shapeOverBudget(inner.payload, budget);
    let rewrapped = inner.rewrap(shaped.value);
    // The measurement is CARRIED, not re-taken: `serializedSize` here is a full
    // stringify of the whole envelope, and reading it in the loop condition and
    // again in the body cost four of them per call where two suffice.
    let encoded = serializedSize(rewrapped);
    // The shaped payload goes back as a JSON string *value*, so its quotes and
    // backslashes are escaped a second time — inflating it by up to ~2x, the
    // same trap `truncatedWrapper` documents. Budgeting the payload alone
    // therefore lets the envelope overshoot. Re-budget against the *encoded*
    // size by the observed overshoot ratio, which converges in one or two
    // passes; the guard is there so a pathological ratio cannot spin.
    for (let i = 0; i < 6 && encoded > config.maxChars && budget > 64; i++) {
      // `0.95` undershoots deliberately: converging from below costs one extra
      // pass, overshooting costs the contract.
      budget = Math.max(64, Math.floor((budget * config.maxChars * 0.95) / encoded));
      shaped = shapeOverBudget(inner.payload, budget);
      rewrapped = inner.rewrap(shaped.value);
      encoded = serializedSize(rewrapped);
    }
    report(onCap, () => ({
      rawChars,
      keptChars: encoded,
      strategy: shaped.strategy,
      unwrapped: true,
    }));
    return rewrapped;
  }

  const { value, strategy } = shapeOverBudget(result, config.maxChars);
  report(onCap, () => ({
    rawChars,
    keptChars: serializedSize(value),
    strategy,
    unwrapped: false,
  }));
  return value;
}
