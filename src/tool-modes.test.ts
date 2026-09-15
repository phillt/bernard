import { describe, it, expect } from 'vitest';
import { TOOL_MODES, UNRESTRICTED } from './tool-modes.js';
import { WIZARD_FIELDS } from './profiles-wizard-data.js';

/**
 * One table, because three surfaces had already grown three spellings (#447).
 *
 * What is asserted here is the SHAPE the drift took, not the current copy: a
 * label that says what another row does, a row whose meaning lives only in
 * parentheses, and a note too long for the one row it is given.
 */
describe('the tool-mode rows are written down once', () => {
  it('is what the setup question offers', () => {
    // The wizard spreads this table rather than restating it. Asserted against
    // the registry rather than by reading the source, because a second literal
    // is exactly what would pass a source-level check.
    const field = WIZARD_FIELDS.find((f) => f.key === 'toolMode')!;
    expect(field.field.kind).toBe('list');
    if (field.field.kind !== 'list') return;
    expect(field.field.options).toEqual([...TOOL_MODES]);
  });

  it('carries the third answer as a row, and names its sentinel once', () => {
    // `ProfileSettings.toolMode` is two values; the third is `skipPermissions`.
    // A mode you can set and then contradict on the next screen is not a mode,
    // so it is a row — and the sentinel is a constant because a caller that
    // spells it itself can spell it differently, which is how this arrived as
    // 'unrestricted' in the wizard and 'skip' in the menu.
    expect(TOOL_MODES.map((m) => m.value)).toEqual(['read-only', 'write', UNRESTRICTED]);
  });

  it('puts nothing in parentheses on a label', () => {
    // The gloss competed with the label for the same space and had to be
    // stripped back off before the answer could be decoded. What it used to say
    // is in the question's description now.
    for (const m of TOOL_MODES) expect(m.label, m.value).not.toMatch(/[()]/);
  });

  it('never describes one row as what another row does', () => {
    // `Write (allow all tools)` was the live copy, and it is what `unrestricted`
    // does — so the two rows a reader most needs to tell apart claimed the same
    // thing. `write` leaves the confirm gate standing; only the third removes it.
    const write = TOOL_MODES.find((m) => m.value === 'write')!;
    expect(`${write.label} ${write.description}`).toMatch(/confirm/i);
    const unrestricted = TOOL_MODES.find((m) => m.value === UNRESTRICTED)!;
    expect(unrestricted.label).toContain('⚠');
  });

  it('keeps every note inside the one row it is given', () => {
    // The wizard reserves exactly one row for this and truncates to it, so a
    // longer sentence is not wrapped — it is cut. 60 is the content width of a
    // card with the rail up on an ordinary terminal.
    for (const m of TOOL_MODES) expect(m.description.length, m.value).toBeLessThan(60);
  });

  it('says what each answer means above the rows, not beside them', () => {
    // Bare rows are only readable if the description names all three. That is
    // the coordinator question's treatment, applied here.
    const field = WIZARD_FIELDS.find((f) => f.key === 'toolMode')!;
    for (const word of ['Read-only', 'Write', 'Unrestricted']) {
      expect(field.description, word).toContain(word);
    }
  });

  it('does the same for the confirm question beside it', () => {
    // Its rows went bare in the same pass; `Auto` alone says nothing about a
    // risk threshold, so the sentence has to carry it.
    const field = WIZARD_FIELDS.find((f) => f.key === 'confirmMode')!;
    expect(field.field.kind).toBe('list');
    if (field.field.kind !== 'list') return;
    for (const o of field.field.options) expect(o.label, o.value).not.toMatch(/[()]/);
    for (const word of ['Auto', 'Strict', 'Off']) {
      expect(field.description, word).toContain(word);
    }
  });
});
