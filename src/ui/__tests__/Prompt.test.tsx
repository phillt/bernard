import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Prompt } from '../Prompt.js';
import {
  ENTER,
  ESC,
  BACKSPACE,
  ARROW_UP,
  ARROW_DOWN,
  ARROW_LEFT,
  ARROW_RIGHT,
  CTRL_A,
  CTRL_E,
  CTRL_W,
  CTRL_U,
  CTRL_K,
  CTRL_D,
  ALT_B,
  ALT_F,
  ALT_BACKSPACE,
  ALT_LEFT,
  ALT_RIGHT,
  CTRL_LEFT,
  CTRL_RIGHT,
  CTRL_J,
  SHIFT_ENTER_CSIU,
  META_ENTER,
  tick,
} from './_keys.js';

const TAB = '\t';

describe('<Prompt>', () => {
  it('echoes typed characters into the buffer', async () => {
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit: () => {} }));
    await tick();
    stdin.write('hello');
    await tick();
    expect(lastFrame()).toContain('hello');
  });

  it('submits the trimmed buffer on Enter and clears it', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('  hi  ');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hi');
    // Buffer cleared after submit.
    expect(lastFrame()).not.toContain('hi');
  });

  it('rejects an empty Enter silently', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('backspace removes the last character', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('abc');
    await tick();
    stdin.write(BACKSPACE);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('ab');
  });

  it('is inert when disabled', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { disabled: true, onSubmit }));
    await tick();
    stdin.write('hello');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders SlashHints when buffer starts with /', async () => {
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit: () => {} }));
    await tick();
    stdin.write('/ex');
    await tick();
    expect(lastFrame()).toContain('/exit');
  });

  it('Enter picks the highlighted slash command instead of the literal buffer', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('/ex');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/exit');
  });

  it('Down arrow moves the slash-command selection', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('/');
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    // First match is /help; one ArrowDown lands on /clear.
    expect(onSubmit).toHaveBeenCalledWith('/clear');
  });

  it('Tab autocompletes the highlighted command into the buffer', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('/ta');
    await tick();
    stdin.write(TAB);
    await tick();
    expect(lastFrame()).toContain('/task ');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('left arrow moves the cursor so typing inserts mid-string', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('abc');
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write('X');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('abXc');
  });

  it('backspace deletes the character before the cursor', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('abc');
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(BACKSPACE);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('bc');
  });

  it('left at position 0 and right at the end are no-ops', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('ab');
    await tick();
    // Walk well past both boundaries.
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(ARROW_RIGHT);
    await tick();
    stdin.write(ARROW_RIGHT);
    await tick();
    stdin.write(ARROW_RIGHT);
    await tick();
    stdin.write('!');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('ab!');
  });

  it('Ctrl-A jumps to start, Ctrl-E back to end', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('world');
    await tick();
    stdin.write(CTRL_A);
    await tick();
    stdin.write('hi ');
    await tick();
    stdin.write(CTRL_E);
    await tick();
    stdin.write('!');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hi world!');
  });

  it('Ctrl+J inserts a newline; Enter submits the multi-line message', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('line1');
    await tick();
    stdin.write(CTRL_J);
    await tick();
    stdin.write('line2');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('line1\nline2');
  });

  it('CSI-u Shift+Enter (kitty) inserts a newline instead of submitting', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('a');
    await tick();
    stdin.write(SHIFT_ENTER_CSIU);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write('b');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('a\nb');
  });

  it('ESC+CR (iTerm2/VS Code Shift+Enter) inserts a newline instead of submitting', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('a');
    await tick();
    stdin.write(META_ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write('b');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('a\nb');
  });

  it('trailing backslash + Enter continues the line instead of submitting', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('first\\');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write('second');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('first\nsecond');
  });

  it('renders a multi-line buffer across lines', async () => {
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit: () => {} }));
    await tick();
    stdin.write('alpha');
    await tick();
    stdin.write(CTRL_J);
    await tick();
    stdin.write('omega');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('omega');
    // The two halves are on different rows.
    const alphaLine = frame.split('\n').findIndex((l) => l.includes('alpha'));
    const omegaLine = frame.split('\n').findIndex((l) => l.includes('omega'));
    expect(alphaLine).toBeGreaterThanOrEqual(0);
    expect(omegaLine).toBeGreaterThan(alphaLine);
  });

  it('renders the buffer split around a mid-string cursor', async () => {
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit: () => {} }));
    await tick();
    stdin.write('abc');
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    // The full text is still present; the end-of-line block glyph is not,
    // because the cursor now sits on 'c' (rendered inverse).
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ab');
    expect(frame).toContain('c');
    expect(frame).not.toContain('▌');
  });
});

describe('<Prompt> input history (↑/↓ recall)', () => {
  // Wire up history like App does: a stable array the Prompt reads live, pushed
  // to (deduped) on each submit.
  function renderWithHistory(seed: string[] = []) {
    const history = [...seed];
    const onRecordInput = (t: string) => {
      if (history[history.length - 1] !== t) history.push(t);
    };
    const onSubmit = vi.fn();
    const utils = render(createElement(Prompt, { onSubmit, history, onRecordInput }));
    return { ...utils, history, onSubmit };
  }

  it('records submissions and recalls them with ↑, walking newer with ↓', async () => {
    const { stdin, lastFrame, history } = renderWithHistory();
    await tick();
    stdin.write('first');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write('second');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(history).toEqual(['first', 'second']);

    // ↑ on the (now empty) buffer recalls the most recent submission.
    stdin.write(ARROW_UP);
    await tick();
    expect(lastFrame()).toContain('second');
    // ↑ again → older.
    stdin.write(ARROW_UP);
    await tick();
    expect(lastFrame()).toContain('first');
    // ↓ → newer.
    stdin.write(ARROW_DOWN);
    await tick();
    expect(lastFrame()).toContain('second');
    // ↓ past the newest → back to an empty buffer.
    stdin.write(ARROW_DOWN);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('second');
    expect(frame).not.toContain('first');
  });

  it('recall survives without a completed turn (recorded at submit time)', async () => {
    // onSubmit is a no-op spy here — the turn never "runs" — yet ↑ still recalls,
    // mirroring "I hit interrupt and the prompt was still there".
    const { stdin, lastFrame } = renderWithHistory();
    await tick();
    stdin.write('do the thing');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(ARROW_UP);
    await tick();
    expect(lastFrame()).toContain('do the thing');
  });

  it('keeps walking history even when a recalled line is a slash command', async () => {
    const { stdin, lastFrame } = renderWithHistory(['hello there', '/specialists']);
    await tick();
    stdin.write(ARROW_UP); // most recent → /specialists
    await tick();
    expect(lastFrame()).toContain('/specialists');
    stdin.write(ARROW_UP); // older → hello there (history wins over slash-hint nav)
    await tick();
    expect(lastFrame()).toContain('hello there');
  });

  it('does nothing on ↑ when there is no history', async () => {
    const { stdin, lastFrame } = renderWithHistory();
    await tick();
    stdin.write(ARROW_UP);
    await tick();
    // Empty buffer, just the cursor glyph — no crash, nothing recalled.
    expect(lastFrame()).toContain('▌');
  });
});

describe('<Prompt> Esc dismisses the slash picker', () => {
  it('clears the buffer (and the hint strip) on Esc while the picker is open', async () => {
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit: () => {} }));
    await tick();
    stdin.write('/spec');
    await tick();
    expect(lastFrame()).toContain('/specialists'); // hint strip showing
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).not.toContain('/specialists'); // dismissed
  });
});

describe('<Prompt> dynamic slash commands (routines/tasks)', () => {
  it('autocompletes saved routines from dynamicCommands and submits the picked one', async () => {
    const onSubmit = vi.fn();
    const dynamicCommands = () => [
      { name: '/morning-triage', description: 'routine · Morning triage' },
    ];
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit, dynamicCommands }));
    await tick();
    stdin.write('/morn');
    await tick();
    // The routine shows in the hint strip…
    expect(lastFrame()).toContain('/morning-triage');
    // …and Enter submits it (same path the dynamic `/<id>` dispatch uses).
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/morning-triage');
  });

  // Readline-style editing (#356). Before this, the editor handled only
  // arrows / Ctrl-A / Ctrl-E and dropped every other chord at
  // `if (key.ctrl || key.meta) return false`.
  describe('readline chords', () => {
    async function typed(keys: string[]) {
      const onSubmit = vi.fn();
      const { stdin } = render(createElement(Prompt, { onSubmit }));
      await tick();
      for (const k of keys) {
        stdin.write(k);
        await tick();
      }
      stdin.write(ENTER);
      await tick();
      return onSubmit;
    }

    it.each([
      ['Alt-Left', ALT_LEFT],
      ['Ctrl-Left', CTRL_LEFT],
      ['Alt-B', ALT_B],
    ])('%s moves back one word', async (_name, chord) => {
      const onSubmit = await typed(['foo bar', chord, 'X']);
      expect(onSubmit).toHaveBeenCalledWith('foo Xbar');
    });

    it.each([
      ['Alt-Right', ALT_RIGHT],
      ['Ctrl-Right', CTRL_RIGHT],
      ['Alt-F', ALT_F],
    ])('%s moves forward one word', async (_name, chord) => {
      const onSubmit = await typed(['foo bar', CTRL_A, chord, 'X']);
      expect(onSubmit).toHaveBeenCalledWith('fooX bar');
    });

    it('Ctrl-W deletes the word before the cursor', async () => {
      const onSubmit = await typed(['foo bar baz', CTRL_W]);
      expect(onSubmit).toHaveBeenCalledWith('foo bar');
    });

    it('Alt-Backspace deletes a word, not a character', async () => {
      // Regression guard: Alt-Backspace arrives as `{delete, meta}`, so the
      // plain backspace branch would consume it first and delete one char.
      const onSubmit = await typed(['foo bar', ALT_BACKSPACE]);
      expect(onSubmit).toHaveBeenCalledWith('foo');
    });

    it('Ctrl-U kills to the start of the line', async () => {
      const onSubmit = await typed(['discard me', CTRL_U, 'kept']);
      expect(onSubmit).toHaveBeenCalledWith('kept');
    });

    it('Ctrl-K kills to the end of the line', async () => {
      const onSubmit = await typed(['keep this', CTRL_A, ARROW_RIGHT, ARROW_RIGHT, CTRL_K, 'pt']);
      expect(onSubmit).toHaveBeenCalledWith('kept');
    });

    it('Ctrl-D deletes the character at the cursor, not before it', async () => {
      const onSubmit = await typed(['abXc', ARROW_LEFT, ARROW_LEFT, CTRL_D]);
      expect(onSubmit).toHaveBeenCalledWith('abc');
    });

    it('Ctrl-A / Ctrl-E act per line in a multiline buffer', async () => {
      // The correctness half of #356: these used to jump to buffer start/end.
      const onSubmit = await typed(['one', CTRL_J, 'two', CTRL_A, 'X']);
      expect(onSubmit).toHaveBeenCalledWith('one\nXtwo');
    });

    it('Ctrl-E returns to the end of the current line only', async () => {
      const onSubmit = await typed(['one', CTRL_J, 'two', CTRL_A, CTRL_E, 'X']);
      expect(onSubmit).toHaveBeenCalledWith('one\ntwoX');
    });
  });

  // Vertical bound (#355). Without a DimensionsProvider the context falls back
  // to 24 rows, so the cap is `max(3, min(10, floor(24/3))) = 8`.
  describe('height bound', () => {
    async function typeLines(n: number) {
      const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit: () => {} }));
      await tick();
      for (let i = 0; i < n; i++) {
        stdin.write(`line${i}`);
        await tick(2);
        if (i < n - 1) {
          stdin.write(CTRL_J);
          await tick(2);
        }
      }
      return lastFrame() ?? '';
    }

    it('renders a short buffer unwindowed, with no affordance', async () => {
      const frame = await typeLines(3);
      expect(frame).toContain('line0');
      expect(frame).toContain('line2');
      expect(frame).not.toContain('▲');
      expect(frame).not.toContain('▼');
    });

    it('caps a long buffer and keeps the cursor line visible', async () => {
      const frame = await typeLines(30);
      // The last line — where the cursor is, i.e. what you are typing — must
      // be on screen. That is the whole bug.
      expect(frame).toContain('line29');
      // …and the earliest ones must not be, or nothing was bounded.
      expect(frame).not.toContain('line0\n');
      expect(frame).toContain('▲');
    });

    it('reports how many lines are hidden above', async () => {
      const frame = await typeLines(30);
      // 30 rows, cap 8 → 22 hidden above, cursor pinned to the last row.
      expect(frame).toMatch(/▲ 22 more lines/);
    });
  });
});
