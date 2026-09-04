import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import stripAnsi from 'strip-ansi';
import { Box, Text } from 'ink';
import type { CoreMessage } from 'ai';
import { Prompt } from '../Prompt.js';
import { TextInputOverlay } from '../overlays/TextInputOverlay.js';
import { TranscriptViewport } from '../TranscriptViewport.js';
import { DimensionsProvider } from '../DimensionsContext.js';
import { HOME_CSI, END_CSI, ARROW_LEFT, SHIFT_ENTER_CSIU, ENTER, tick } from './_keys.js';

/**
 * #399 — escapes driven through the REAL input path.
 *
 * This level is the point. The transcript's Home/End handling was dead for its
 * entire life (added in #288, matching `input === '\x1b[H'`, which never
 * arrives) and nothing caught it, because nothing ever wrote the bytes and
 * asserted the effect. A unit test of the decoder would not have caught it
 * either — the decoder was correct in isolation; the wiring was not.
 */

describe('Home/End in the prompt (#399)', () => {
  // One representative encoding, not all four. The table is pinned per encoding
  // in `keys.test.ts` (purely, in 3 ms); what THIS level uniquely proves is the
  // wiring — stdin -> 'data' -> decoder -> `editor.toLineStart` — and one
  // encoding proves that as well as four. The reason four would otherwise be
  // worth 400 ms of Ink mounts is that Ink has no stop-propagation, so a given
  // encoding could in principle be double-handled; measured, all eight arrive
  // at `useInput` identically as `input: ''`, so that risk is not per-encoding.
  it('Home moves the cursor to the start', async () => {
    const home = HOME_CSI;
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('bc');
    await tick();
    stdin.write(home);
    await tick();
    // Typing now lands BEFORE what was there, which is observable without
    // reaching into cursor state.
    stdin.write('a');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('abc');
  });

  it('End moves the cursor to the end', async () => {
    const end = END_CSI;
    // Move the cursor off the end with ARROWS, not Home — an independently
    // working key. Seeding with Home makes this pass when the whole decoder is
    // dead (Home no-ops, the cursor never leaves the end, End no-ops, and the
    // text comes out right anyway). The mutation check caught that false pass.
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('bc');
    await tick();
    stdin.write(ARROW_LEFT);
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(end);
    await tick();
    stdin.write('d');
    await tick();
    stdin.write(ENTER);
    await tick();
    // 'bcd' only if End moved back; 'dbc' if it did nothing.
    expect(onSubmit).toHaveBeenCalledWith('bcd');
  });

  it('is silent while the prompt is disabled', async () => {
    // The gate is the one the keystream already uses, so a busy turn or an open
    // overlay silences Home/End with everything else.
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit, disabled: true }));
    await tick();
    stdin.write(HOME_CSI);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('Home/End in an overlay text field (#399)', () => {
  it('Home then typing inserts at the start', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(
      createElement(TextInputOverlay, {
        options: { label: 'Name', initialValue: 'bc' },
        onResolve,
      }),
    );
    await tick();
    stdin.write(HOME_CSI);
    await tick();
    stdin.write('a');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ raw: 'abc' }));
  });

  it('End returns the cursor to the end', async () => {
    // Arrows, not Home, to move off the end — see the sibling in the prompt
    // block for why seeding with Home would make this pass with End dead.
    const onResolve = vi.fn();
    const { stdin } = render(
      createElement(TextInputOverlay, {
        options: { label: 'Name', initialValue: 'bc' },
        onResolve,
      }),
    );
    await tick();
    stdin.write(ARROW_LEFT);
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(END_CSI);
    await tick();
    stdin.write('d');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ raw: 'bcd' }));
  });
});

describe('CSI-u Shift+Enter in an overlay text field (#399)', () => {
  it('does not type the literal escape', async () => {
    // The reported defect: `buf="hello world[13;2u"`. `TextInputOverlay` has no
    // `newlineIntent` of its own — the fix is in the shared editor.
    const onResolve = vi.fn();
    const { stdin } = render(
      createElement(TextInputOverlay, {
        options: { label: 'Answer', initialValue: '' },
        onResolve,
      }),
    );
    await tick();
    stdin.write('ab');
    await tick();
    stdin.write(SHIFT_ENTER_CSIU);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ raw: 'ab' }));
  });
});

describe('Home/End in the transcript (#399)', () => {
  const FRAME_ROWS = 10;
  const items = Array.from({ length: 40 }, (_, i) => ({
    key: `k${i}`,
    message: { role: 'assistant', content: `REPLY-${i}` } as CoreMessage,
    toolDetails: false,
  }));

  function mount(promptEmpty: boolean) {
    return render(
      createElement(
        DimensionsProvider,
        null,
        createElement(
          Box,
          { flexDirection: 'column', height: FRAME_ROWS },
          createElement(TranscriptViewport, { items, promptEmpty }),
          createElement(Text, null, 'CHROME'),
        ),
      ),
    );
  }

  it('Home jumps to the top and End back to the bottom', async () => {
    const { stdin, lastFrame } = mount(true);
    await tick();
    expect(stripAnsi(lastFrame() ?? '')).toContain('REPLY-39');

    stdin.write(HOME_CSI);
    await tick();
    expect(stripAnsi(lastFrame() ?? '')).toContain('REPLY-0');

    stdin.write(END_CSI);
    await tick();
    expect(stripAnsi(lastFrame() ?? '')).toContain('REPLY-39');
  });

  it('does nothing while the prompt has text — the line editor owns them', async () => {
    // The arbitration the dead branch already chose, now actually reachable.
    const { stdin, lastFrame } = mount(false);
    await tick();
    stdin.write(HOME_CSI);
    await tick();
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('REPLY-0');
  });
});
