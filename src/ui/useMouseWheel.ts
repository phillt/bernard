import { useEffect, useRef } from 'react';
import { useStdin } from 'ink';
import { parseSGRWheel, type WheelEvent } from './mouse.js';

/**
 * Forward mouse-wheel events to `onWheel` while full-screen.
 *
 * Ink consumes stdin through a `'readable'` listener and routes keypresses to
 * `useInput`; it never surfaces mouse sequences. We attach our own `'data'`
 * listener on the same stream — in flowing mode each listener gets its own copy
 * of every chunk, so this does not starve Ink, and the mouse bytes that leak
 * into Ink's keypress parser are silently ignored (no `useInput` matches them).
 *
 * The escape sequences that turn tracking on/off live in `withFullScreen`; this
 * hook only parses. `enabled` is the `BERNARD_DISABLE_MOUSE` / fullScreen gate —
 * when false the listener is never attached. `setRawMode(true)` is ref-counted
 * by Ink, so calling it here is safe alongside `useInput` elsewhere.
 */
export function useMouseWheel(onWheel: (event: WheelEvent) => void, enabled: boolean): void {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  // Keep the latest callback without re-subscribing the stdin listener.
  const callbackRef = useRef(onWheel);
  callbackRef.current = onWheel;

  useEffect(() => {
    if (!enabled || !stdin || !isRawModeSupported) return;
    setRawMode(true);
    const handler = (data: Buffer) => {
      for (const event of parseSGRWheel(data)) callbackRef.current(event);
    };
    stdin.on('data', handler);
    return () => {
      stdin.off('data', handler);
      setRawMode(false);
    };
  }, [stdin, setRawMode, isRawModeSupported, enabled]);
}
