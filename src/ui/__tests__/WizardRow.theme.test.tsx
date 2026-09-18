import './_force-color.js';
import { describe, it, expect, afterAll, vi } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { restoreForceColor, SGR_THEME_MUTED, SGR_THEME_SUCCESS } from './_force-color.js';
import { DimensionsProvider } from '../DimensionsContext.js';
import { WizardOverlay } from '../overlays/WizardOverlay.js';
import type { WizardSpec } from '../overlays/wizard-types.js';
import { ARROW_DOWN, tick } from './_keys.js';

afterAll(restoreForceColor);

/**
 * Colour on a wizard row, which plain-text assertions are structurally blind to.
 *
 * Under `vitest run` stdout is not a TTY, so Ink emits no ANSI and every
 * `stripAnsi` assertion passes whether a row is muted or not — the same gap
 * `_force-color.ts` exists for. The mutation that survived the plain-text suite
 * was exactly this: dropping the muting from an unpickable row that carries a
 * trailing detail, which is the branch a greyed provider actually takes.
 */
describe('an unpickable row is muted even under the cursor', () => {
  const SPEC: WizardSpec = {
    steps: [
      {
        id: 'p',
        question: 'Which one?',
        field: {
          kind: 'choice',
          choices: ['anthropic', 'xai'],
          trailing: { anthropic: { text: 'Claude models' }, xai: { text: 'no key' } },
          unavailable: { xai: 'xai has no key stored.' },
        },
        initial: 'anthropic',
      },
    ],
  };

  async function frameWithCursorOnXai(): Promise<string> {
    const { stdin, lastFrame } = render(
      createElement(
        DimensionsProvider,
        null,
        createElement(WizardOverlay, { spec: SPEC, onResolve: vi.fn() }),
      ),
    );
    await tick();
    stdin.write(ARROW_DOWN);
    await tick(40);
    return lastFrame() ?? '';
  }

  /**
   * The segment between the card's left border and the row's name — where the
   * LABEL's own colour is opened, and nothing else's.
   *
   * Neither end can be left open. The whole line is no good because the leader
   * dots and the trailing detail are muted BY DESIGN, so `row.includes(muted)`
   * is true however the label is painted — which is why the first version of
   * this test passed with the muting deleted. And the start of the line is no
   * good either: the card's own border is drawn in the same muted colour.
   */
  const labelPrefix = (row: string, name: string): string => {
    const at = row.indexOf(name);
    return row.slice(row.lastIndexOf('\u2502', at), at);
  };

  it('renders the unpickable row in the theme muted colour', async () => {
    const frame = await frameWithCursorOnXai();
    const row = frame.split('\n').find((l) => l.includes('xai'))!;
    // The highlight would otherwise win here, saying "pickable" at exactly the
    // moment the reader is looking at it.
    expect(labelPrefix(row, 'xai')).toContain(SGR_THEME_MUTED);
    // …and it keeps its detail, which is usually the very thing that explains
    // why it cannot be picked.
    expect(row).toContain('no key');
  });

  it('does not mute the row that CAN be picked', async () => {
    // Guard the guard: muting every label would satisfy the assertion above
    // while making the distinction it checks meaningless.
    const frame = await frameWithCursorOnXai();
    const row = frame.split('\n').find((l) => l.includes('anthropic'))!;
    expect(labelPrefix(row, 'anthropic')).not.toContain(SGR_THEME_MUTED);
    expect(row).toContain('Claude models');
  });
});

/**
 * The accent on a footer control means FOCUSED, and nothing else.
 *
 * Painted as the primary colour whenever the cursor was merely not on Back,
 * Continue read as highlighted from the moment the page opened — so the one
 * thing the accent is for, saying where Enter will land, said nothing. Plain
 * text cannot see this at all, which is why it lives beside the row test.
 */
describe('Continue is muted until the cursor is on it', () => {
  const SPEC: WizardSpec = {
    steps: [
      {
        id: 'p',
        question: 'Which one?',
        field: { kind: 'choice', choices: ['alpha', 'beta'] },
        initial: 'alpha',
      },
    ],
  };

  async function frames(): Promise<{ onOption: string; onContinue: string }> {
    const { stdin, lastFrame } = render(
      createElement(
        DimensionsProvider,
        null,
        createElement(WizardOverlay, { spec: SPEC, onResolve: vi.fn() }),
      ),
    );
    await tick();
    const control = (): string =>
      (lastFrame() ?? '').split('\n').find((l) => l.includes('Continue')) ?? '';
    const onOption = control();
    stdin.write(ARROW_DOWN);
    await tick(40);
    stdin.write(ARROW_DOWN);
    await tick(40);
    return { onOption, onContinue: control() };
  }

  /**
   * The segment where CONTINUE's own colour is opened.
   *
   * The whole line is no good: `← Back` sits on it and is muted when unfocused,
   * so `line.includes(muted)` is true however Continue is painted — the same
   * shape of blindness as the row test above.
   */
  const continueSegment = (line: string): string => {
    const at = line.indexOf('Continue');
    // Whichever is nearer: the Back control when the page has one, otherwise the
    // card's left border — whose own muted code sits BEFORE the bar character,
    // so slicing from the bar excludes it.
    const from = Math.max(line.indexOf('Back'), line.lastIndexOf('\u2502', at));
    return line.slice(from, at);
  };

  it('is muted, with no marker and no return glyph, while the cursor is in the list', async () => {
    const { onOption } = await frames();
    expect(continueSegment(onOption)).toContain(SGR_THEME_MUTED);
    expect(onOption).not.toContain('▸');
    // On an option row Enter SELECTS; a return glyph on Continue promises
    // otherwise.
    expect(onOption).not.toContain('↵');
  });

  it('takes the accent, the marker and the glyph once focused', async () => {
    const { onContinue } = await frames();
    expect(onContinue).toContain('▸ Continue');
    expect(onContinue).toContain('↵');
    expect(continueSegment(onContinue)).not.toContain(SGR_THEME_MUTED);
  });
});

/**
 * A tick is green wherever it appears, including under the cursor.
 *
 * It used to be rendered INSIDE the label (`1. ✓ anthropic`), so it inherited
 * whatever `MenuRow` painted the highlighted row — the accent — and the same
 * glyph meant "chosen" in orange on one screen and "key stored" in green on the
 * next. Plain text cannot see either half of that: `toContain('✓')` passes on
 * both the old position and the old colour.
 */
describe('the selection tick is green, and hard right', () => {
  const SPEC: WizardSpec = {
    steps: [
      {
        id: 'p',
        question: 'Which one?',
        field: {
          kind: 'choice',
          choices: ['anthropic', 'xai'],
          trailing: { anthropic: { text: 'Claude models' }, xai: { text: 'Grok models' } },
        },
        initial: 'anthropic',
      },
    ],
  };

  async function frame(): Promise<string> {
    const { lastFrame } = render(
      createElement(
        DimensionsProvider,
        null,
        createElement(WizardOverlay, { spec: SPEC, onResolve: vi.fn() }),
      ),
    );
    await tick();
    return lastFrame() ?? '';
  }

  it('paints it in the theme success colour even while the row is highlighted', async () => {
    const row = (await frame()).split('\n').find((l) => l.includes('anthropic'))!;
    // Bounded at the detail, so the assertion cannot be satisfied by a colour
    // opened anywhere earlier on the line — the row's own label is accent here,
    // and the leader dots are muted.
    const at = row.indexOf('✓');
    expect(at).toBeGreaterThan(row.indexOf('Claude models'));
    expect(row.slice(row.indexOf('Claude models'), at)).toContain(SGR_THEME_SUCCESS);
  });
});
