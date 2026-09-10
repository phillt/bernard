import { describe, it, expect } from 'vitest';
import {
  parseClearArgs,
  clearResultMessage,
  SAVE_IS_DEFAULT_NOTE,
  type SaveOutcome,
} from '../ui/clear-args.js';

/**
 * `/clear`'s arguments and its one line of output (#250).
 *
 * A pure leaf, so none of this needs Ink, a React tree, a store or an agent —
 * which is the reason the decision was extracted from `App.tsx` rather than
 * asserted through a rendered frame.
 */

describe('parseClearArgs', () => {
  it('saves when given nothing, which is the inversion', () => {
    expect(parseClearArgs('')).toEqual({ save: true, noteSaveIsDefault: false });
  });

  it('still accepts --save, and says it is redundant', () => {
    for (const flag of ['--save', '-s']) {
      expect(parseClearArgs(flag)).toEqual({ save: true, noteSaveIsDefault: true });
    }
  });

  it('skips the save on --do-not-save', () => {
    expect(parseClearArgs('--do-not-save')).toEqual({ save: false, noteSaveIsDefault: false });
  });

  it('accepts --no-save as well', () => {
    // #250 names only the long form and that is what `/help` shows. The alias is
    // here because the one command whose purpose is "do not lose my work" should
    // not answer the conventional spelling with a usage error.
    expect(parseClearArgs('--no-save')).toEqual({ save: false, noteSaveIsDefault: false });
  });

  it('never nags on the opt-out', () => {
    // A note saying "saving is the default" on the flag that turns saving OFF
    // would be actively wrong, not merely noisy.
    expect(parseClearArgs('--do-not-save')?.noteSaveIsDefault).toBe(false);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseClearArgs('   --save  ')).toEqual({ save: true, noteSaveIsDefault: true });
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
