/**
 * Stage 1 of speech text normalization (#432) — the pure, deterministic half.
 *
 * The problem has a name: **TTS text normalization**, or *verbalization* —
 * converting a **written form** into the **spoken form** a person would say
 * aloud. Its unit is the **semiotic class**, the category that decides how a
 * token is read: `$12.50` is currency ("twelve dollars and fifty cents"),
 * `206-555-0198` is a phone number ("two oh six, five five five, …"). The same
 * characters take different spoken forms per class — `2026` is "twenty
 * twenty-six" as a year, "two thousand twenty-six" as a quantity, "two zero two
 * six" as an identifier. (The inverse direction, "twenty-five dollars" → `$25`,
 * is *inverse* text normalization and belongs to speech-to-text; the planned STT
 * follow-up must not be pointed at this module.)
 *
 * ## The layer boundary is ambiguity, not difficulty
 *
 * A class is either decidable from surface form or it is not. `$` names its own
 * class; a `ddd-ddd-dddd` separator pattern names its own class; `e.g.` is a
 * closed set. Those are handled here, for free, with no way to hallucinate.
 * Whether `2026` is a year, whether a URL should be named ("a Mac Rumors article
 * on the M5 Max") rather than spelled, and which rows of a table matter are all
 * *semantic* questions, and they go to {@link ../speech-normalizer.js}.
 *
 * Two rules follow, and both are load-bearing:
 *
 * 1. **This stage must PRESERVE the ambiguous material, not reduce it.** If it
 *    collapsed a URL to its host, the model could never name the referent and
 *    the LLM layer would be decoration. So URLs, tables and unmarked numbers
 *    survive verbatim and are recorded in `unresolved`, which is also what the
 *    skip predicate reads to decide whether a round trip is worth making.
 * 2. **Never touch a bare digit run.** A TTS engine's default reading of a
 *    number is a cardinal, which is *correct* for quantities — so the only
 *    numbers worth rewriting are the ones where a cardinal is wrong, and those
 *    are exactly the ones that carry a class marker. A digit-grouping heuristic
 *    applied to unmarked runs reads `1,200 users` as "one two zero zero users".
 *    Leaving it alone yields "one thousand two hundred users", which is right.
 *
 * That second rule is also why almost nothing here spells a number into words:
 * we re-shape numbers so the engine's own cardinal reading lands correctly, and
 * only insert digit separators for the classes (phone) that must be read out
 * digit by digit.
 *
 * ## Why a pure leaf
 *
 * No `ai`, no `config`, no React, no `node:*` — so its test drags none of them
 * in. Same split as `line-geometry.ts` vs `use-line-editor.tsx` and the reason
 * `tool-bytes.ts` and `mcp-names.ts` exist as leaves.
 */

/** The semiotic classes this module can recognize. */
export type SemioticClass =
  | 'url'
  | 'email'
  | 'phone'
  | 'currency'
  | 'measurement'
  | 'date'
  | 'number'
  | 'identifier'
  | 'path'
  | 'code'
  | 'table';

export interface SpeechText {
  /**
   * Markup stripped and the surface-decidable classes verbalized in place.
   * Line structure is preserved (tables are still pipe rows) so
   * {@link reduceUnresolved} can still see it; {@link clampForSpeech} is the
   * separate, final gate that flattens for argv.
   */
  spokenForm: string;
  /**
   * Classes still present that only a model can resolve. Empty means stage 1
   * answered everything and the LLM round trip buys nothing.
   */
  unresolved: SemioticClass[];
}

/**
 * Hard ceiling on what reaches a TTS backend. Also closes a latent bug:
 * `buildSpeakCommand`'s `windows-speech` branch interpolates the whole text
 * into a PowerShell `-Command` argument, and Windows caps a command line at
 * 32,767 characters — nothing bounded an assistant reply before this.
 */
export const SPEECH_MAX_CHARS = 3000;

/**
 * Below this, the round trip costs more latency than it buys naturalness.
 * Deliberately low: `'nothing-ambiguous'` is the guard that actually keeps the
 * call count down, and it already clears most turns. This one only exists so a
 * sub-sentence reply doesn't pay a round trip to name one link.
 */
const MIN_NORMALIZE_CHARS = 40;

/** Appended when the source was cut, so a listener knows they got a prefix. */
export const TRUNCATION_MARKER = ' … message truncated.';

/** Stands in for a fenced block. Its contents are never spoken. */
const CODE_SENTINEL = 'Code block omitted.';

/** `\`\`\`bash` → "A bash code block, omitted." — the info string is free context. */
export function codeSentinel(lang?: string): string {
  const l = lang?.trim();
  return l ? `A ${l} code block, omitted.` : CODE_SENTINEL;
}

/** Rows of a table read aloud by {@link reduceUnresolved} before it summarizes. */
const MAX_SPOKEN_TABLE_ROWS = 5;

/**
 * Closed-set expansions, written → spoken, applied in order. Deliberately
 * small: every entry has exactly one correct reading, which is what makes them
 * safe to do without a model. Units and abbreviations are one table because
 * nothing branches on the distinction — units are digit-bound and abbreviations
 * are word- or symbol-bound, so they cannot interact.
 */
const EXPANSIONS: ReadonlyArray<[RegExp, string]> = [
  // Units — only when bound to a digit, so a stray "ms" in prose is untouched.
  [/(\d)\s?km\b/g, '$1 kilometers'],
  [/(\d)\s?cm\b/g, '$1 centimeters'],
  [/(\d)\s?mm\b/g, '$1 millimeters'],
  [/(\d)\s?kg\b/g, '$1 kilograms'],
  [/(\d)\s?ms\b/g, '$1 milliseconds'],
  [/(\d)\s?TB\b/g, '$1 terabytes'],
  [/(\d)\s?GB\b/g, '$1 gigabytes'],
  [/(\d)\s?MB\b/g, '$1 megabytes'],
  [/(\d)\s?KB\b/g, '$1 kilobytes'],
  [/(\d)\s?GHz\b/g, '$1 gigahertz'],
  [/(\d)\s?MHz\b/g, '$1 megahertz'],
  [/(\d)\s?°C\b/g, '$1 degrees Celsius'],
  [/(\d)\s?°F\b/g, '$1 degrees Fahrenheit'],
  [/(\d)\s?%/g, '$1 percent'],
  // Abbreviations and symbols.
  [/\be\.g\.(?=\s|$)/gi, 'for example'],
  [/\bi\.e\.(?=\s|$)/gi, 'that is'],
  [/\betc\.(?=\s|$)/gi, 'et cetera'],
  [/\bvs\.?(?=\s|$)/gi, 'versus'],
  [/\bapprox\.(?=\s|$)/gi, 'approximately'],
  [/≈/g, ' approximately '],
  [/[≥]/g, ' at least '],
  [/[≤]/g, ' at most '],
  [/(\s)->(\s)/g, '$1to$2'],
  [/(\s)→(\s)/g, '$1to$2'],
  [/(\s)&(\s)/g, '$1and$2'],
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `| a | b |` — a table row. */
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
/** `|---|:--:|` — the header rule, which is never spoken. */
const TABLE_RULE_RE = /^\s*\|[\s:|-]+\|\s*$/;

/**
 * Must not swallow the sentence's own punctuation: `…/pricing.` would otherwise
 * match through the full stop, and reducing it to a host would delete the period
 * along with the URL, running two sentences together. So the match is required
 * to END on a character a URL can plausibly end on.
 */
const URL_RE = /\bhttps?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]|\bwww\.[^\s<>()]*[^\s<>().,;:!?'"]/gi;
const PATH_RE = /(?:^|\s)(\/(?:[\w.-]+\/){2,}[\w.-]+)/g;
const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)+\b/g;
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;
const ISSUE_RE = /#\d+\b/g;
/**
 * A bare run of 4+ digits. Comma-grouped numbers (`1,200`) never match, because
 * no group exceeds three digits — which is exactly why the tagging scan runs
 * BEFORE comma stripping. See rule 2 in the module docs.
 */
const BARE_NUMBER_RE = /\b\d{4,}\b/g;
/** Ambiguous slash date — `9/2/2026` is September 2nd or February 9th. */
const SLASH_DATE_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;

/** Emoji, dingbats, arrows and box drawing — an engine narrates their names. */
const PICTOGRAPH_RE =
  /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2500}-\u{257F}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}️]/gu;

/** Spells a digit string out one digit at a time: `206` → `2 0 6`. */
function spellDigits(digits: string): string {
  return digits.split('').join(' ');
}

/**
 * Strips markdown syntax. Fenced blocks go first so their contents are never
 * subjected to any later pass — and are never spoken at all.
 */
function stripMarkup(text: string): string {
  let out = text;

  // Fenced code — contents dropped entirely, replaced by a spoken sentinel
  // carrying the fence's info string, which is free information and the only
  // part of a code block worth hearing.
  //
  // Note this deliberately does NOT tag `'code'` as unresolved. The contents are
  // gone by design, so there is nothing left for a model to describe, and
  // tagging it would send every reply containing a fence on a round trip that
  // could not improve the result.
  const fence = (lang: string | undefined) => `\n${codeSentinel(lang)}\n`;
  out = out.replace(/```([A-Za-z0-9_+-]*)[^\n]*\n[\s\S]*?```/g, (_m, lang: string) => fence(lang));
  // An unterminated fence (a truncated reply) would otherwise leak its body.
  out = out.replace(/```([A-Za-z0-9_+-]*)[\s\S]*$/g, (_m, lang: string) => fence(lang));
  // Inline code keeps its contents; only the delimiters are noise.
  out = out.replace(/`([^`\n]*)`/g, '$1');

  // Citation markers (#248) and footnote definitions — the single most jarring
  // thing spoken today, and pure syntax.
  out = out.replace(/\[\^[^\]]+\]:?/g, '');

  // Images before links: `![alt](url)` must not be read as a link labelled "!".
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // A markdown link's label IS the human-readable referent, so no url tag here.
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  out = out.replace(/<[^>\n]+>/g, ''); // raw HTML
  out = out.replace(/^\s*>+\s?/gm, ''); // blockquote markers
  out = out.replace(/^\s*(?:[-*_]\s*){3,}$/gm, ''); // horizontal rules

  // Headings and list items become sentences so the backend pauses between them.
  out = out.replace(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/gm, (_m, body: string) => endSentence(body));
  out = out.replace(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/gm, (_m, body: string) => endSentence(body));

  // Emphasis delimiters, contents kept.
  out = out.replace(/(\*\*\*|___)(\S(?:.*?\S)?)\1/g, '$2');
  out = out.replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '$2');
  out = out.replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2');
  out = out.replace(/~~(\S(?:.*?\S)?)~~/g, '$1');

  return out;
}

/** Adds terminal punctuation unless the line already ends a sentence. */
function endSentence(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  return /[.!?:;,]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Verbalizes the classes whose reading is decidable from surface form alone. */
function verbalizeClosedClasses(text: string): string {
  let out = text;

  // Email before URL — an address is not a link, and `@` disambiguates it.
  out = out.replace(
    /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    (_m, user: string, host: string) => {
      const say = (s: string) =>
        s.replace(/\./g, ' dot ').replace(/_/g, ' underscore ').replace(/-/g, ' dash ');
      return `${say(user)} at ${say(host)}`;
    },
  );

  // Currency. The digits are left for the engine to read as a cardinal, which is
  // the correct reading for an amount — only the sigil needs moving.
  out = out.replace(
    /\$\s?(\d[\d,]*)(?:\.(\d{2}))?\b/g,
    (_m, whole: string, cents: string | undefined) => {
      // Commas are deliberately LEFT here. `tagUnresolved` runs after this pass
      // and keys "ambiguous number" on a run of 4+ bare digits; stripping the
      // grouping now would turn `$1,200` into `1200` and mis-tag a quantity
      // whose cardinal reading was already correct. The global strip at the end
      // of `toSpeechText` handles it, after the scan.
      const w = whole;
      const unit = w === '1' && !cents ? 'dollar' : 'dollars';
      if (!cents) return `${w} ${unit}`;
      const c = String(Number(cents));
      return `${w} ${unit} and ${c} ${c === '1' ? 'cent' : 'cents'}`;
    },
  );

  // Phone. The one class that must be read digit by digit.
  out = out.replace(
    /(?:\+?1[-. ])?\(?(\d{3})\)?[-. ](\d{3})[-. ](\d{4})\b/g,
    (_m, a: string, b: string, c: string) =>
      `${spellDigits(a)}, ${spellDigits(b)}, ${spellDigits(c)}`,
  );

  // ISO dates are unambiguous; the slash forms are not and stay for the model.
  out = out.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => {
    const month = MONTHS[Number(mo) - 1];
    if (!month) return m;
    return `${month} ${Number(d)}, ${y}`;
  });

  for (const [re, to] of EXPANSIONS) out = out.replace(re, to);

  return out;
}

/**
 * Every class stage 1 can leave for the model, and the pattern that spots it.
 *
 * Deliberately **non-global** copies: a `g` regex carries `lastIndex` across
 * `.test`, so scanning with the same objects the `.replace` calls use needs a
 * reset loop that a new entry can silently forget. Only `URL_RE` and `PATH_RE`
 * need `g` at all, and only in {@link reduceUnresolved}.
 */
const UNRESOLVED_TAGS: ReadonlyArray<[RegExp, SemioticClass]> = [
  [scanner(URL_RE), 'url'],
  [scanner(PATH_RE), 'path'],
  [scanner(VERSION_RE), 'identifier'],
  [scanner(SHA_RE), 'identifier'],
  [scanner(ISSUE_RE), 'identifier'],
  [scanner(SLASH_DATE_RE), 'date'],
  [scanner(BARE_NUMBER_RE), 'number'],
];

/** A stateless `.test`-only twin of a `g` pattern. */
function scanner(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.replace('g', ''));
}

/**
 * Records every class that survives stage 1 and needs a semantic judgement.
 *
 * Must run BEFORE comma stripping, or `1,200` becomes `1200` and a quantity
 * whose cardinal reading was already correct reads as an ambiguous bare number.
 */
function tagUnresolved(text: string, tag: (c: SemioticClass) => void): void {
  for (const [re, cls] of UNRESOLVED_TAGS) if (re.test(text)) tag(cls);
}

/** Squeezes intra-line whitespace and blank-line runs; keeps line structure. */
function tidyLines(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Stage 1. Strips markup, verbalizes the surface-decidable semiotic classes,
 * and tags what is left for the model. Never throws — a regex failure degrades
 * to the clamped input rather than taking the readback down with it.
 */
export function toSpeechText(writtenForm: string, opts?: { maxChars?: number }): SpeechText {
  const maxChars = opts?.maxChars ?? SPEECH_MAX_CHARS;
  const found = new Set<SemioticClass>();
  const tag = (c: SemioticClass) => {
    found.add(c);
  };

  let body: string;
  try {
    let out = stripMarkup(writtenForm);
    if (out.split('\n').some((l) => TABLE_ROW_RE.test(l))) tag('table');
    out = verbalizeClosedClasses(out);
    tagUnresolved(out, tag);
    // Comma stripping runs last so the bare-number scan above could not see a
    // grouped quantity as an ambiguous run.
    out = out.replace(/\b(\d{1,3}(?:,\d{3})+)\b/g, (m) => m.replace(/,/g, ''));
    body = tidyLines(out);
  } catch {
    return { spokenForm: clampForSpeech(writtenForm, maxChars), unresolved: [] };
  }

  if (body.length > maxChars) {
    body = cutAtWord(body, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
  }
  return { spokenForm: body, unresolved: [...found] };
}

/** Truncates on a word boundary when there is one nearby, else hard-cuts. */
function cutAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > limit * 0.8 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

/**
 * Stage 2b — the reductions stage 1 deliberately withheld, applied only when
 * the LLM verbalizer does not run (disabled, skipped, or failed).
 *
 * These are lossy in a way the model would do better, which is why they are not
 * in stage 1: a host is not a referent and five rows are not a summary. But
 * they beat spelling a URL character by character, and they are free.
 *
 * Bare numbers are deliberately untouched here too — see rule 2 in the module
 * docs. An unmarked number's cardinal reading is the engine's default and is
 * the more likely correct one.
 */
export function reduceUnresolved(spokenForm: string): string {
  let out = spokenForm;

  out = speakTables(out);
  out = out.replace(PATH_RE, (m, p: string) => {
    const base = p.slice(p.lastIndexOf('/') + 1);
    return m.replace(p, base);
  });
  out = out.replace(URL_RE, (m) => hostOf(m));

  return tidyLines(out);
}

/** `https://www.example.com/a/b?q=1` → `example dot com`. */
function hostOf(url: string): string {
  const withoutScheme = url.replace(/^https?:\/\//i, '');
  const host = withoutScheme.split(/[/?#]/)[0].replace(/^www\./i, '');
  return host.replace(/\./g, ' dot ').replace(/-/g, ' dash ').replace(/\s+/g, ' ').trim();
}

/** Turns contiguous pipe-table blocks into `col: value` sentences. */
function speakTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!TABLE_ROW_RE.test(lines[i])) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const block: string[] = [];
    while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
      block.push(lines[i]);
      i += 1;
    }
    out.push(...renderTable(block));
  }
  return out.join('\n');
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

function renderTable(block: string[]): string[] {
  const rows = block.filter((l) => !TABLE_RULE_RE.test(l)).map(splitRow);
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  if (body.length === 0) return [endSentence(header.filter(Boolean).join(', '))];

  const spoken = body.slice(0, MAX_SPOKEN_TABLE_ROWS).map((cells) =>
    endSentence(
      cells
        .map((cell, idx) => {
          const label = header[idx];
          if (!cell) return '';
          return label ? `${label}: ${cell}` : cell;
        })
        .filter(Boolean)
        .join(', '),
    ),
  );
  const remaining = body.length - MAX_SPOKEN_TABLE_ROWS;
  if (remaining > 0) {
    spoken.push(`…and ${remaining} more ${remaining === 1 ? 'row' : 'rows'}.`);
  }
  return spoken;
}

/**
 * The cheap pure gate before any round trip. `null` means run the model.
 *
 * `'nothing-ambiguous'` is the important one: stage 1 resolved every class it
 * found, so there is nothing left a semantic judgement could improve, and a
 * large share of turns ("Done — the tests pass.") therefore speak at exactly
 * today's latency.
 */
export function speechNormalizeSkipReason(
  t: SpeechText,
): 'empty' | 'too-short' | 'nothing-ambiguous' | null {
  if (t.spokenForm.trim().length === 0) return 'empty';
  if (t.unresolved.length === 0) return 'nothing-ambiguous';
  if (t.spokenForm.length < MIN_NORMALIZE_CHARS) return 'too-short';
  return null;
}

/**
 * The last gate before argv. Flattens line structure (which only
 * {@link reduceUnresolved} needed), drops control characters, squeezes
 * whitespace and hard-caps. Idempotent.
 */
export function clampForSpeech(text: string, maxChars: number = SPEECH_MAX_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  const cleaned = flat
    .replace(PICTOGRAPH_RE, ' ')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cutAtWord(cleaned, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * The whole deterministic pipeline: written form in, argv-ready spoken form out,
 * no model involved. This is what `/voice test` and `bernard voice-test` speak —
 * both are "is my audio working" checks over text the user typed themselves, and
 * routing them through an LLM would make a one-subsystem test into a
 * two-subsystem, non-deterministic one. It is also the fail-open destination for
 * every branch of {@link ../speech-normalizer.js}.
 */
export function toLiteralSpeech(writtenForm: string, maxChars: number = SPEECH_MAX_CHARS): string {
  return clampForSpeech(
    reduceUnresolved(toSpeechText(writtenForm, { maxChars }).spokenForm),
    maxChars,
  );
}
