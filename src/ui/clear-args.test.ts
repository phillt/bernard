import { describe, it, expect } from 'vitest';
import {
  parseClearArgs,
  clearResultMessage,
  SAVE_IS_DEFAULT_NOTE,
  type SaveOutcome,
} from './clear-args.js';

/**
 * `/clear`'s arguments and its one line of output (#250).
 *
 * A pure leaf, so none of this needs Ink, a React tree, a store or an agent —
 * which is the reason the decision was extracted from `App.tsx` rather than
 * asserted through a rendered frame.
 */

describe('parseClearArgs', () => {
  // A table, because the whole function is a four-row mapping. The predecessor
  // wrote five near-identical `it`s, one of which (`never nags on the opt-out`)
  // only restated a `toEqual` two tests above it.
  it.each([
    ['', 'save'],
    ['--save', 'save-noting-default'],
    ['-s', 'save-noting-default'],
    ['--do-not-save', 'skip'],
    // #250 names only the long form and that is what `/help` shows. The alias is
    // accepted because the one command whose purpose is "do not lose my work"
    // should not answer the conventional spelling with a usage error.
    ['--no-save', 'skip'],
    // Whitespace is the caller's, not the user's: `App.tsx` passes the raw slice.
    ['   --save  ', 'save-noting-default'],
  ] as const)('parses %o as %s', (arg, expected) => {
    expect(parseClearArgs(arg)).toBe(expected);
  });

  it('REFUSES anything else rather than defaulting', () => {
    // The direction matters now that the default writes: a typo'd flag silently
    // running fact extraction is the wrong way to fail.
    for (const bad of ['--bogus', '--save --do-not-save', 'now', '-x']) {
      expect(parseClearArgs(bad)).toBeNull();
    }
  });
});

describe('clearResultMessage', () => {
  /**
   * Every outcome reads differently, because the predecessor's single
   * `Conversation history cleared.` was shown on all of them — including the ones
   * that saved nothing and the ones that threw. That is what made "did it
   * actually save?" unanswerable, and is the reported complaint this answers.
   */
  const cases: Array<[SaveOutcome, string]> = [
    [{ kind: 'skipped' }, 'Cleared without saving.'],
    [{ kind: 'too-short' }, 'Cleared. Too little conversation to save anything from.'],
    [
      { kind: 'no-memory' },
      'Cleared. Nothing was saved — long-term memory is off (BERNARD_RAG_ENABLED).',
    ],
    [
      { kind: 'saved', facts: 0, kept: [] },
      'Cleared and saved — no new facts beyond what memory already held.',
    ],
  ];
  it.each(cases)('renders %j distinctly', (outcome, expected) => {
    expect(clearResultMessage(outcome)).toBe(expected);
  });

  it('distinguishes a save that added nothing from one that saved', () => {
    // `addFacts` returns what survived dedup, so zero is the ordinary result of
    // clearing twice about one subject — a sentence, not a zero in a count.
    const zero = clearResultMessage({ kind: 'saved', facts: 0, kept: [] });
    expect(zero).toContain('no new facts');
    expect(zero).not.toMatch(/\b0\b/);
  });

  it('names the failure rather than claiming a save', () => {
    expect(clearResultMessage({ kind: 'failed', message: 'provider down' })).toBe(
      'Cleared, but saving failed: provider down',
    );
  });

  it('appends the note only when asked', () => {
    expect(clearResultMessage({ kind: 'saved', facts: 0, kept: [] }, true)).toContain(
      SAVE_IS_DEFAULT_NOTE,
    );
    expect(clearResultMessage({ kind: 'saved', facts: 0, kept: [] }, false)).not.toContain(
      SAVE_IS_DEFAULT_NOTE,
    );
  });

  it('names the opt-out in the note, or the note is not actionable', () => {
    expect(SAVE_IS_DEFAULT_NOTE).toContain('--do-not-save');
  });
});

describe('the receipt', () => {
  const kept = [
    { domain: 'general', fact: 'The Subject header was raw UTF-8 where RFC 5322 wants US-ASCII.' },
    { domain: 'general', fact: 'The repair gated on Latin-1, so it never fired.' },
    { domain: 'tool-usage', fact: 'web_read was never normalized.' },
  ];
  const render = (width = 73, note = false) =>
    clearResultMessage({ kind: 'saved', facts: 3, kept }, note, width);
  /**
   * The table rows only. The headline is prose and may wrap harmlessly; a ROW
   * that wraps is the bug, because its tail reads as another row.
   */
  const rowsOf = (out: string) => out.split('\n').filter((l) => l.startsWith('  '));

  it('lists one line per DOMAIN, not one per fact', () => {
    // What keeps it a receipt rather than a second `/memory`. The domain registry
    // is closed, so the height is bounded with no elision to maintain.
    const lines = render().split('\n');
    expect(lines).toHaveLength(4); // headline, blank, two domains
    expect(lines[2]).toContain('general (2)');
    expect(lines[3]).toContain('tool-usage (1)');
  });

  it('NEVER emits a row wider than the width it was given', () => {
    // The reported bug: the predecessor budgeted 68 characters for the FACT and
    // counted neither the indent nor the label, so a long domain name pushed the
    // row past the frame and Ink wrapped it — and a wrapped tail reads as another
    // row, which is worse than no receipt.
    const long = [
      { domain: 'user-preferences', fact: 'x'.repeat(400) },
      { domain: 'conversations', fact: 'y'.repeat(400) },
    ];
    for (const width of [40, 60, 73, 93, 200]) {
      const out = clearResultMessage({ kind: 'saved', facts: 2, kept: long }, false, width);
      expect(rowsOf(out).length).toBeGreaterThan(0);
      for (const row of rowsOf(out)) {
        expect(row.length, `width ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('aligns the fact column across rows', () => {
    // The difference between a table and three sentences. Padding survives
    // rendering because `renderMarkdown` sets `reflowText: false`.
    const rows = rowsOf(render());
    expect(rows).toHaveLength(2);
    const factColumn = rows.map((r) => (r.match(/^ {2}.*?\S {2,}/) ?? [''])[0].length);
    expect(new Set(factColumn).size).toBe(1);
  });

  it('drops the fact rather than crushing it when the frame is tiny', () => {
    const out = clearResultMessage({ kind: 'saved', facts: 3, kept }, false, 30);
    for (const row of rowsOf(out)) expect(row.length).toBeLessThanOrEqual(30);
    expect(out).toContain('general (2)');
    // The label survives; the fact is what goes.
    expect(out).not.toContain('Subject header');
  });

  it('flattens whitespace so a multi-line fact stays one line', () => {
    const messy = [{ domain: 'general', fact: 'a\n\n  b\tc' }];
    const out = clearResultMessage({ kind: 'saved', facts: 1, kept: messy }, false, 73);
    expect(out.split('\n')).toHaveLength(3);
    expect(out).toContain('a b c');
  });

  it('puts the --save note on its own line when there is a receipt', () => {
    // Otherwise it rides the last listed fact and reads as part of it.
    const lines = render(73, true).split('\n');
    expect(lines[lines.length - 1]).toBe(SAVE_IS_DEFAULT_NOTE);
  });

  it('says nothing extra when the save added nothing', () => {
    // Zero survivors means no receipt: a header with no rows reads as a bug.
    expect(clearResultMessage({ kind: 'saved', facts: 0, kept: [] })).not.toContain('\n');
  });
});
