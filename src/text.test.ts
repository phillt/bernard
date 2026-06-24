import { describe, it, expect } from 'vitest';
import { normalizeToolText, normalizeToolResult, truncate } from './text.js';

// ---------------------------------------------------------------------------
// normalizeToolText
// ---------------------------------------------------------------------------

describe('normalizeToolText', () => {
  // -- Mojibake repair: UTF-8 decoded as Latin-1 --------------------------------

  it('repairs en dash (U+2013) mojibake: "â€"" → "–"', () => {
    // U+2013 EN DASH in UTF-8: 0xE2 0x80 0x93
    // Latin-1 mis-decoding: 'â' (0xE2) + '€' (0x80 → but 0x80 in Latin-1 is PAD) …
    // The actual three Latin-1 chars for U+2013 are: â (0xE2), € (MCP often sends 0x80 → in
    // extended Latin-1 / windows-1252 this is '€', but standard Latin-1 0x80 is not a printable
    // character). Use the real-world observed mojibake from the issue.
    const mojibake = 'Today 1:00â 1:45pm';
    const repaired = normalizeToolText(mojibake);
    expect(repaired).toBe('Today 1:00– 1:45pm'); // en dash
  });

  it('repairs em dash (U+2014) mojibake', () => {
    // U+2014 EM DASH in UTF-8: 0xE2 0x80 0x94
    // Latin-1 mis-decoded: â
    const mojibake = 'â';
    expect(normalizeToolText(mojibake)).toBe('—');
  });

  it('repairs the exact issue example: "Today 1:00Ã¢Â€Â"1:45pm PT Ã¢Â€Â" Bernard..."', () => {
    // Double-encoded: first the UTF-8 bytes were decoded as Latin-1, then that
    // Latin-1 string was itself re-encoded as UTF-8 and decoded again as Latin-1.
    // The observed output uses Ã (0xC3), ¢ (0xA2), Â (0xC2), etc.
    // Re-encode the mojibake string as UTF-8 bytes via latin1 to arrive at
    // the original code-points.
    // Build the mojibake string that represents U+2013 (en dash) after two mis-decoding passes.
    // U+2013 in UTF-8: bytes E2 80 93
    // Those bytes decoded as Latin-1: â  
    // That string encoded as UTF-8: bytes C3 A2 C2 80 C2 93
    // Those bytes decoded as Latin-1: Ã ¢ Â  Â 
    // In typical Latin-1/windows-1252 display: Ã¢Â€Â"  (Ã=Ã, ¢=¢, Â=Â, €=€∥0x80, Â=Â, "=)
    // We use the raw codepoints for precision:
    const enDashDoubleMojibake = 'Ã¢ÂÂ';
    const emDashDoubleMojibake = 'Ã¢ÂÂ';
    const fullMojibake = `Today 1:00${enDashDoubleMojibake}1:45pm PT ${emDashDoubleMojibake} Bernard...`;

    // A single pass of normalizeToolText repairs one layer of mojibake.
    // After one pass: Ã¢ÂÂ → â
    // After second pass: â → – (en dash)
    // Bernard should make two passes if needed. We test a single pass does partial repair
    // and two passes fully repair.
    const once = normalizeToolText(fullMojibake);
    const twice = normalizeToolText(once);
    // After two passes, we should have clean Unicode.
    expect(twice).toContain('–'); // en dash
    expect(twice).toContain('—'); // em dash
    expect(twice).not.toContain('Ã'); // no more Ã
  });

  it('repairs smart left single quote (U+2018): â → ‘', () => {
    // U+2018 LEFT SINGLE QUOTATION MARK, UTF-8: E2 80 98
    const mojibake = 'âhelloâ';
    const repaired = normalizeToolText(mojibake);
    expect(repaired).toBe('‘hello’');
  });

  it('repairs smart left double quote (U+201C): â → “', () => {
    // U+201C LEFT DOUBLE QUOTATION MARK, UTF-8: E2 80 9C
    const mojibake = 'âhelloâ';
    const repaired = normalizeToolText(mojibake);
    expect(repaired).toBe('“hello”');
  });

  // -- Pass-through: clean input must not be corrupted -----------------------

  it('does NOT corrupt legitimate Latin Extended two-char sequences like "Ã©" (U+00C3 + U+00A9)', () => {
    // U+00C3 (Ã) followed by U+00A9 (©) — Ã is in the lead-byte range but © (0xA9)
    // is NOT in the C1 control range 0x80–0x9F, so looksLikeMojibake must not fire.
    // If it did fire and accepted the repair, "Ã©" would become "é" — wrong.
    const s = 'Ã©'; // Ã + © — a legitimate two-character Latin Extended sequence
    expect(normalizeToolText(s)).toBe(s.normalize('NFC')); // NFC only; no mojibake repair
  });

  it('does NOT corrupt © ® ° and other printable Latin Extended chars (0xA0–0xBF range)', () => {
    const s = '© 2024 Company. All rights reserved. ® Trademark. 100°C.';
    expect(normalizeToolText(s)).toBe(s.normalize('NFC'));
  });

  it('passes through clean ASCII unchanged', () => {
    const s = 'Hello, World! 1+1=2 path/to/file.txt';
    expect(normalizeToolText(s)).toBe(s);
  });

  it('passes through already-valid UTF-8 unchanged', () => {
    const s = 'Héllo wörld – em—dash "smart" ’quotes‘';
    const result = normalizeToolText(s);
    // Result should be NFC-normalised; if already NFC it will be identical.
    expect(result).toBe(s.normalize('NFC'));
  });

  it('passes through Windows paths with backslashes unchanged', () => {
    const s = 'C:\\Users\\Phil\\Documents\\file.txt';
    expect(normalizeToolText(s)).toBe(s);
  });

  it('passes through regex patterns with backslashes unchanged', () => {
    const s = '\\d+\\.\\d{2}|\\bword\\b';
    expect(normalizeToolText(s)).toBe(s);
  });

  it('passes through code with backslash escapes unchanged', () => {
    const s = 'const x = "line1\\nline2\\ttabbed";';
    expect(normalizeToolText(s)).toBe(s);
  });

  it('passes through emoji unchanged', () => {
    const s = 'Hello 😀 World';
    expect(normalizeToolText(s)).toBe(s.normalize('NFC'));
  });

  it('passes through empty string unchanged', () => {
    expect(normalizeToolText('')).toBe('');
  });

  it('passes through numbers (non-string) unchanged', () => {
    // @ts-expect-error — testing runtime guard
    expect(normalizeToolText(42)).toBe(42);
  });

  // -- Idempotency ----------------------------------------------------------

  it('is idempotent: normalizing twice gives the same result', () => {
    const cases = [
      'clean ASCII',
      'â', // en dash mojibake
      'âhelloâ', // smart quote mojibake
      'Héllo', // NFD combining accent → NFC
      'Already – clean — with dashes',
    ];
    for (const s of cases) {
      const once = normalizeToolText(s);
      const twice = normalizeToolText(once);
      expect(twice).toBe(once);
    }
  });

  // -- NFC normalisation -----------------------------------------------------

  it('NFC-normalises combining characters', () => {
    // NFD: 'e' + combining acute accent
    const nfd = 'é';
    // NFC: precomposed é
    const nfc = 'é';
    expect(normalizeToolText(nfd)).toBe(nfc);
  });

  it('leaves NFC strings unchanged after normalisation', () => {
    const s = 'café'; // precomposed é
    expect(normalizeToolText(s)).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// normalizeToolResult
// ---------------------------------------------------------------------------

describe('normalizeToolResult', () => {
  it('normalizes a plain string', () => {
    const mojibake = 'â';
    expect(normalizeToolResult(mojibake)).toBe('–');
  });

  it('returns numbers unchanged', () => {
    expect(normalizeToolResult(42)).toBe(42);
  });

  it('returns booleans unchanged', () => {
    expect(normalizeToolResult(true)).toBe(true);
  });

  it('returns null unchanged', () => {
    expect(normalizeToolResult(null)).toBe(null);
  });

  it('returns undefined unchanged', () => {
    expect(normalizeToolResult(undefined)).toBe(undefined);
  });

  it('normalizes strings inside an array', () => {
    const input = ['â', 'clean'];
    const result = normalizeToolResult(input) as string[];
    expect(result[0]).toBe('–');
    expect(result[1]).toBe('clean');
  });

  it('returns same array reference when nothing changed', () => {
    const input = ['clean', 'strings'];
    expect(normalizeToolResult(input)).toBe(input);
  });

  it('normalizes string-valued object properties', () => {
    const input = { subject: 'âsmartâ', count: 3 };
    const result = normalizeToolResult(input) as typeof input;
    expect(result.subject).toBe('‘smart’');
    expect(result.count).toBe(3);
  });

  it('returns same object reference when nothing changed', () => {
    const input = { foo: 'bar', n: 1 };
    expect(normalizeToolResult(input)).toBe(input);
  });

  it('normalizes MCP content[].text arrays (TextContent convention)', () => {
    const input = {
      content: [
        { type: 'text', text: 'âhelloâ' },
        { type: 'text', text: 'clean' },
      ],
    };
    const result = normalizeToolResult(input) as typeof input;
    expect(result.content[0].text).toBe('“hello”');
    expect(result.content[1].text).toBe('clean');
  });

  it('handles nested objects recursively', () => {
    const input = {
      outer: {
        inner: 'â',
      },
    };
    const result = normalizeToolResult(input) as typeof input;
    expect(result.outer.inner).toBe('—');
  });

  it('handles arrays of objects', () => {
    const input = [
      { title: 'â item 1', value: 1 },
      { title: 'item 2', value: 2 },
    ];
    const result = normalizeToolResult(input) as typeof input;
    expect(result[0].title).toBe('– item 1');
    expect(result[1].title).toBe('item 2');
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe('truncate', () => {
  it('returns the original string when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates to the max length', () => {
    expect(truncate('hello world', 5)).toBe('hello');
  });

  it('returns the string unchanged when length equals maxLength', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('handles empty string', () => {
    expect(truncate('', 5)).toBe('');
  });
});
