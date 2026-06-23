import type { OverlayTab } from './ViewerShell.js';

/**
 * The Shift-Tab viewer tabs, in cycle order. Single source of truth shared by
 * `StatusViewer` / `SourcesViewer` (which render the bottom tab menu) and
 * `App` (which owns the open/cycle transitions). `id` matches the
 * `activeOverlay` value for that tab.
 */
export const VIEWER_TABS: readonly OverlayTab[] = [
  { id: 'status', label: 'Agent Status' },
  { id: 'sources', label: 'Sources' },
  { id: 'usage', label: 'Usage & Cost' },
];
