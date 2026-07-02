import { describe, it, expect } from 'vitest';
import { parseSGRWheel, looksLikeMouseReport, MOUSE_ENABLE, MOUSE_DISABLE } from '../mouse.js';

describe('parseSGRWheel', () => {
  it('decodes wheel-up (button 64) and wheel-down (button 65)', () => {
    expect(parseSGRWheel('\x1b[<64;40;20M')).toEqual([
      { type: 'wheel', direction: 'up', col: 40, row: 20, shift: false, meta: false, ctrl: false },
    ]);
    expect(parseSGRWheel('\x1b[<65;1;1M')).toEqual([
      { type: 'wheel', direction: 'down', col: 1, row: 1, shift: false, meta: false, ctrl: false },
    ]);
  });

  it('decodes modifier bits (shift +4, meta +8, ctrl +16)', () => {
    const [ev] = parseSGRWheel('\x1b[<80;5;5M'); // 64 + 16 = ctrl wheel-up
    expect(ev).toMatchObject({ direction: 'up', ctrl: true, shift: false, meta: false });
    const [ev2] = parseSGRWheel('\x1b[<77;5;5M'); // 64 + 8 + 4 + 1 = meta+shift wheel-down
    expect(ev2).toMatchObject({ direction: 'down', meta: true, shift: true });
  });

  it('ignores non-wheel reports (clicks, drags, motion)', () => {
    expect(parseSGRWheel('\x1b[<0;10;10M')).toEqual([]); // left click
    expect(parseSGRWheel('\x1b[<2;10;10m')).toEqual([]); // right release
    expect(parseSGRWheel('\x1b[<35;10;10M')).toEqual([]); // motion
  });

  it('returns nothing for ordinary keypresses', () => {
    expect(parseSGRWheel('a')).toEqual([]);
    expect(parseSGRWheel('\x1b[A')).toEqual([]); // arrow up
    expect(parseSGRWheel(Buffer.from('hello'))).toEqual([]);
  });

  it('extracts multiple reports packed into one chunk', () => {
    const events = parseSGRWheel('\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M');
    expect(events.map((e) => e.direction)).toEqual(['up', 'up', 'down']);
  });

  it('accepts a Buffer as well as a string', () => {
    expect(parseSGRWheel(Buffer.from('\x1b[<64;3;3M'))).toHaveLength(1);
  });

  it('exports paired enable/disable escape sequences', () => {
    expect(MOUSE_ENABLE).toBe('\x1b[?1000h\x1b[?1006h');
    expect(MOUSE_DISABLE).toBe('\x1b[?1006l\x1b[?1000l');
  });
});

describe('looksLikeMouseReport', () => {
  it('flags SGR mouse reports leaking through Ink (with or without ESC)', () => {
    // What the line editor would otherwise try to insert as text.
    expect(looksLikeMouseReport('[<64;36;30M')).toBe(true);
    expect(looksLikeMouseReport('\x1b[<0;80;32M')).toBe(true);
    expect(looksLikeMouseReport('[<0;73;24m')).toBe(true);
    // A chunk packing several reports (the screenshot case).
    expect(looksLikeMouseReport('[<0;80;32m[<65;35;29M')).toBe(true);
  });

  it('does not flag ordinary typed input', () => {
    expect(looksLikeMouseReport('hello world')).toBe(false);
    expect(looksLikeMouseReport('a[b]c')).toBe(false);
    expect(looksLikeMouseReport('1;2;3')).toBe(false);
    expect(looksLikeMouseReport('')).toBe(false);
  });

  it('does not swallow real text that merely contains a report-shaped run', () => {
    // Anchored match: a paste with surrounding text is legitimate input.
    expect(looksLikeMouseReport('foo [<64;1;1M bar')).toBe(false);
    expect(looksLikeMouseReport('[<64;1;1M and then typing')).toBe(false);
    expect(looksLikeMouseReport('see \x1b[<0;80;32M here')).toBe(false);
  });
});
