import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setInkHandlers, getInkHandlers, type InkHandlers } from '../ink-handlers.js';

function noopHandlers(): InkHandlers {
  return {
    requestMenu: vi.fn(),
    requestConfirm: vi.fn(),
    requestBlock: vi.fn(),
    requestTextInput: vi.fn(),
    requestAskUser: vi.fn(),
    requestConfirmDangerous: vi.fn(),
  } as unknown as InkHandlers;
}

describe('ink-handlers bridge', () => {
  beforeEach(() => {
    setInkHandlers(null);
  });

  it('returns null before any registration', () => {
    expect(getInkHandlers()).toBeNull();
  });

  it('round-trips a registered handler bag', () => {
    const h = noopHandlers();
    setInkHandlers(h);
    expect(getInkHandlers()).toBe(h);
  });

  it('clears on null (mirrors App unmount)', () => {
    setInkHandlers(noopHandlers());
    setInkHandlers(null);
    expect(getInkHandlers()).toBeNull();
  });

  it('last writer wins (mirrors a remount during fresh-install bootstrap)', () => {
    const a = noopHandlers();
    const b = noopHandlers();
    setInkHandlers(a);
    setInkHandlers(b);
    expect(getInkHandlers()).toBe(b);
    expect(getInkHandlers()).not.toBe(a);
  });
});
