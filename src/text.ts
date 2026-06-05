/**
 * Shared single-line truncation: caps `s` at `max` characters, replacing the
 * tail with a single-char ellipsis and trimming trailing whitespace so the
 * cut never reads as `foo …`. The single source of truth for the five
 * renderers that previously carried their own drifting copies (Thread,
 * StatusViewer, SourcesViewer, ModelGridOverlay, agent-status).
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
