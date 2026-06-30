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
    const onResize = () => setDimensions(read(stdout));
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
