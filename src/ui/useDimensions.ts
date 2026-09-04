import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface Dimensions {
  columns: number;
  rows: number;
}

/** Fallback used when stdout is not a TTY (tests, CI, piped output). */
export const FALLBACK_DIMENSIONS: Dimensions = { columns: 80, rows: 24 };

function read(stdout: NodeJS.WriteStream | undefined): Dimensions {
  const columns = stdout?.columns ?? FALLBACK_DIMENSIONS.columns;
  const rows = stdout?.rows ?? FALLBACK_DIMENSIONS.rows;
  return { columns, rows };
}

/**
 * Live terminal size. Reads `stdout.columns/.rows` and re-renders on SIGWINCH
 * via the stream's `'resize'` event, so the full-screen frame reflows as the
 * window changes instead of reading a value captured once at mount. Falls back
 * to {@link FALLBACK_DIMENSIONS} when stdout is not a TTY.
 *
 * Used once at the top of the tree by `DimensionsProvider`; components read the
 * value through `useDimensionsCtx()` so a resize fans out from a single source.
 */
export function useDimensions(): Dimensions {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState<Dimensions>(() => read(stdout));

  useEffect(() => {
    if (!stdout) return;
    // Bail out when the size did not actually change. `read` allocates a fresh
    // object every call, so a plain `setDimensions(read(stdout))` is never
    // `Object.is`-equal to the previous state and re-renders the whole tree on
    // any SIGWINCH — including the unconditional sync below, which therefore
    // always cost one full re-render at mount.
    //
    // That was nearly free while the transcript's markdown was shielded behind
    // `memo(MessageBlock)`. It is not any more: a context consumer re-renders
    // regardless of memoized ancestors, so since `MarkdownLines` started reading
    // this context (#464) a no-op resize re-parses every message's markdown —
    // measured at 34.5 ms for 60 messages, for zero layout change.
    const onResize = () =>
      setDimensions((prev) => {
        const next = read(stdout);
        return prev.columns === next.columns && prev.rows === next.rows ? prev : next;
      });
    // Sync once in case the size changed between the initial render and the
    // effect attaching (e.g. a fast resize during startup).
    onResize();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return dimensions;
}
