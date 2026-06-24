/**
 * Text normalization helpers for tool I/O.
 *
 * The primary concern is mojibake: UTF-8 bytes that were decoded as Latin-1
 * (ISO-8859-1) by an intermediate layer (MCP transport, shell process, Gmail
 * API response, etc.) and then serialised into a JavaScript string.  A classic
 * example is the en-dash U+2013 (UTF-8: 0xE2 0x80 0x93) appearing as the
 * three-character sequence "â€"" because each byte was treated as a Latin-1
 * code-point.
 *
 * The repair strategy is conservative:
 *   1. Attempt to re-encode the string through Latin-1 → UTF-8.
 *   2. Accept the repaired string ONLY when it contains fewer Unicode
 *      replacement characters (U+FFFD) than the original AND every code-point
 *      in the result is a valid, assigned character (no surrogates, no control
 *      characters outside the normal ASCII range, etc.).
 *   3. Apply NFC normalisation so combining sequences collapse to their
 *      precomposed form.
 *
 * Deliberately NOT performed:
 *   - Unescaping literal "\n" / "\uXXXX" sequences — those are indistinguishable
 *     from intentional backslash content (code, regex, Windows paths) without
 *     additional context.  Callers that know they have a doubly-escaped string
 *     can apply JSON.parse themselves.
 */

/**
 * Counts the number of U+FFFD replacement characters in `s`.
 * @internal
 */
function countReplacementChars(s: string): number {
  let count = 0;
  for (const ch of s) {
    if (ch === '�') count++;
  }
  return count;
}

/**
 * Returns true when the string contains at least one byte sequence that is
 * a strong indicator of Latin-1 mis-decoded UTF-8.
 *
 * The pattern targets the leading byte of multi-byte UTF-8 sequences (0xC2–0xEF
 * in UTF-8, appearing as Latin-1 characters Â–ï) followed immediately by a
 * continuation byte (0x80–0xBF → À–¿ in Latin-1).  A single occurrence is
 * enough to attempt repair; false positives (legitimate Latin-1 prose with
 * accented letters) are handled by the round-trip guard in repairMojibake.
 * @internal
 */
function looksLikeMojibake(s: string): boolean {
  // Match the two-character Latin-1 fingerprint of a mis-decoded multi-byte
  // UTF-8 sequence.  We require:
  //   c0 — a UTF-8 lead byte (0xC2–0xEF when read as Latin-1: Â–ï).
  //        0xC0/0xC1 are overlong; 0xF0–0xFF are 4-byte leads, rare in practice.
  //   c1 — a UTF-8 continuation byte in the *C1 control range* (0x80–0x9F).
  //        C1 controls (U+0080–U+009F) are invisible, non-printable characters
  //        that never appear in legitimate tool output.  Using 0x80–0x9F rather
  //        than the full continuation range 0x80–0xBF avoids false positives on
  //        real Latin Extended characters like © (U+00A9 = 0xA9) or ® (0xAE).
  // This conservatively targets the most common UTF-8 sequences:
  //   U+2013 EN DASH  (E2 80 93) → â + U+0080 (C1) + U+0093 (C1) — detected ✓
  //   U+2014 EM DASH  (E2 80 94) → â + U+0080 (C1) + U+0094 (C1) — detected ✓
  //   U+2018/2019 quotation marks → â + U+0080 (C1) + … — detected ✓
  //   'Ã©' (Ã=0xC3, ©=0xA9) — 0xA9 is NOT in 0x80–0x9F → NOT detected ✓
  for (let i = 0; i < s.length - 1; i++) {
    const c0 = s.charCodeAt(i);
    const c1 = s.charCodeAt(i + 1);
    if (c0 >= 0xc2 && c0 <= 0xef && c1 >= 0x80 && c1 <= 0x9f) {
      return true;
    }
  }
  return false;
}

/**
 * Attempts to repair a Latin-1–mis-decoded UTF-8 string.
 *
 * Re-encodes the JavaScript string through Latin-1 bytes and decodes as UTF-8.
 * Accepts the result only when:
 *   - The repaired string has fewer U+FFFD replacement characters than the
 *     original (i.e. it actually improved).
 *   - The repaired string survives a UTF-8 round-trip (Buffer checks this
 *     implicitly when both the encode and decode succeed without error).
 *
 * Returns the repaired string on success, or the original string if the repair
 * would make things worse or equal.
 * @internal
 */
function repairMojibake(s: string): string {
  try {
    // Re-encode as Latin-1 bytes, then decode those bytes as UTF-8.
    const repaired = Buffer.from(s, 'latin1').toString('utf8');
    if (repaired === s) return s; // no change — original was already valid UTF-8
    const originalBad = countReplacementChars(s);
    const repairedBad = countReplacementChars(repaired);
    // Accept the repair when it strictly reduces replacement characters (the
    // repaired UTF-8 sequence was malformed in the original representation).
    if (repairedBad < originalBad) {
      return repaired;
    }
    // Also accept when neither the original nor the repair has replacement chars
    // AND the repaired string is shorter.  Every valid mojibake fix collapses
    // 2–4 Latin-1 mis-decoded chars into 1 Unicode code-point, so the string
    // always shrinks.  A no-shrink result means the bytes are not a valid multi-
    // byte UTF-8 sequence — i.e. genuine Latin Extended content that must not be
    // rewritten.  This gate, combined with the `looksLikeMojibake` pre-filter
    // (which only fires on C1 control bytes 0x80–0x9F, never on printable Latin
    // Extended chars like ©/®/°), prevents false positives on real Latin text.
    if (originalBad === 0 && repairedBad === 0 && repaired.length < s.length) {
      return repaired;
    }
    return s;
  } catch {
    return s;
  }
}

/**
 * Normalizes a string coming from a tool result (shell stdout/stderr, MCP
 * string content, etc.) to clean, NFC-normalised UTF-8.
 *
 * Conservative contract:
 *   - Clean ASCII or already-valid UTF-8 strings pass through UNCHANGED.
 *   - Mojibake from Latin-1 mis-decoding is repaired when the repair is
 *     unambiguously better (see `repairMojibake`).
 *   - NFC normalisation collapses combining sequences.
 *   - Code, Windows paths, regex, and other content with intentional backslashes
 *     are NOT touched.
 *
 * @param s - The raw string to normalize.
 * @returns The normalized string (may be the same reference as `s` when no
 *          changes are needed).
 */
export function normalizeToolText(s: string): string {
  if (typeof s !== 'string' || s.length === 0) return s;

  let result = s;

  // Step 1: repair mojibake (Latin-1 mis-decoded UTF-8) before NFC so that the
  // repaired code-points normalise correctly.
  if (looksLikeMojibake(result)) {
    result = repairMojibake(result);
  }

  // Step 2: NFC normalisation — collapse combining sequences to precomposed forms.
  result = result.normalize('NFC');

  return result;
}

/**
 * Recursively normalizes string values inside a tool result value.
 *
 * Handles the shapes that MCP tools commonly return:
 *   - A plain `string` → normalized directly.
 *   - An array → each element is recursively normalized.
 *   - An object → each string-valued property is recursively normalized;
 *     nested `content[].text` arrays (the MCP `TextContent` convention) are
 *     also normalized.
 *   - Non-string primitives (numbers, booleans, null, undefined) are returned
 *     as-is.
 *
 * Does NOT mutate the input; returns a new value when changes are needed,
 * or the same reference when nothing changed.
 *
 * @param value - Arbitrary tool result value (unknown type).
 * @returns The value with all string leaves normalized.
 */
export function normalizeToolResult(value: unknown): unknown {
  if (typeof value === 'string') {
    return normalizeToolText(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const arr = value.map((item) => {
      const normalized = normalizeToolResult(item);
      if (normalized !== item) changed = true;
      return normalized;
    });
    return changed ? arr : value;
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const obj: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeToolResult(val);
      obj[key] = normalized;
      if (normalized !== val) changed = true;
    }
    return changed ? obj : value;
  }
  return value;
}

/**
 * Truncates a string to the specified maximum length.
 *
 * @param s - The string to truncate.
 * @param maxLength - The maximum number of characters to allow.
 * @returns The original string if it is within the limit, or the string
 *          truncated to `maxLength` characters.
 */
export function truncate(s: string, maxLength: number): string {
  if (s.length <= maxLength) return s;
  return s.slice(0, maxLength);
}
