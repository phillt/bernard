import { describe, it, expect } from 'vitest';
import { COORDINATOR_MODES } from './coordinator-modes.js';
import { WIZARD_FIELDS } from './profiles-wizard-data.js';

/**
 * The planning question, written down once (#167/#447).
 *
 * Its rows had two hand-written copies — the setup wizard and the
 * `/agent-options` submenu — plus a third paraphrase on that menu's parent row,
 * which is the shape `tool-modes.ts` had just been extracted to stop.
 */
describe('the coordinator-mode rows are written down once', () => {
  it('is what the setup question offers', () => {
    const field = WIZARD_FIELDS.find((f) => f.key === 'coordinatorMode')!;
    expect(field.field.kind).toBe('list');
    if (field.field.kind !== 'list') return;
    expect(field.field.options).toEqual([...COORDINATOR_MODES]);
  });

  it('says Always on the two rows that decide in advance', () => {
    // A bare `On` beside `Auto` invites the reading that `Auto` is somehow less
    // on. The word that distinguishes them is `Always`, so it belongs in the
    // label rather than being left for the note to supply — while the VALUES
    // stay what they always were, since they are on disk and in an env var.
    const byValue = Object.fromEntries(COORDINATOR_MODES.map((m) => [m.value, m.label]));
    expect(byValue).toEqual({ auto: 'Auto', on: 'Always on', off: 'Always off' });
  });

  it('puts nothing in parentheses on a label', () => {
    for (const m of COORDINATOR_MODES) expect(m.label, m.value).not.toMatch(/[()]/);
  });

  it('keeps every note inside the one row it is given', () => {
    // The wizard reserves exactly one row and truncates to it, so a longer
    // sentence is cut rather than wrapped.
    for (const m of COORDINATOR_MODES) expect(m.description.length, m.value).toBeLessThan(60);
  });

  it('states the trade, so a reader can settle it for their own work', () => {
    // The question a reader brings is "which of these is right for ME", and no
    // list of examples answers that — they will always be someone else's work.
    // So the description has to carry all three parts of the trade: what
    // planning buys, what it costs, and the condition under which the cost buys
    // nothing. Asserted as three claims rather than as a sentence, because the
    // wording will be revised and the obligation will not.
    const d = WIZARD_FIELDS.find((f) => f.key === 'coordinatorMode')!.description;
    expect(d, 'what it is for').toMatch(/several steps|multi-step/i);
    expect(d, 'what it buys').toMatch(/reliab/i);
    expect(d, 'what it costs').toMatch(/turns|time/i);
    expect(d, 'when it is not worth it').toMatch(/one step|nothing/i);
    expect(d, 'what auto does').toMatch(/\bauto\b/i);
  });
});
