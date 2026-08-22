import { capSubagentResult } from './tools/result-cap.js';

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

/** Serialized size of a value in characters (strings measured directly). */
function serializedSize(v: unknown): number {
  if (typeof v === 'string') return v.length;
  try {
    return JSON.stringify(v)?.length ?? Infinity;
  } catch {
    return Infinity;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
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
  let wrapper: Record<string, unknown> = {
    _truncated: true,
    preview: capSubagentResult(raw, budget),
  };
  while (serializedSize(wrapper) > maxChars && budget > 64) {
    budget = Math.max(64, Math.floor(budget / 2));
    wrapper = { _truncated: true, preview: capSubagentResult(raw, budget) };
  }
  return wrapper;
}

function shapeOverBudget(result: unknown, maxChars: number): unknown {
  if (typeof result === 'string') return capSubagentResult(result, maxChars);
  if (Array.isArray(result)) {
    const capped = capArray(result, maxChars);
    // `capArray` refuses to drop the first element, so an array whose leading
    // item alone exceeds the budget comes back over-budget. Re-check and fall
    // back to the valid wrapper (same guarantee the object path already has).
    if (serializedSize(capped) <= maxChars) return capped;
    return truncatedWrapper(result, maxChars);
  }
  if (isPlainObject(result)) {
    const arrKey = largestArrayKey(result);
    if (arrKey) {
      const clone: Record<string, unknown> = { ...result };
      // Budget for the array = total budget minus everything else in the object.
      const restSize = serializedSize({ ...clone, [arrKey]: [] });
      clone[arrKey] = capArray(result[arrKey] as unknown[], Math.max(64, maxChars - restSize));
      if (serializedSize(clone) <= maxChars) return clone;
    }
    return truncatedWrapper(result, maxChars);
  }
  // Primitives (number/boolean/null/undefined) are already tiny — leave as-is.
  return result;
}

/**
 * Bounds a normalized MCP tool result to a character budget before it enters an
 * agent's context (#297). Small results (≤ `maxChars`) are returned untouched —
 * zero added latency/cost. Over-budget results are truncated structure-aware so
 * the model never sees invalid/mid-token JSON. With per-server delegation (#296)
 * on, this shapes each helper's own accumulating loop context; it also bounds
 * the delegation-off direct path.
 */
export function shapeMCPResult(result: unknown, config: MCPResultShapingConfig): unknown {
  if (config.mode === 'off') return result;
  if (serializedSize(result) <= config.maxChars) return result;
  return shapeOverBudget(result, config.maxChars);
}
