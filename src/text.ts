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
 * A knowledge fence, rendered for a human (#511).
 *
 * Deliberately NOT {@link nameList}: a fence must be shown WHOLE. `+N more`
 * would hide the very entries someone is reading the line to check, and the one
 * thing worse than a fence you cannot see is a fence you think you can.
 *
 * The empty case is the reason this is shared rather than inlined a fourth
 * time. `[]` is a real posture — deny-all — so it must read as one; the three
 * existing sites had already spelled it two different ways (`(nothing)` in the
 * refusal and in `specialist inspect`, `(none)` in the dispatch viewer) on the
 * day the idiom was introduced.
 */
export function scopeList(patterns: readonly string[]): string {
  return patterns.length > 0 ? patterns.join(', ') : '(nothing)';
}

/**
 * Mojibake repair: UTF-8 bytes that were decoded as a single-byte code page.
 *
 * ## What actually happens, measured
 *
 * An em dash `—` (U+2014) is the bytes `E2 80 94`. A consumer that decodes them
 * as a single-byte code page and re-encodes as UTF-8 produces three characters
 * where there was one. Do it twice and you get six. The observed data has cases
 * stacked FOUR deep, from a subject line that went out and came back repeatedly.
 *
 * The predecessor of this code assumed the wrong code page and therefore **never
 * once fired on real input**. It gated on a C1 code point (U+0080–U+009F), the
 * Latin-1 signature. Real-world mojibake is almost always **CP1252**, which maps
 * those byte positions to printable characters instead — `0x80` is `€` (U+20AC),
 * `0x94` is `”` (U+201D), `0x92` is `’`. Measured across this install's session
 * logs, the real sequences contain zero C1 code points:
 *
 *     single-encoded em dash:  U+00E2 U+20AC U+201D
 *     double-encoded em dash:  U+00C3 U+00A2 U+00C2 U+20AC U+00C2 U+201D
 *
 * so `classifyString` answered `'unicode'`, the repair block was skipped, and a
 * bare `.normalize('NFC')` ran. The tests were green because they synthesized the
 * Latin-1 form with `Buffer.from(s,'utf8').toString('latin1')` — including the one
 * named "the exact observed mojibake example", which did not reproduce the
 * observed bytes. Do not reintroduce a Latin-1-only helper into the tests.
 *
 * `Buffer.from(s, 'latin1')` cannot express the fix either: it truncates each code
 * point to its low byte, so U+20AC becomes `0xAC` rather than `0x80`. Hence
 * {@link CP1252_TO_BYTE}.
 *
 * ## Why detection matches SEQUENCES, not characters
 *
 * This is the load-bearing decision. Widening the gate to "contains a character
 * CP1252 maps" would fire on almost all prose — `€`, `—`, `’` and `…` are ordinary
 * (this install's own data holds 952 em dashes and 1045 curly quotes in perfectly
 * correct strings), and the old C1 gate was self-limiting only because C1 code
 * points never appear in real text.
 *
 * So a candidate is a UTF-8 **lead** character followed by the right number of
 * **continuation** characters — the shape mojibake has and prose does not.
 * `café €5` contains both `é` and `€` and matches nothing, because no lead is
 * followed by a continuation. `â€”` matches.
 *
 * ## What actually makes this safe
 *
 * Two guards, and NEITHER is the pair the predecessor had. This section used to
 * claim the old acceptance gates were "unchanged and still doing real work" —
 * "a repair is kept only when it introduces no U+FFFD **and** the string got
 * shorter". Both are gone from the code, and a reader deciding whether it is safe
 * to widen detection would have been pointed at two guards that cannot catch
 * anything:
 *
 *  - the **U+FFFD** check is subsumed by decoding each candidate with
 *    `TextDecoder(…, { fatal: true })`, which throws per match instead of
 *    producing a replacement character to notice afterwards;
 *  - the **shrink** check is unreachable, because per-match replacement shrinks
 *    by construction — the shortest candidate is two characters and the longest
 *    decode is one. It was doing real work only for the predecessor, which
 *    rebuilt the whole string as one byte stream. A mutation proved it dead.
 *
 * What carries the safety now is {@link strongMatches} — a candidate must look
 * like mojibake and not merely decode like it — and `IMPLAUSIBLE`, which refuses
 * a decode landing on an unassigned, private-use or surrogate code point. Widen
 * either of those and this paragraph is the one to re-read.
 *
 * Literal escape un-escaping (`\n`, `\uXXXX`) remains deliberately out of scope —
 * the risk to code, regexes and Windows paths outweighs it.
 */

/**
 * The 27 printable characters CP1252 assigns to byte positions 0x80–0x9F.
 *
 * Written as a code-point → byte map because that is the direction repair needs
 * and no Node encoding provides it. The five unassigned positions (0x81, 0x8D,
 * 0x8F, 0x90, 0x9D) are absent, which is correct: nothing decodes to them.
 */
const CP1252_TO_BYTE = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

/**
 * The byte a character would have been, or `-1` if it could not have been one.
 *
 * U+0080–U+00FF map to themselves, which is what keeps the older Latin-1 form
 * working through the same machinery rather than a second branch.
 */
function byteFor(codePoint: number): number {
  const cp1252 = CP1252_TO_BYTE.get(codePoint);
  if (cp1252 !== undefined) return cp1252;
  return codePoint <= 0xff ? codePoint : -1;
}

/** A UTF-8 lead byte, and how many continuations it claims. 0 when it is not one. */
function sequenceLength(b: number): number {
  if (b >= 0xc2 && b <= 0xdf) return 1;
  if (b >= 0xe0 && b <= 0xef) return 2;
  if (b >= 0xf0 && b <= 0xf4) return 3;
  return 0;
}

const isContinuation = (b: number): boolean => b >= 0x80 && b <= 0xbf;

/** Rejects a decode that is structurally valid but cannot be real text. */
const IMPLAUSIBLE = /\p{Cn}|\p{Co}|\p{Cs}/u;

/** Adjacent two-character matches before a run counts as evidence. See {@link hasStrongMojibake}. */
const STRONG_RUN = 3;

/** One candidate: `[start, end)` and the character it would decode to. */
interface Candidate {
  start: number;
  end: number;
  decoded: string;
}

/** Every position in `s` shaped like a UTF-8 character a single-byte decoder mangled. */
function findCandidates(s: string): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < s.length; i++) {
    const lead = byteFor(s.charCodeAt(i));
    const want = lead < 0 ? 0 : sequenceLength(lead);
    if (want === 0 || i + want >= s.length) continue;

    const run = [lead];
    for (let k = 1; k <= want; k++) {
      const cont = byteFor(s.charCodeAt(i + k));
      if (cont < 0 || !isContinuation(cont)) break;
      run.push(cont);
    }
    if (run.length !== want + 1) continue;

    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(run));
    } catch {
      continue; // overlong, surrogate or truncated — not a repair
    }
    // Structurally valid but unassigned / private-use is not real text.
    if (IMPLAUSIBLE.test(decoded)) continue;

    out.push({ start: i, end: i + want + 1, decoded });
    i += want;
  }
  return out;
}

/**
 * Whether the string carries EVIDENCE that it is mojibake, rather than merely
 * containing something shaped like it.
 *
 * **This gate is why the repair is safe, and it was learned the hard way.** The
 * sequence match alone is not enough: a two-character match is indistinguishable
 * from two adjacent legitimate characters. Measured against a first cut that had
 * only the sequence match plus the acceptance gates below:
 *
 *     "JOSÉ’s car"   ->  "JOSɒs car"     É is a UTF-8 lead, ’ is a continuation
 *     "Use 2×½ cup"  ->  "Use 2׽ cup"    × is a lead, ½ is a continuation
 *     "«ÉTÉ»"        ->  "«ÉTɻ"
 *
 * Every one of those decodes cleanly, SHRINKS the string and introduces no
 * U+FFFD — so the acceptance gates cannot catch them. Six of eight legitimate
 * adversarial strings were corrupted. A missed repair costs legibility; a false
 * repair costs data, and that asymmetry decides the design.
 *
 * **Strength is a property of the MATCH, not of the string**, and getting that
 * wrong put both pinned corruptions straight back. The gate was originally a
 * whole-string boolean — one strong match vouched for everything — and the loop
 * below then replaced every candidate, including the two-character weak ones the
 * gate exists to protect. Measured:
 *
 * ```
 * in : "Subject: CafÃ© news — from JOSÉ's car"
 * out: "Subject: Café news — from JOSɒs car"
 * ```
 *
 * `Ã©` is strong by rule 2, which licensed corrupting a name three words away.
 * The tests pinned `JOSÉ's car` and `«ÉTÉ»` in isolation, which is the one shape
 * where a whole-string gate works — and mixed is the normal shape for this data:
 * a thread whose subject went through a broken hop while the body is clean, a
 * scraped page with one mangled field, an MCP result concatenating two sources.
 * So a strong match now vouches for ITSELF, and weak candidates are left
 * byte-identical beside it.
 *
 * A match is STRONG when one of these holds:
 *
 *  1. its continuation is a raw C1 code point (U+0080–U+009F) — these never occur
 *     in real text, which is why the predecessor's gate was safe by accident;
 *  2. its lead is `Â` or `Ã`, i.e. UTF-8 leads `0xC2`/`0xC3`, which cover
 *     U+0080–U+00FF — Latin-1 Supplement, and nothing beyond it. Neither precedes
 *     a symbol in legitimate text (`AÇÃO` has `Ã` before an ASCII `O`);
 *  3. it is three or four characters long: an accented letter followed by two or
 *     three symbols does not occur naturally;
 *  4. three or more matches sit adjacent, which recovers Cyrillic and Greek
 *     mojibake — those produce neither C1 characters nor `Â`/`Ã`. Two is not
 *     enough: `Ø¼Ø½ sizes` is two adjacent matches of perfectly good text. This
 *     one is a property of the RUN, so it marks every member of a qualifying one.
 *
 * **Known gap, stated because the previous wording hid it.** Rule 2 used to claim
 * `Â`/`Ã` covered "most of Latin Extended-A". They do not: that block is
 * U+0100–U+017F, whose leads are `0xC4`/`0xC5` → the mojibake characters `Ä` and
 * `Å`, which no rule matches. So a single Polish, Croatian, Turkish or Hungarian
 * accented character surrounded by ASCII is found as a candidate, decodes
 * cleanly, and is left alone — `GdaÅ„sk`, `Ä†evapi`, `Ä°stanbul` and `ErdÅ‘s` all
 * survive unrepaired. `DvoÅ™Ã¡k` looks like a counterexample and is not: it
 * repairs through its `Ã¡`, not its `Å™`. Widening rule 2 to those leads is a
 * real option and a separate decision — it trades this miss against false
 * positives on `Ä`/`Å` followed by punctuation — and it is not taken here.
 */
function strongMatches(s: string, candidates: readonly Candidate[]): boolean[] {
  const strong = candidates.map((c) => {
    if (c.end - c.start >= 3) return true;
    const cont = s.charCodeAt(c.start + 1);
    if (cont >= 0x80 && cont <= 0x9f) return true;
    const lead = s.charCodeAt(c.start);
    return lead === 0x00c2 || lead === 0x00c3;
  });
  // Rule 4 reads over a run, so it is applied after the per-match rules and marks
  // the whole run rather than the character that happened to close it.
  let runStart = 0;
  for (let i = 0; i <= candidates.length; i++) {
    const adjacent =
      i > 0 && i < candidates.length && candidates[i].start === candidates[i - 1].end;
    if (adjacent) continue;
    if (i - runStart >= STRONG_RUN) for (let j = runStart; j < i; j++) strong[j] = true;
    runStart = i;
  }
  return strong;
}

/**
 * One repair pass: replaces each candidate in place, leaving every other
 * character byte-identical.
 *
 * Per match rather than rebuilding the whole string as one byte stream, which
 * the first cut did and which fails on exactly the data this exists for — any
 * emoji, CJK character or unrelated symbol makes the whole stream invalid, so one
 * unrelated character abandons the entire repair.
 */
function repairOnce(s: string): string {
  const candidates = findCandidates(s);
  if (candidates.length === 0) return s;
  const strong = strongMatches(s, candidates);
  if (!strong.some(Boolean)) return s;

  let out = '';
  let at = 0;
  for (let i = 0; i < candidates.length; i++) {
    // A weak candidate is skipped, not replaced — so it stays byte-identical and
    // the slice below carries it through untouched.
    if (!strong[i]) continue;
    const c = candidates[i];
    out += s.slice(at, c.start) + c.decoded;
    at = c.end;
  }
  out += s.slice(at);
  // No "did it shrink?" acceptance check: per-match replacement always shrinks by
  // construction — the shortest candidate is two characters and the longest decode
  // is one (two for an astral pair, from a four-character match). The predecessor
  // rebuilt the whole string as one byte stream, where that check was doing real
  // work; here it is unreachable, and a mutation proved it.
  return out;
}

/**
 * How many times a repair pass may run.
 *
 * The observed worst case is quadruple-stacked, from a mail thread sent and read
 * back several times. Termination does not depend on this — every accepted pass
 * strictly shrinks the string — but a fixed bound means a pathological input
 * cannot spin.
 *
 * **The consequence is that `normalizeToolText` is not idempotent past the
 * bound**, which is worth knowing because three boundaries now call it and
 * "already normalized" is therefore not a safe assumption anywhere. Measured, by
 * mangling `"Meeting — notes"` N times and normalizing once:
 *
 * ```
 * depth 1-6: f(x) === f(f(x)), fully repaired
 * depth 7:   f(x) = "Meeting â€” notes"      f(f(x)) = "Meeting — notes"
 * depth 8:   f(x) = "Meeting Ã¢â‚¬â€ notes"  f(f(x)) = "Meeting — notes"
 * ```
 *
 * Raising the bound moves the depth at which this starts and does not remove it,
 * and `if (next === out) break` below already finds the fixed point whenever one
 * is within reach — the bound only truncates. Left as a bound, because a string
 * stacked seven deep is a different problem from the one this fixes and a second
 * pass over the same text costs nothing. Within the bound there is no
 * oscillation and no growth: 400k random strings drawn from UTF-8 leads,
 * continuations, CP1252 punctuation and ASCII produced zero of either.
 */
const MAX_REPAIR_PASSES = 6;

/**
 * Normalize a single tool output string.
 *
 * Repairs mojibake (see the block above) and applies NFC. Pure ASCII returns
 * immediately — the overwhelmingly common case, and no allocation.
 *
 * Conservative by construction: valid UTF-8, accented text, CJK, emoji and
 * printable Latin-1 (`©`, `®`, `½`) all pass through untouched, pinned by tests.
 */
export function normalizeToolText(s: string): string {
  if (s.length === 0) return s;
  let hasNonAscii = false;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) return s;

  let out = s;
  try {
    for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
      const next = repairOnce(out);
      if (next === out) break;
      out = next;
    }
  } catch {
    // A Buffer conversion failure must never reach the caller; the NFC below
    // still runs on whatever we have.
  }
  return out.normalize('NFC');
}

/**
 * Replaces typographic characters with their exact ASCII equivalents (#mojibake).
 *
 * **Why this exists when {@link normalizeToolText} already repairs mojibake.**
 * Repair cleans up after a consumer that mangled our bytes; it cannot stop the
 * next one. The motivating case was a Gmail MCP server writing raw UTF-8 into a
 * `Subject:` header, where RFC 5322 requires US-ASCII — so a perfectly ordinary
 * em dash came back as `Ã¢Â€Â”`. That server is fixable, and was fixed. The next
 * third-party server is not, so the only deterministic defence is to hand it
 * nothing that can break.
 *
 * **Typographic only, and the boundary is not arbitrary.** Every entry here has an
 * exact ASCII equivalent that a reader would accept without noticing — these are
 * flourishes a model adds, not content. Accented letters, CJK, emoji and currency
 * signs are deliberately ABSENT: they would break in a naive consumer exactly the
 * same way, and folding them destroys meaning rather than preserving it. `é`
 * cannot become `e` and `€` cannot become `EUR` on Bernard's initiative. A test
 * pins their absence, because the tempting "while we're here" edit is to add them.
 *
 * Idempotent, and a no-op on pure ASCII with no allocation.
 */
const TYPOGRAPHY: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2013\u2014\u2015]/g, '-'], // en dash, em dash, horizontal bar
  [/[\u2018\u2019\u201a\u201b]/g, "'"], // single curly quotes
  [/[\u201c\u201d\u201e\u201f]/g, '"'], // double curly quotes
  [/\u2026/g, '...'], // ellipsis
  [/[\u00a0\u202f\u2009\u2007]/g, ' '], // no-break, narrow no-break, thin, figure space
  [/[\u2022\u2023\u25cf\u25aa]/g, '*'], // bullets
  [/\u2039/g, '<'],
  [/\u203a/g, '>'],
  [/\u2032/g, "'"], // prime
  [/\u2033/g, '"'], // double prime
  [/\u2212/g, '-'], // minus sign
];

export function foldTypography(s: string): string {
  if (s.length === 0) return s;
  let hasNonAscii = false;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) return s;
  let out = s;
  for (const [pattern, replacement] of TYPOGRAPHY) out = out.replace(pattern, replacement);
  return out;
}

/**
 * {@link foldTypography} over every string in a value, for a tool's ARGUMENTS.
 *
 * Mirrors {@link normalizeToolResult}'s walk — same plain-object check, so a class
 * instance passes through rather than being rebuilt as a bare object.
 */
export function foldTypographyDeep(value: unknown): unknown {
  if (typeof value === 'string') return foldTypography(value);
  if (Array.isArray(value)) return value.map(foldTypographyDeep);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = foldTypographyDeep(v);
    return out;
  }
  return value;
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

/**
 * XML-escapes a string for interpolation into a markup-ish payload.
 *
 * A leaf, because both consumers are: `context-message.ts` escapes untrusted
 * provenance labels into the `<available_sources>` block (OWASP LLM01 — the
 * reason that block is user-role rather than SYSTEM), and `host/webmanifest.ts`
 * escapes an app name into a generated SVG. Neither can import the other —
 * `context-message.ts` reaches `reference-resolver` and so `generateText` and
 * `config`, which is precisely the edge a host leaf must not acquire — so the
 * three replaces live here rather than being hand-copied a third time.
 */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
