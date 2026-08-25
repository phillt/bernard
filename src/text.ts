/**
 * Shared single-line truncation: caps `s` at `max` characters, replacing the
 * tail with a single-char ellipsis and trimming trailing whitespace so the
 * cut never reads as `foo …`. The single source of truth for the five
 * renderers that previously carried their own drifting copies (Thread,
 * StatusViewer, SourcesViewer, ModelGridOverlay, agent-status).
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

/**
 * `n === 1 ? one : many`. Trivial, but it was being written inline in 14+
 * renderers with three different spellings, and two more copies landed in a
 * single changeset before this existed. Same rationale as {@link truncate}:
 * one spelling beats fourteen drifting ones.
 */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * `a, b, c +N more` — a bounded preview of a list that could be long.
 *
 * The third private copy of this idea prompted the move here; the other two
 * (`sampleNames` in `tools/mcp-verify.ts`, the inline pair in `tools/delegate.ts`)
 * predate it and each render a different format. New callers should use this.
 */
export function nameList(names: string[], limit = 3): string {
  const head = names.slice(0, limit).join(', ');
  const rest = names.length - limit;
  return rest > 0 ? `${head} +${rest} more` : head;
}

/**
 * Conservative range of C1 control characters (U+0080–U+009F).
 * These are invisible bytes that appear in strings incorrectly decoded as
 * Latin-1 (ISO-8859-1) when the content was actually UTF-8.  They never
 * appear legitimately in natural-language text, so their presence is a
 * reliable signal that the string is mis-decoded mojibake.
 *
 * Common mojibake patterns seen in practice:
 *   – (U+2013 EN DASH)     → "â€"" (0xE2 0x80 0x93 decoded as Latin-1 → Ã¢â‚¬â€œ)
 *   — (U+2014 EM DASH)     → "â€"" (0xE2 0x80 0x94)
 *   ' (U+2018 LEFT QUOTE)  → "â€˜"
 *   ' (U+2019 RIGHT QUOTE) → "â€™"
 *   " (U+201C LEFT DQUOTE) → "â€œ"
 *   " (U+201D RIGHT DQUOTE)→ "â€"
 *
 * The gate strategy:
 *   1. Only attempt repair when C1 bytes are present (0x80–0x9F as code
 *      points when the string has already been JS-decoded from Latin-1).
 *   2. Only ACCEPT the repair when it introduces zero U+FFFD replacement
 *      characters AND the repaired string is shorter (multi-byte sequences
 *      collapse, shrinking character count).
 *   3. Apply NFC normalization unconditionally so combining characters and
 *      equivalent code-point sequences are in canonical form.
 *
 * This avoids false-positives on printable Latin Extended characters that
 * are legitimately in the data (©, ®, ½, etc.) because re-interpreting
 * those as UTF-8 always produces U+FFFD — the "only accept when no FFFD"
 * gate catches them.
 *
 * Literal escape un-escaping (\n, \uXXXX) is intentionally omitted: the
 * risk of breaking legitimate backslash content (code, regex, Windows paths)
 * outweighs the benefit.  Callers that know their input is JSON-escaped may
 * apply JSON.parse to a quoted string before passing here.
 */

/**
 * Classify `s` in a single pass:
 *   - returns `'ascii'` when every code point is ≤ 0x7F (pure ASCII — already
 *     in NFC by definition, no mojibake possible);
 *   - returns `'c1'` when at least one code point is in the C1 range
 *     (U+0080–U+009F) — a reliable mojibake signal;
 *   - returns `'unicode'` for any other non-ASCII content (valid multibyte
 *     chars like é, ™, etc.) that only needs NFC normalization.
 */
function classifyString(s: string): 'ascii' | 'c1' | 'unicode' {
  let hasNonAscii = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x80) {
      hasNonAscii = true;
      if (c <= 0x9f) return 'c1';
    }
  }
  return hasNonAscii ? 'unicode' : 'ascii';
}

/**
 * Normalize a single tool output string.
 *
 * - Empty strings and pure-ASCII strings are returned as-is (no NFC needed,
 *   no mojibake possible — avoids any allocation on the common case).
 * - Always applies Unicode NFC normalization when non-ASCII chars are present.
 * - Attempts UTF-8-decoded-as-Latin-1 mojibake repair when C1 control bytes
 *   (U+0080–U+009F) are detected; only accepts the repair when it introduces
 *   no U+FFFD replacement characters and shrinks the string (sign of successful
 *   multi-byte reassembly).
 *
 * This function is intentionally conservative: clean ASCII, valid UTF-8,
 * and printable Latin Extended characters (©, ®, …) pass through unchanged.
 */
export function normalizeToolText(s: string): string {
  // Fast-paths: empty string and pure ASCII are already in NFC.
  if (s.length === 0) return s;
  const kind = classifyString(s);
  if (kind === 'ascii') return s;

  if (kind === 'c1') {
    try {
      // Re-interpret the string's raw code points as UTF-8 bytes.
      const repaired = Buffer.from(s, 'latin1').toString('utf8');
      // Accept only when no replacement chars were introduced AND the string
      // shrank (multi-byte reassembly always reduces char count).
      if (!repaired.includes('�') && repaired.length < s.length) {
        return repaired.normalize('NFC');
      }
    } catch {
      // Buffer conversion failure is unexpected but should never crash the
      // caller — fall through to NFC normalization of the original string.
    }
  }
  return s.normalize('NFC');
}

/**
 * Recursively normalize all string values inside a tool result value.
 *
 * - Strings are passed through {@link normalizeToolText}.
 * - Arrays have every element normalized recursively.
 * - Plain objects have every string-valued property normalized recursively.
 * - Non-string primitives and class instances are returned as-is.
 *
 * This is applied to MCP tool results which may contain arbitrary JSON shapes
 * such as `{content: [{type:'text', text:'...'}]}` from Gmail / Calendar.
 */
export function normalizeToolResult(v: unknown): unknown {
  if (typeof v === 'string') return normalizeToolText(v);
  if (Array.isArray(v)) return v.map(normalizeToolResult);
  if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      out[key] = normalizeToolResult(val);
    }
    return out;
  }
  return v;
}
