import { createContext, useContext, type ReactNode } from 'react';
import { useDimensions, FALLBACK_DIMENSIONS, type Dimensions } from './useDimensions.js';

/**
 * One reactive source of terminal size for the whole tree. Before full-screen,
 * every component called `useStdout()` and read `stdout.columns/.rows`
 * independently — none of which updated on resize. The provider subscribes to
 * SIGWINCH once (`useDimensions`) and fans the live value out through context so
 * the fixed-height frame and every windowed child reflow together.
 */
const DimensionsContext = createContext<Dimensions>(FALLBACK_DIMENSIONS);

export function DimensionsProvider({ children }: { children: ReactNode }) {
  const dimensions = useDimensions();
  return <DimensionsContext.Provider value={dimensions}>{children}</DimensionsContext.Provider>;
}

/** Live `{ columns, rows }`, re-rendering on terminal resize. */
export function useDimensionsCtx(): Dimensions {
  return useContext(DimensionsContext);
}
