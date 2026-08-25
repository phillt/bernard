/**
 * Returns a shallow copy of `args` with any keys listed in `sensitiveArgs`
 * replaced by the string `'[REDACTED]'`. Used to scrub sensitive values out
 * of reasoning logs, cron step logs, and cache keys before they are persisted.
 *
 * Returns `args` unchanged when `sensitiveArgs` is empty/undefined or when
 * `args` is not a plain object.
 */
export const REDACTED = '[REDACTED]' as const;

export function redactArgs(args: unknown, sensitiveArgs: string[] | undefined): unknown {
  if (!sensitiveArgs || sensitiveArgs.length === 0) return args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const copy: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of sensitiveArgs) {
    if (key in copy) copy[key] = REDACTED;
  }
  return copy;
}

/**
 * Item cap applied to any array encountered while bounding a value for
 * persistence. The character budget alone cannot bound an array walk: a
 * replacer that returns `undefined` for an array *element* yields `null` in
 * the output rather than omitting it, so a 500k-element array would still be
 * walked and still produce megabytes of `null,`. Capping the array itself —
 * before its elements are visited — is what makes the walk O(budget).
 */
const MAX_ARRAY_ITEMS = 100;

/**
 * Serializes `value` for persistence while bounding the work done to produce
 * it, and reports whether anything was dropped.
 *
 * The naive `JSON.stringify(v).slice(0, maxLen)` materializes the whole
 * result before discarding almost all of it — measured at ~39 ms and ~20 MB
 * transient for a 10 MB `shell` result (#343). The obvious fix, a replacer
 * that truncates long strings, only covers a *single dominant string*: it
 * does nothing for `file_read_lines` → `{lines: [{num, content}, …]}`, where
 * every `content` is far under the budget and nothing is ever replaced. That
 * shape was measured **slower** than the naive version (183 ms / 75 MB vs
 * 96 ms for 500k lines), because passing a replacer at all drops V8 off
 * `JSON.stringify`'s fast path. Hence both a running character budget and
 * {@link MAX_ARRAY_ITEMS}.
 *
 * `bounded` is what lets a caller distinguish "this fits, keep the real
 * structure" from "this was cut". Length alone cannot answer it: once the
 * budget starts dropping keys the output can come back *under* `maxLen`, and
 * a caller testing only length would then hand back the original unbounded
 * value.
 */
export function boundedStringify(
  value: unknown,
  maxLen: number,
): { text: string; bounded: boolean } {
  let bounded = false;
  // Headroom over `maxLen` for JSON syntax (quotes, commas, braces) so a
  // result that genuinely fits isn't reported as bounded by punctuation alone.
  let budget = maxLen * 2;
  let text: string;
  try {
    text =
      JSON.stringify(value, (_key, v: unknown) => {
        if (budget <= 0) {
          bounded = true;
          return undefined;
        }
        if (typeof v === 'string') {
          budget -= v.length;
          if (v.length > maxLen) {
            bounded = true;
            return v.slice(0, maxLen) + '…';
          }
          return v;
        }
        if (Array.isArray(v) && v.length > MAX_ARRAY_ITEMS) {
          bounded = true;
          return v.slice(0, MAX_ARRAY_ITEMS);
        }
        return v;
      }) ?? String(value);
  } catch {
    // Cycles, BigInt, a throwing `toJSON`. `String(value)` returns the
    // uninformative `[object Object]` for exactly the shapes that reach here —
    // the #343 defect in miniature — so name the failure instead of restating
    // it. Callers must never see a throw: these run on log-write paths.
    return { text: '[unserializable]', bounded: true };
  }
  if (text.length > maxLen) bounded = true;
  return { text, bounded };
}
