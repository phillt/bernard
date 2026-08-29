import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Text, useInput } from 'ink';
import { useListCursor, type ListCursorOptions } from '../overlays/use-list-cursor.js';
import { ENTER, ARROW_LEFT, ARROW_RIGHT, ARROW_DOWN, tick } from './_keys.js';

/**
 * The hook contract that the overlays lean on but cannot assert from the
 * outside: whether a key was CLAIMED. "Inert" and "swallowed" look identical in
 * a rendered frame, and the difference is the whole point of `horizontal:
 * 'none'` — ConfirmDialog used to early-return on ←/→ with no breadth ladder,
 * claiming a key it did not act on.
 */
function Probe({ opts, log }: { opts: ListCursorOptions; log: boolean[] }) {
  const cursor = useListCursor(opts);
  useInput((input, key) => {
    log.push(cursor.handleKey(input, key));
  });
  return createElement(Text, null, `idx=${cursor.index}`);
}

function mount(opts: Partial<ListCursorOptions> & { onCommit?: ListCursorOptions['onCommit'] }) {
  const log: boolean[] = [];
  const onCommit = opts.onCommit ?? vi.fn();
  const harness = render(createElement(Probe, { opts: { total: 3, ...opts, onCommit }, log }));
  return { ...harness, log, onCommit };
}

describe('useListCursor', () => {
  it("does NOT claim ←/→ under horizontal: 'none'", async () => {
    const { stdin, log } = mount({});
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(ARROW_RIGHT);
    await tick();
    expect(log).toEqual([false, false]);
  });

  it("claims ←/→ under horizontal: 'axis' and forwards the delta", async () => {
    const onAxis = vi.fn();
    const { stdin, log } = mount({ horizontal: 'axis', onAxis });
    await tick();
    stdin.write(ARROW_RIGHT);
    await tick();
    expect(log).toEqual([true]);
    expect(onAxis).toHaveBeenCalledWith(1);
  });

  it("claims ←/→ under horizontal: 'axis' even with no onAxis handler", async () => {
    // The keymap declared this overlay owns the second axis; an owned-but-
    // unhandled key must not fall through to whatever the caller checks next.
    const { stdin, log } = mount({ horizontal: 'axis' });
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    expect(log).toEqual([true]);
  });

  it('clamps the index at render, not only in the setter', async () => {
    const { lastFrame } = mount({ total: 3, initialIndex: 99 });
    await tick();
    expect(lastFrame()).toContain('idx=2');
  });

  it('applies both moves when two keystrokes land in one React batch', async () => {
    // Ink can deliver a burst inside one batch; a non-functional setState would
    // read the stale render closure and collapse the pair into a single move.
    const { stdin, lastFrame } = mount({ total: 5 });
    await tick();
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    await tick();
    expect(lastFrame()).toContain('idx=2');
  });

  it('claims nothing and commits nothing when total is 0', async () => {
    // Reachable only in theory from App.tsx (no call site opens an empty menu),
    // so it is pinned here rather than left silent: with no rows, Enter stops
    // calling onCommit — for multi-select that means no `onMultiSelect([])`.
    const onCommit = vi.fn();
    const { stdin, log } = mount({ total: 0, onCommit });
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(log).toEqual([false]);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
