import { describe, it, expect } from 'vitest';
import {
  truncate,
  normalizeToolText,
  normalizeToolResult,
  foldTypography,
  foldTypographyDeep,
} from './text.js';

describe('truncate', () => {
  it('returns the string unchanged when it fits', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });
  it('caps at max with a single-char ellipsis and no trailing space', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
    expect(truncate('hello world', 7)).toBe('hello…'); // trailing space trimmed before the ellipsis
  });
});

// ---------------------------------------------------------------------------
// Two mojibake generators, and the distinction between them is the whole reason
// this bug survived four months of a green suite.
//
// `encodeMojibake` used to be the only one, producing the LATIN-1 form — which
// puts C1 code points (U+0080-U+009F) in the string. The repair gated on exactly
// those, so every test passed and the function had never once fired on real
// input. Measured from this install's session logs, real mojibake is CP1252 and
// contains no C1 code points at all: `0x80` arrives as `€`, `0x94` as `”`.
//
// Keep both. Latin-1 mojibake is real, just rarer; CP1252 is what actually
// happens. A test file with only one of them is how this recurs.
// ---------------------------------------------------------------------------

/** UTF-8 bytes read back as Latin-1. Yields C1 code points. */
function encodeMojibakeLatin1(s: string): string {
  return Buffer.from(s, 'utf8').toString('latin1');
}

/** UTF-8 bytes read back as CP1252 — the form observed in the wild. */
function encodeMojibakeCp1252(s: string): string {
  const CP1252: Record<number, number> = {
    0x80: 0x20ac,
    0x82: 0x201a,
    0x83: 0x0192,
    0x84: 0x201e,
    0x85: 0x2026,
    0x86: 0x2020,
    0x87: 0x2021,
    0x88: 0x02c6,
    0x89: 0x2030,
    0x8a: 0x0160,
    0x8b: 0x2039,
    0x8c: 0x0152,
    0x8e: 0x017d,
    0x91: 0x2018,
    0x92: 0x2019,
    0x93: 0x201c,
    0x94: 0x201d,
    0x95: 0x2022,
    0x96: 0x2013,
    0x97: 0x2014,
    0x98: 0x02dc,
    0x99: 0x2122,
    0x9a: 0x0161,
    0x9b: 0x203a,
    0x9c: 0x0153,
    0x9e: 0x017e,
    0x9f: 0x0178,
  };
  return [...Buffer.from(s, 'utf8')].map((b) => String.fromCodePoint(CP1252[b] ?? b)).join('');
}

/** The historical name, now pointing at the form that actually occurs. */
const encodeMojibake = encodeMojibakeCp1252;

describe('normalizeToolText', () => {
  // --- Mojibake repair ---

  it('repairs en dash mojibake', () => {
    const input = encodeMojibake('Today 1:00–1:45pm PT');
    expect(normalizeToolText(input)).toBe('Today 1:00–1:45pm PT');
  });

  it('repairs em dash mojibake', () => {
    const input = encodeMojibake('Bernard — AI agent');
    expect(normalizeToolText(input)).toBe('Bernard — AI agent');
  });

  it('repairs the exact observed mojibake example from issue #252', () => {
    const input = encodeMojibake('Today 1:00–1:45pm PT — Bernard...');
    expect(normalizeToolText(input)).toBe('Today 1:00–1:45pm PT — Bernard...');
  });

  it('repairs smart left single quote mojibake', () => {
    const input = encodeMojibake('it‘s');
    expect(normalizeToolText(input)).toBe('it‘s');
  });

  it('repairs smart right single quote mojibake', () => {
    const input = encodeMojibake('it’s');
    expect(normalizeToolText(input)).toBe('it’s');
  });

  it('repairs smart left double quote mojibake', () => {
    const input = encodeMojibake('“hello”');
    expect(normalizeToolText(input)).toBe('“hello”');
  });

  it('repairs smart right double quote mojibake', () => {
    const input = encodeMojibake('”hello“');
    expect(normalizeToolText(input)).toBe('”hello“');
  });

  it('repairs narrow no-break space mojibake (U+202F)', () => {
    const input = encodeMojibake('10 000');
    expect(normalizeToolText(input)).toBe('10 000');
  });

  // --- Idempotency ---

  it('is idempotent on already-valid UTF-8', () => {
    const s = 'Today 1:00–1:45pm PT — Bernard...';
    expect(normalizeToolText(normalizeToolText(s))).toBe(normalizeToolText(s));
  });

  it('is idempotent on plain ASCII', () => {
    const s = 'hello world 123 !@#';
    expect(normalizeToolText(normalizeToolText(s))).toBe(s);
  });

  // --- Guard: clean strings pass through UNCHANGED ---

  it('does not alter plain ASCII', () => {
    const s = 'hello world';
    expect(normalizeToolText(s)).toBe(s);
  });

  it('does not alter already-valid UTF-8 with multibyte chars', () => {
    const s = 'Héllo wörld — café';
    expect(normalizeToolText(s)).toBe(s.normalize('NFC'));
  });

  it('does not alter Windows-style backslash paths', () => {
    const s = 'C:\\Users\\foo\\bar.txt';
    expect(normalizeToolText(s)).toBe(s);
  });

  it('does not alter code with regex backslashes', () => {
    const s = String.raw`/\d+\.\d+/g`;
    expect(normalizeToolText(s)).toBe(s);
  });

  it('does not corrupt printable Latin Extended © (copyright)', () => {
    // © is U+00A9 which is above the C1 range (0x80–0x9F), so no repair attempt.
    const s = 'Copyright © 2024';
    expect(normalizeToolText(s)).toBe(s);
  });

  it('does not corrupt printable Latin Extended ® (registered)', () => {
    const s = 'Acme® Corp';
    expect(normalizeToolText(s)).toBe(s);
  });

  it('does not corrupt ½ (U+00BD, above C1 range)', () => {
    const s = '½ cup of sugar';
    expect(normalizeToolText(s)).toBe(s);
  });

  it('does not introduce replacements on printable Latin Extended mojibake attempt', () => {
    // Encoding © as latin1 bytes then re-reading as utf8 would produce U+FFFD
    // because 0xA9 is not valid UTF-8 on its own.  The guard must block this.
    const withCopyright = 'Copyright © 2024';
    const result = normalizeToolText(withCopyright);
    // U+FFFD = replacement character — must not appear in the output.
    expect(result).not.toContain('�');
    expect(result).toBe(withCopyright);
  });

  // --- Literal \n / \uXXXX escape un-escaping is intentionally NOT done ---
  it('does not un-escape literal \\n in a string', () => {
    // A string containing the two characters backslash + n (as in JSON source)
    // should NOT be converted to a real newline.
    const s = 'line1\\nline2';
    expect(normalizeToolText(s)).toBe(s);
  });

  it('does not un-escape literal \\uXXXX sequences', () => {
    const s = String.raw`– is an en dash`;
    expect(normalizeToolText(s)).toBe(s);
  });

  // --- NFC normalization ---

  it('NFC-normalizes combining characters', () => {
    // é as e + combining acute (NFD) should become the precomposed form (NFC).
    const nfd = 'é';
    const nfc = 'é';
    expect(normalizeToolText(nfd)).toBe(nfc);
  });
});

describe('normalizeToolResult', () => {
  it('normalizes a plain string', () => {
    const input = encodeMojibake('hello — world');
    expect(normalizeToolResult(input)).toBe('hello — world');
  });

  it('normalizes strings inside an array', () => {
    const input = [encodeMojibake('foo — bar'), 'clean'];
    const result = normalizeToolResult(input) as string[];
    expect(result[0]).toBe('foo — bar');
    expect(result[1]).toBe('clean');
  });

  it('normalizes string fields inside a plain object', () => {
    const input = { subject: encodeMojibake('Meeting — 1:00pm'), count: 5 };
    const result = normalizeToolResult(input) as { subject: string; count: number };
    expect(result.subject).toBe('Meeting — 1:00pm');
    expect(result.count).toBe(5);
  });

  it('recurses into nested content[].text arrays (MCP shape)', () => {
    const input = {
      content: [
        { type: 'text', text: encodeMojibake('Today — 1:00pm') },
        { type: 'text', text: 'clean text' },
      ],
    };
    const result = normalizeToolResult(input) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].text).toBe('Today — 1:00pm');
    expect(result.content[1].text).toBe('clean text');
  });

  it('passes numbers, booleans, and null through unchanged', () => {
    expect(normalizeToolResult(42)).toBe(42);
    expect(normalizeToolResult(true)).toBe(true);
    expect(normalizeToolResult(null)).toBe(null);
  });

  it('does not recurse into class instances', () => {
    const d = new Date('2024-01-01');
    expect(normalizeToolResult(d)).toBe(d);
  });
});

/** Builds a string from raw code points, so a test can state exactly what it means. */
const cps = (...points: number[]): string => points.map((p) => String.fromCodePoint(p)).join('');

describe('the mojibake that actually occurs', () => {
  // These are not synthesized. They are the code-point sequences measured from
  // `~/.local/state/bernard/logs/sessions/*.jsonl`, where the corrupted values are
  // the subjects of mail Bernard itself SENT and then read back — which is what
  // proved the corruption happens at the send boundary rather than in storage.
  //
  // Every one of these fails on the predecessor: it gated repair on a C1 code
  // point, and there is not one in this block.

  it('repairs a single-encoded em dash', () => {
    expect(normalizeToolText(cps(0x00e2, 0x20ac, 0x201d))).toBe('—');
  });

  it('repairs a DOUBLE-encoded em dash in one call', () => {
    // The repair iterates to a fixed point. One pass leaves the single-encoded
    // form, which is still wrong.
    expect(normalizeToolText(cps(0x00c3, 0x00a2, 0x00c2, 0x20ac, 0x00c2, 0x201d))).toBe('—');
  });

  it('repairs the reported subject line', () => {
    const subject =
      'Daily Blaze ' + cps(0x00c3, 0x00a2, 0x00c2, 0x20ac, 0x00c2, 0x201d) + ' Wed 9/9';
    expect(normalizeToolText(subject)).toBe('Daily Blaze — Wed 9/9');
  });

  it('repairs a curly apostrophe, the other common victim', () => {
    expect(normalizeToolText(cps(0x00e2, 0x20ac, 0x2122))).toBe('’');
  });

  it('still repairs the LATIN-1 form, through the same machinery', () => {
    // Rarer, but real. A char in U+0080-U+00FF maps to its own byte, so no
    // separate branch is needed — and a regression here would mean the CP1252
    // work replaced the old behaviour instead of subsuming it.
    expect(normalizeToolText(encodeMojibakeLatin1('—'))).toBe('—');
    expect(normalizeToolText(encodeMojibakeLatin1('café'))).toBe('café');
  });

  it('converges rather than looping on stacked corruption', () => {
    let stacked = '—';
    for (let i = 0; i < 4; i++) stacked = encodeMojibakeCp1252(stacked);
    expect(normalizeToolText(stacked)).toBe('—');
  });
});

describe('legitimate text is never touched', () => {
  // The risk the sequence gate exists to manage. `€`, `—`, `’` and `…` are
  // ordinary — this install's own data holds 952 em dashes and 1045 curly quotes
  // in perfectly correct strings — so a character-level gate would have fired on
  // nearly all prose. A candidate must have the SHAPE of mojibake: a UTF-8 lead
  // character followed by the right number of continuations.
  // The six that a first cut of this actually corrupted. Each one decodes
  // cleanly, SHRINKS the string and introduces no U+FFFD, so the acceptance
  // gates cannot catch them — only the strength gate can. Keep them.
  it.each([
    ['an accented capital before a curly quote', 'JOSÉ’s car'],
    ['Icelandic before a curly quote', 'ÓÐÞ’s'],
    ['multiplication sign before a fraction', 'Use 2×½ cup and 3×¼ tsp'],
    ['two adjacent such pairs', '2×½×¼ inch bolt'],
    ['two adjacent Arabic-looking pairs', 'Ø¼Ø½ sizes'],
    ['guillemets around accents', '«ÉTÉ»'],
    ['currency beside an em dash', 'Prix: 25 € — payé'],
    ['a tilde and a cedilla', 'São Paulo'],
    ['CJK', '日本語'],
    ['both', 'Ação'],
    ['a leading em dash', '— a leading em dash'],
    ['an en dash range', '5 – 7 PM'],
    ['emoji', '🎉 done'],
    ['accented plus currency', 'café €5'],
    ['printable Latin-1', '© ® ½'],
    ['a diaeresis', 'naïve'],
    ['curly quotes in prose', 'He said “hi” — it’s fine…'],
    ['Portuguese caps', 'AÇÃO PORTUGUÊS — ÀÉÎÕÜ'],
    ['mixed European accents', 'Héllo wörld — café, jalapeño, Ærø, ÞÓR'],
    ['a lead with no continuation', 'Â x'],
    ['bullets and symbols', '• first — second… ™'],
  ])('leaves %s alone', (_label, input) => {
    expect(normalizeToolText(input)).toBe(input.normalize('NFC'));
  });

  // **Mixed provenance: one real mojibake sequence beside legitimate text.**
  //
  // This is the shape the whole-string gate got wrong, and it is the NORMAL shape
  // for the data this exists for — a thread whose subject went through a broken
  // hop while the body is clean, a scraped page with one mangled field, an MCP
  // result concatenating two sources. Every `keep` half below is a string the
  // table above already pins in isolation, which is exactly why isolation was not
  // enough: `Ã©` is strong by rule 2, and a whole-string gate let it license
  // corrupting a name three words away.
  it.each([
    [
      'a strong match does not license corrupting a weak one',
      'Subject: CafÃ© news — from JOSÉ’s car',
      'Subject: Café news — from JOSÉ’s car',
    ],
    ['guillemets survive beside a real repair', 'CafÃ© «ÉTÉ»', 'Café «ÉTÉ»'],
    ['a fraction survives beside a real repair', 'CafÃ© — use 2×½ cup', 'Café — use 2×½ cup'],
    ['Icelandic survives beside a real repair', 'ÓÐÞ’s CafÃ©', 'ÓÐÞ’s Café'],
    [
      'a double-encoded dash does not drag its neighbours in',
      'Meeting Ã¢Â€Â” notes from JOSÉ’s car',
      'Meeting — notes from JOSÉ’s car',
    ],
  ])('%s', (_label, input, expected) => {
    expect(normalizeToolText(input)).toBe(expected.normalize('NFC'));
  });

  it('refuses a decode that lands in private use, however strong the match', () => {
    // `î` + two C1 chars is a length-3 match, so the strength gate vouches for it —
    // but `EE 80 80` is U+E000, private use. Structural validity is not the same as
    // being real text, which is what the plausibility check is for.
    const privateUse = cps(0x00ee, 0x0080, 0x0080);
    expect(normalizeToolText(privateUse)).toBe(privateUse.normalize('NFC'));
  });

  it('vouches for a C1 continuation under a lead that is neither Â nor Ã', () => {
    // Rule 1 on its own. `É` + a raw C1 control is not something legitimate text
    // produces, and no other rule covers it: the match is two characters and the
    // lead is outside the Â/Ã family.
    expect(normalizeToolText(cps(0x00c9, 0x0080))).toBe('\u0240');
  });

  it('repairs the £ family, which needs the Â lead rule', () => {
    // Rule 2. `Â£` is two characters with no C1 code point and no length-3 match,
    // so only the lead rule vouches for it — and it is one of the commonest real
    // mojibake forms there is.
    expect(normalizeToolText('Â£5')).toBe('£5');
  });

  it('is idempotent on a repaired string', () => {
    const once = normalizeToolText(cps(0x00e2, 0x20ac, 0x201d));
    expect(normalizeToolText(once)).toBe(once);
  });
});

describe('foldTypography', () => {
  it.each([
    ['Daily Blaze — Wed 9/9', 'Daily Blaze - Wed 9/9'],
    ['5 – 7 PM', '5 - 7 PM'],
    ['it’s', "it's"],
    ['“quoted”', '"quoted"'],
    ['wait…', 'wait...'],
    ['• item', '* item'],
    ['a\u00a0b', 'a b'],
    ['plain ascii', 'plain ascii'],
  ])('folds %o to %o', (input, expected) => {
    expect(foldTypography(input)).toBe(expected);
  });

  it('leaves everything that carries MEANING alone', () => {
    // The boundary, and the assertion that stops the tempting "while we're here"
    // edit. These break in a naive consumer exactly the same way an em dash does —
    // but `é` cannot become `e` and `€` cannot become `EUR` on Bernard's
    // initiative, because that is destroying content rather than normalizing it.
    const kept = 'José 日本語 🎉 €5 Ω ß';
    expect(foldTypography(kept)).toBe(kept);
  });

  it('is idempotent', () => {
    const once = foldTypography('“a” — b…');
    expect(foldTypography(once)).toBe(once);
  });

  it('walks a tool-argument object without rebuilding class instances', () => {
    const when = new Date(0);
    const out = foldTypographyDeep({
      subject: 'Blaze — Wed',
      nested: { list: ['a — b', 42, null] },
      when,
    }) as Record<string, unknown>;
    expect(out.subject).toBe('Blaze - Wed');
    expect((out.nested as { list: unknown[] }).list[0]).toBe('a - b');
    expect((out.nested as { list: unknown[] }).list[1]).toBe(42);
    expect(out.when).toBe(when);
  });
});
