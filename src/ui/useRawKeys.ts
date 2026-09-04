import { useEffect, useRef } from 'react';
import { useStdin } from 'ink';
import { parseNavKeys, type NavKey } from './keys.js';

/**
 * Forward Home/End to `onKey`, decoded off stdin ourselves (#399).
 *
 * Ink parses these and discards them before `useInput` — see `keys.ts` for why
 * and why upgrading is not the cheap fix. This is the same shape as
 * `useMouseWheel`: Ink consumes stdin through a `'readable'` listener, we
 * attach a `'data'` listener on the same stream, and `keys.ts` does the
 * parsing.
 *
 * **Correcting `useMouseWheel`'s explanation, which is wrong about the
 * mechanism though right about the outcome.** There is no flowing mode here:
 * attaching a `'readable'` listener pins `state.flowing` to `false`, and a
 * later `'data'` listener does not resume it. The `'data'` event still fires
 * because `Readable.read()` emits it for the chunk it returns — so our handler
 * runs *synchronously inside Ink's own `read()`*, ahead of Ink's dispatch, and
 * sees the identical string. Nothing is starved, and we get first look.
 *
 * **We cannot consume the sequence.** Ink has no stop-propagation, so the same
 * bytes still reach every mounted `useInput`. That is harmless for Home/End
 * precisely because of the defect: they arrive as `input: ''`, which no handler
 * acts on and the editor's printable branch skips.
 *
 * **`setRawMode(true)` is load-bearing, not ceremony.** It is ref-counted by
 * Ink (`components/App.js` — `rawModeEnabledCount++/--`), so calling it here is
 * safe alongside `useInput`. It is also what keeps the stream out of flowing
 * mode: if Ink's count ever reached zero while a `'data'` listener remained,
 * Node would resume the stream and deliver keystrokes to us *instead of* Ink.
 * Holding a count makes that unreachable, and the cleanup detaches the listener
 * before releasing it, never the other way round.
 */
export function useRawKeys(onKey: (key: NavKey) => void, enabled: boolean): void {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  // Keep the latest callback without re-subscribing the stdin listener.
  const callbackRef = useRef(onKey);
  callbackRef.current = onKey;

  useEffect(() => {
    if (!enabled || !stdin || !isRawModeSupported) return;
    setRawMode(true);
    // Ink calls `stdin.setEncoding('utf8')`, so chunks arrive as strings — but
    // this listener can be attached before that runs, so coerce rather than
    // assume. (`useMouseWheel` types its parameter `Buffer` and is saved only
    // by the regex it hands the value to.)
    const handler = (data: Buffer | string) => {
      for (const key of parseNavKeys(String(data))) callbackRef.current(key);
    };
    stdin.on('data', handler);
    return () => {
      stdin.off('data', handler);
      setRawMode(false);
    };
  }, [stdin, setRawMode, isRawModeSupported, enabled]);
}
