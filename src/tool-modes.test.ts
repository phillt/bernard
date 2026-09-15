import { describe, it, expect } from 'vitest';
import { TOOL_MODES, UNRESTRICTED } from './tool-modes.js';
import { WIZARD_FIELDS } from './profiles-wizard-data.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('defaults to the row it recommends', () => {
    // Nothing pinned `DEFAULT_TOOL_MODE` before this — a security-relevant
    // default that could be changed with the whole suite green, which is how
    // this one got changed in a copy pass. The assertion is deliberately the
    // PAIR: the recommendation the wizard draws is derived from whatever is in
    // force with nothing overriding it, so a default that moves and a
    // recommendation that does not is not a state that can exist. Changing the
    // default is fine; changing it silently is what this refuses.
    // Read out of the source, the move `settings-coverage.test.ts` already
    // makes for `profiles.ts`: the constant is module-private, and `loadConfig`
    // throws without a provider key, so the file is the only place to ask.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.ts'),
      'utf-8',
    );
    const declared = /const DEFAULT_TOOL_MODE:[^=]+=\s*'([a-z-]+)'/.exec(src)?.[1];
    expect(declared).toBe('write');
    expect(TOOL_MODES.some((m) => m.value === declared)).toBe(true);
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
    const unrestricted = TOOL_MODES.find((m) => m.value === UNRESTRICTED)!;
    // The middle row must not read as the last one. `write` still stops at the
    // dangerous calls; only the third removes that, and only the third is
    // marked.
    expect(`${write.label} ${write.description}`).not.toMatch(/never|nothing|all tools|every/i);
    expect(`${unrestricted.label} ${unrestricted.description}`).toMatch(/never|nothing/i);
    expect(unrestricted.label).toContain('⚠');
  });

  it('keeps every note inside the one row it is given', () => {
    // The wizard reserves exactly one row for this and truncates to it, so a
    // longer sentence is not wrapped — it is cut. 60 is the content width of a
    // card with the rail up on an ordinary terminal.
    for (const m of TOOL_MODES) expect(m.description.length, m.value).toBeLessThan(60);
  });

  it('does not repeat a row that already says what it does', () => {
    // The inverse of the rule the coordinator question follows, and the reason
    // is the same one. `Auto` / `Always on` say nothing on their own, so that
    // description has to name all three. These rows are whole sentences — "Ask
    // before every change" — so a description that quoted them would put the
    // same words on the screen twice. What it carries instead is the trade,
    // which no label has room for.
    const field = WIZARD_FIELDS.find((f) => f.key === 'toolMode')!;
    for (const m of TOOL_MODES) {
      // Whole phrase, not a substring: "Never asking is quickest" is the
      // description doing its own job, and shares two words with the row by
      // ordinary English rather than by quoting it.
      const quoted = m.label.replace('⚠ ', '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(field.description, m.value).not.toMatch(new RegExp(`\\b${quoted}\\b`, 'i'));
    }
    expect(field.description, 'the trade').toMatch(/safest|interrupt/i);
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
