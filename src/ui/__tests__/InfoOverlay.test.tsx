import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { InfoOverlay, type InfoLine } from '../overlays/InfoOverlay.js';
import { ESC, ENTER, tick, CTRL_C } from './_keys.js';
import stripAnsi from 'strip-ansi';

const SAMPLE_LINES: InfoLine[] = [
  { text: 'first line' },
  { text: 'second line', dim: true },
  { text: 'third line', bold: true },
];

describe('<InfoOverlay>', () => {
  it('renders the title, every line, and the close hint', () => {
    const { lastFrame } = render(
      createElement(InfoOverlay, {
        title: 'Policy',
        lines: SAMPLE_LINES,
        onClose: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Policy');
    expect(frame).toContain('first line');
    expect(frame).toContain('second line');
    expect(frame).toContain('third line');
    // Was `Enter / Esc / q to close` — a third separator style (` / `) and a
    // third casing. Now the shared `HintRow` vocabulary (#266).
    const plain = stripAnsi(frame);
    expect(plain).toContain('↵ close');
    expect(plain).toContain('esc close');
    expect(plain).toContain('q close');
  });

  it('closes on Esc', async () => {
    const onClose = vi.fn();
    const { stdin } = render(createElement(InfoOverlay, { title: 'T', lines: [], onClose }));
    await tick();
    stdin.write(ESC);
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Enter', async () => {
    const onClose = vi.fn();
    const { stdin } = render(createElement(InfoOverlay, { title: 'T', lines: [], onClose }));
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on q', async () => {
    const onClose = vi.fn();
    const { stdin } = render(createElement(InfoOverlay, { title: 'T', lines: [], onClose }));
    await tick();
    stdin.write('q');
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Ctrl-C — the contract key that was silently dropped (#266)', async () => {
    const onClose = vi.fn();
    const { stdin } = render(
      createElement(InfoOverlay, { title: 'Policy', lines: ['first line'], onClose }),
    );
    await tick();
    stdin.write(CTRL_C);
    await tick();
    expect(onClose).toHaveBeenCalled();
  });
});
