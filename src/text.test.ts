import { describe, it, expect } from 'vitest';
import { truncate, normalizeToolText, normalizeToolResult } from './text.js';

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
// Helper: produce a mojibake string by encoding valid UTF-8 bytes and then
// decoding them as Latin-1 (the classic Node/HTTP encoding mismatch).
// ---------------------------------------------------------------------------
function encodeMojibake(s: string): string {
  // Encode the Unicode string to UTF-8 bytes, then read those bytes as Latin-1.
  return Buffer.from(s, 'utf8').toString('latin1');
}

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
