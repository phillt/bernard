import { describe, it, expect } from 'vitest';
import {
  CONFIRM_MODES,
  TOOL_MODES,
  TOOL_MODE_SETTINGS,
  UNRESTRICTED,
  toolModeFor,
} from './tool-modes.js';
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

  it('is the only permission question setup asks', () => {
    // The merge (#447). `confirmMode` had a step of its own on the screen
    // after this one, and answering it `off` made this row's label false with
    // nothing on either screen connecting the two. It is COVERED rather than
    // asked, which is what keeps `settings-coverage.test.ts` counting it and
    // `storedExplicitly` reading a stored confirm level as an answer.
    const field = WIZARD_FIELDS.find((f) => f.key === 'toolMode')!;
    expect(field.covers).toContain('confirmMode');
    expect(field.covers).toContain('skipPermissions');
    expect(WIZARD_FIELDS.some((f) => f.key === 'confirmMode')).toBe(false);
  });
});

/**
 * The merge, as a decode rather than as copy (#447).
 *
 * The middle row's label described a PAIR of settings and only one of them was
 * written, so the next screen could falsify it. What makes that unrepresentable
 * is that a row writes all three keys and that the inverse is the same table
 * read backwards — not that the wording improved.
 */
describe('one question decides all three keys', () => {
  it('writes every key on every row', () => {
    // A patch of "what changed" is how a move off `unrestricted` left
    // `skipPermissions: true` standing under a guarded mode. The same shape
    // would let a row inherit a confirm level nobody chose for it.
    for (const m of TOOL_MODES) {
      expect(Object.keys(TOOL_MODE_SETTINGS[m.value]).sort(), m.value).toEqual([
        'confirmMode',
        'skipPermissions',
        'toolMode',
      ]);
    }
  });

  it('round-trips every row', () => {
    // The property that makes a tick honest: what a row writes is read back as
    // that same row, so a walk that changes nothing cannot move the answer.
    for (const m of TOOL_MODES) {
      expect(toolModeFor(TOOL_MODE_SETTINGS[m.value]), m.value).toBe(m.value);
    }
  });

  it('leaves a level that survives the safeguards being re-armed', () => {
    // `/tool-permissions` turns `skipPermissions` off by writing that ONE key,
    // so whatever a row left in `confirmMode` is what the session comes back
    // with. `off` is what the last row means and is the one value it must not
    // store: re-armed, it would be a session that still never asks, sitting in
    // the state no row represents. An inert field should hold whatever is
    // correct the moment it stops being inert.
    for (const m of TOOL_MODES) {
      const rearmed = { ...TOOL_MODE_SETTINGS[m.value], skipPermissions: false };
      expect(toolModeFor(rearmed), m.value).not.toBe(null);
    }
  });

  it('reads write+strict back as "ask before every change"', () => {
    // The collapse that makes this three rows rather than four: `strict`
    // confirms at medium and up, and an ordinary local write is medium, so it
    // stops on exactly the calls `read-only` blocks on. If this is wrong the
    // merge is wrong, which is why it is asserted rather than left in prose.
    expect(toolModeFor({ toolMode: 'write', skipPermissions: false, confirmMode: 'strict' })).toBe(
      'read-only',
    );
  });

  it('reads write+off back as no row at all', () => {
    // Never-asking without removing the deny rules and write scopes. Folding it
    // into `⚠ Never ask` would turn a bare Enter on the ticked row into an
    // escalation, so nothing is ticked and the reader has to choose.
    expect(toolModeFor({ toolMode: 'write', skipPermissions: false, confirmMode: 'off' })).toBe(
      null,
    );
  });

  it('reads unrestricted back whatever sits beside it', () => {
    // `toolModePolicy` short-circuits on `skipPermissions` before consulting
    // either of the others, so this follows the policy rather than the record.
    for (const confirmMode of ['off', 'auto', 'strict'] as const) {
      expect(toolModeFor({ toolMode: 'read-only', skipPermissions: true, confirmMode })).toBe(
        UNRESTRICTED,
      );
    }
  });

  it('keeps the finer control reachable from a surface, not just an env var', () => {
    // This was very nearly a silent capability removal. `OPTIONS_REGISTRY` is
    // the four numeric settings and `/agent-options` had no confirm-mode row,
    // so dropping the setup question would have left `BERNARD_CONFIRM_MODE` and
    // the per-job cron field as the only doors to `strict` and `off`.
    expect(CONFIRM_MODES.map((m) => m.value)).toEqual(['auto', 'strict', 'off']);
    for (const m of CONFIRM_MODES) expect(m.label, m.value).not.toMatch(/[()]/);
    const app = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui', 'App.tsx'),
      'utf-8',
    );
    // A source scan because `/agent-options` is one of the commands
    // `ui/__tests__/App.test.tsx` deliberately does not drive (it needs a
    // mocked wizard), and `buildAgentOptionsMenu` lives inside the component
    // closure. What is pinned is the WIRING, not the existence: asserting the
    // function's NAME appears survived a mutation that unhooked the row and
    // left the definition standing. The wording stays the table's business.
    expect(app).toContain('CONFIRM_MODES');
    expect(app).toContain('action: runConfirmModePrompt');
  });
});
