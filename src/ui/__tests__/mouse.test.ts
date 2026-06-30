import { describe, it, expect } from 'vitest';
import { parseSGRWheel, MOUSE_ENABLE, MOUSE_DISABLE } from '../mouse.js';

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
