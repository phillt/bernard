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
    [{ kind: 'saved', facts: 7 }, 'Cleared and saved 7 new facts to memory.'],
    [{ kind: 'saved', facts: 1 }, 'Cleared and saved 1 new fact to memory.'],
  ];
  it.each(cases)('renders %j distinctly', (outcome, expected) => {
    expect(clearResultMessage(outcome)).toBe(expected);
  });

  it('distinguishes a save that added nothing from one that saved', () => {
    // `addFacts` returns what survived dedup, so zero is the ordinary result of
    // clearing twice about one subject — a sentence, not a zero in a count.
    const zero = clearResultMessage({ kind: 'saved', facts: 0 });
    expect(zero).toContain('no new facts');
    expect(zero).not.toMatch(/\b0\b/);
  });

  it('names the failure rather than claiming a save', () => {
    expect(clearResultMessage({ kind: 'failed', message: 'provider down' })).toBe(
      'Cleared, but saving failed: provider down',
    );
  });

  it('appends the note only when asked', () => {
    expect(clearResultMessage({ kind: 'saved', facts: 2 }, true)).toContain(SAVE_IS_DEFAULT_NOTE);
    expect(clearResultMessage({ kind: 'saved', facts: 2 }, false)).not.toContain(
      SAVE_IS_DEFAULT_NOTE,
    );
  });

  it('names the opt-out in the note, or the note is not actionable', () => {
    expect(SAVE_IS_DEFAULT_NOTE).toContain('--do-not-save');
  });
});
