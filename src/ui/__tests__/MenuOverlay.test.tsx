import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { MenuOverlay } from '../overlays/MenuOverlay.js';
import type { MenuEntry } from '../menu-types.js';
import { ESC, ENTER, ARROW_UP, ARROW_DOWN, CTRL_C, tick } from './_keys.js';

const ENTRIES: MenuEntry[] = [
  { type: 'section', title: 'Built-in' },
  { label: 'anthropic', active: true },
  { label: 'openai', annotation: '(default)' },
  { type: 'section', title: 'Custom' },
  { label: 'ollama', description: 'Local Llama via OpenAI shim' },
];

function mountMenu(opts: {
  entries?: MenuEntry[];
  onSelect?: ReturnType<typeof vi.fn>;
  onCancel?: ReturnType<typeof vi.fn>;
  options?: Parameters<typeof MenuOverlay>[0]['options'];
  signal?: AbortSignal;
}) {
  const onSelect = opts.onSelect ?? vi.fn();
  const onCancel = opts.onCancel ?? vi.fn();
  const harness = render(
    createElement(MenuOverlay, {
      entries: opts.entries ?? ENTRIES,
      onSelect,
      onCancel,
      options: opts.options,
      signal: opts.signal,
    }),
  );
  return { ...harness, onSelect, onCancel };
}

describe('<MenuOverlay>', () => {
  it('renders sections, items, active marker, and annotations', () => {
    const { lastFrame } = mountMenu({});
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Built-in');
    expect(frame).toContain('Custom');
    expect(frame).toContain('1. anthropic (active)');
    expect(frame).toContain('2. openai (default)');
    expect(frame).toContain('3. ollama');
    // first item highlighted by default — only its description should NOT
    // appear (it has none); the third item's description should NOT appear
    // either because it's not the highlighted row.
    expect(frame).not.toContain('Local Llama via OpenAI shim');
  });

  it('renders highlighted item description only', async () => {
    const { lastFrame, stdin } = mountMenu({});
    await tick();
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Local Llama via OpenAI shim');
  });

  it('Enter commits the highlighted item', async () => {
    const { stdin, onSelect } = mountMenu({});
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [idx, item] = onSelect.mock.calls[0];
    expect(idx).toBe(0);
    expect(item.label).toBe('anthropic');
  });

  it('Arrow keys move highlight and clamp at boundaries', async () => {
    const { stdin, onSelect, lastFrame } = mountMenu({});
    await tick();
    stdin.write(ARROW_UP); // already at 0; should clamp
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect.mock.calls[0][0]).toBe(0);

    const { stdin: stdin2, onSelect: onSelect2 } = mountMenu({});
    await tick();
    for (let i = 0; i < 10; i++) stdin2.write(ARROW_DOWN);
    await tick();
    stdin2.write(ENTER);
    await tick();
    // 3 items, so max index is 2.
    expect(onSelect2.mock.calls[0][0]).toBe(2);

    // smoke: a frame still renders
    expect(lastFrame()).toBeTruthy();
  });

  it('digit shortcut commits matching item immediately', async () => {
    const { stdin, onSelect } = mountMenu({});
    await tick();
    stdin.write('2');
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe(1);
    expect(onSelect.mock.calls[0][1].label).toBe('openai');
  });

  it('out-of-range digits are ignored', async () => {
    const { stdin, onSelect, onCancel } = mountMenu({});
    await tick();
    stdin.write('9');
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Esc, q, and Ctrl-C cancel', async () => {
    for (const keystroke of [ESC, 'q', CTRL_C]) {
      const { stdin, onCancel } = mountMenu({});
      await tick();
      stdin.write(keystroke);
      await tick();
      expect(onCancel).toHaveBeenCalledTimes(1);
    }
  });

  it('pre-aborted signal fires onCancel synchronously', async () => {
    const ac = new AbortController();
    ac.abort();
    const { onCancel } = mountMenu({ signal: ac.signal });
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('signal aborted mid-render fires onCancel', async () => {
    const ac = new AbortController();
    const { onCancel } = mountMenu({ signal: ac.signal });
    await tick();
    expect(onCancel).not.toHaveBeenCalled();
    ac.abort();
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('headerLines render above the title and items', () => {
    const { lastFrame } = mountMenu({
      options: { headerLines: ['Question 2 of 3', '--'], title: 'Pick one' },
    });
    const frame = lastFrame() ?? '';
    const qIdx = frame.indexOf('Question 2 of 3');
    const titleIdx = frame.indexOf('Pick one');
    const itemIdx = frame.indexOf('anthropic');
    expect(qIdx).toBeGreaterThanOrEqual(0);
    expect(qIdx).toBeLessThan(titleIdx);
    expect(titleIdx).toBeLessThan(itemIdx);
  });
});
