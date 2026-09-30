/**
 * Guarantees every string headed to a provider is well-formed UTF-16.
 *
 * A lone surrogate — half of an astral character, left behind when some
 * budget counted in UTF-16 units cut through an emoji — cannot be encoded as
 * UTF-8. xAI answers the whole request `400 Bad Request`, and because the bad
 * string sits in persisted history, every later turn re-sends it and fails the
 * same way: one truncation poisons the session for good. Observed: a watcher's
 * observation block was cut mid-`reactionKey` emoji and the next eight turns
 * over six hours all failed in under a second.
 *
 * Producers are fixed where found (`watchers/wake.ts`, `redact.ts`), but there
 * are many `.slice` budgets between a tool result and a request and nothing
 * stops a new one. So this is enforced ONCE, at the request boundary, and again
 * at `HistoryStore.load` so a file written before the fix heals on resume.
 *
 * Each lone surrogate becomes U+FFFD — what a UTF-8 encoder is required to
 * emit for one anyway, so no information is lost that the wire could carry.
 * Values are returned BY IDENTITY when already well-formed, which is the
 * common case, so the byte-stable prefix the prompt cache relies on (#269) is
 * untouched and nothing is copied.
 */

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** `s` with each lone surrogate replaced by U+FFFD; `s` itself when there are none. */
export function toWellFormedString(s: string): string {
  LONE_SURROGATE.lastIndex = 0;
  if (!LONE_SURROGATE.test(s)) return s;
  LONE_SURROGATE.lastIndex = 0;
  return s.replace(LONE_SURROGATE, '�');
}

const MAX_DEPTH = 64;

/**
 * Deep-repairs every string in a JSON-shaped value, preserving identity for
 * any subtree that needed no change. Non-plain objects (a `Uint8Array` image,
 * a `URL`, a `Date`) are passed through untouched — they carry no text a
 * provider would reject and rebuilding them would lose their type.
 */
export function toWellFormedValue<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return toWellFormedString(value) as T;
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const next = toWellFormedValue(value[i], depth + 1);
      if (next !== value[i]) {
        out ??= value.slice();
        out[i] = next;
      }
    }
    return (out ?? value) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let out: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const next = toWellFormedValue(v, depth + 1);
    if (next !== v) {
      out ??= { ...(value as Record<string, unknown>) };
      out[k] = next;
    }
  }
  return (out ?? value) as T;
}
