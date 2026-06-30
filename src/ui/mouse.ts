/**
 * SGR mouse-report parsing for the full-screen renderer.
 *
 * In the alternate screen buffer the terminal has no native scrollback, so the
 * transcript provides its own mouse-wheel scrolling. We enable xterm mouse
 * tracking in SGR encoding and parse the wheel reports off stdin ourselves —
 * Ink's `useInput` does not surface mouse sequences (it treats them as key
 * noise). This module is pure (no I/O) so it can be unit-tested without a TTY.
 *
 * Escape sequences (DECSET/DECRST):
 *   ?1000 — normal tracking: button press/release + wheel, NO motion noise.
 *   ?1006 — SGR extended encoding: decimal coords, no 223-column cap.
 * `?1000h + ?1006h` is the minimal wheel-capable combination; `?1002`/`?1003`
 * (drag / all-motion) would flood stdin and are deliberately not used.
 *
 * Wheel encoding (SGR): `\x1b[<Pb;col;row M`. Wheel sets bit 6 of `Pb`
 * (`Pb & 64`); wheel-up = button 4 = code 64, wheel-down = button 5 = code 65,
 * so the low bit (`Pb & 1`) gives the direction. Wheel reports only ever use
 * the `M` (press) suffix — there is no release event for the wheel.
 */

/**
 * Matches an SGR mouse report (with or without the leading ESC that Ink may
 * strip). Used to swallow mouse bytes that leak through Ink's keypress parser
 * into text consumers — Ink doesn't understand `\x1b[<…M` and otherwise passes
 * the fragment to `useInput` as `input`, where the line editor would insert it
 * as literal text. No real keystroke looks like this, so the guard is safe even
 * when mouse tracking is off.
 */
const MOUSE_REPORT_RE = /\x1b?\[<\d+;\d+;\d+[Mm]/;

/** True when `input` contains an SGR mouse report (so it should not be typed). */
export function looksLikeMouseReport(input: string): boolean {
  return MOUSE_REPORT_RE.test(input);
}

/** Enable mouse tracking (normal + SGR). Written when entering the alt buffer. */
export const MOUSE_ENABLE = '\x1b[?1000h\x1b[?1006h';
/** Disable mouse tracking. Written before leaving the alt buffer / on every exit. */
export const MOUSE_DISABLE = '\x1b[?1006l\x1b[?1000l';

export interface WheelEvent {
  type: 'wheel';
  direction: 'up' | 'down';
  /** 1-based terminal column the pointer was over. */
  col: number;
  /** 1-based terminal row the pointer was over. */
  row: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

// Global so one stdin chunk packing several reports is fully consumed. A fresh
// regex per call keeps `lastIndex` state local (no shared mutable module state).
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Extract every wheel event from a raw stdin chunk. Non-wheel reports (clicks,
 * drags, motion) are ignored — we only scroll. Returns an empty array when the
 * chunk contains no wheel reports (the common case for ordinary keypresses).
 */
export function parseSGRWheel(chunk: Buffer | string): WheelEvent[] {
  const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  // Cheap bail-out: no CSI-`<` means no SGR mouse report at all.
  if (!str.includes('\x1b[<')) return [];
  const events: WheelEvent[] = [];
  const re = new RegExp(SGR_MOUSE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    const pb = parseInt(m[1], 10);
    if ((pb & 64) === 0) continue; // not a wheel report
    events.push({
      type: 'wheel',
      direction: pb & 1 ? 'down' : 'up',
      col: parseInt(m[2], 10),
      row: parseInt(m[3], 10),
      shift: (pb & 4) !== 0,
      meta: (pb & 8) !== 0,
      ctrl: (pb & 16) !== 0,
    });
  }
  return events;
}
