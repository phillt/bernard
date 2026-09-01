import { truncate, nameList, plural } from '../../text.js';

/**
 * Pure table layout for the viewer overlays (#248): the shared `cell()` padding
 * primitive, and an auto-column renderer for an array of flat-ish objects.
 *
 * No React, no Ink, no theme registry — the `line-geometry.ts` / `menu-geometry.ts`
 * doctrine, so the column-selection rules below can be tested as arithmetic
 * rather than by scraping a rendered frame. Colors are carried as semantic
 * ROLES ({@link SpanRole}) that the caller resolves against `getThemeColors()`;
 * emitting a hex value here would hard-code one theme into a module the
 * high-contrast and colorblind themes exist to re-skin (#320).
 *
 * `cell()` came from `UsageViewer`, whose fixed-width `Row` is the house table
 * idiom. What is generalised here is only the *width* half: `UsageViewer` knows
 * its six columns at author time, while a tool result's shape is discovered at
 * render time, so the columns — which ones, how wide, how aligned — have to be
 * derived from the data.
 *
 * **Every emitted line occupies exactly one terminal row.** That is the
 * invariant both drill-down viewers already rest on: they window by counting
 * entries, so a line that soft-wraps silently desynchronises the scroll position
 * from what is on screen. Column widths are therefore chosen so the composed
 * row can never exceed the budget, and each cell is truncated rather than
 * wrapped.
 */

/** Which theme color a span carries; resolved by the renderer, not here. */
export type SpanRole = 'accent' | 'text' | 'muted';

/** One styled run of text within a line. */
export interface Span {
  text: string;
  role: SpanRole;
}

/** One terminal row, as styled runs. An empty array renders as a blank row. */
export type RichLine = Span[];

/**
 * Pad (or truncate) `value` into a fixed-width cell. The single width primitive
 * for both the hand-declared `UsageViewer` table and the derived one below, so
 * a grid can never shift because one renderer padded and the other didn't.
 */
export function cell(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  const v = value.length > width ? truncate(value, width) : value;
  return align === 'right' ? v.padStart(width) : v.padEnd(width);
}

/**
 * Field names worth finding at a glance in an unfamiliar tool result: the
 * identifier you would act on, the location you would open, the status you were
 * asking about. Their column keeps the foreground color while the rest of the
 * row is muted, which is what makes a wide MCP list scannable without reading
 * every cell.
 *
 * Deliberately a small closed set of exact, lowercase matches rather than
 * substring or fuzzy matching: `updated_by_id` is not an id, and a heuristic
 * that highlights half the columns highlights nothing.
 */
const HIGHLIGHT_KEYS = new Set(['url', 'path', 'id', 'title', 'state', 'status', 'count']);

/** Widest a single derived column may grow before its cells truncate. */
const MAX_COL_W = 28;
/** Narrowest a column may be squeezed to; below this every cell is an ellipsis. */
const MIN_COL_W = 4;

type Scalar = string | number | boolean | null;

interface Candidate {
  key: string;
  /** Rows in which the key is present with a scalar value. */
  count: number;
  /** First-appearance index — the tie-break that keeps ordering deterministic. */
  order: number;
  width: number;
  align: 'left' | 'right';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): v is Scalar {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** How a scalar prints in a cell. `undefined` = the row simply lacks the key. */
function cellText(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'null';
  return typeof v === 'string' ? v : String(v);
}

/**
 * `value` as table rows, or `null` when it is not an array of objects at all.
 * The three degenerate array shapes the caller must fall back on — empty,
 * scalars, arrays-of-arrays — all land here.
 */
function tabularRows(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every(isPlainObject)) return null;
  return value as Record<string, unknown>[];
}

/**
 * Render an array of flat-ish objects as an auto-columned table, or `null` when
 * the shape does not suit one — in which case the caller keeps whatever it did
 * before (for `SourcesViewer`, `JSON.stringify(v, null, 2)`), because a bad
 * table is strictly worse than readable pretty-printed JSON.
 *
 * Columns are **auto-selected, never configured**: picked by how many rows carry
 * the field, capped at what fits `width`, with the remainder reported as a
 * `+N more fields` line. The issue asked for interactive hide/reorder; that is a
 * fourth focus state and a persisted per-tool preference for a read-only excerpt
 * panel, so frequency ordering stands in — it puts the fields the result is
 * actually *about* first, which is the same thing the manual control was for.
 *
 * What disqualifies a shape, and why each rule is a rule:
 *
 *  - **A field whose value is ever an object or array is dropped as a column,
 *    not as a table.** `[{name, meta:{…}}]` is still worth tabulating on `name`;
 *    the dropped field is named in the `+N more fields` line, so nothing goes
 *    missing silently. An array whose objects are *entirely* nested therefore
 *    yields no columns and falls back, which is the "arrays of nested objects"
 *    case.
 *  - **A ragged array falls back once its commonest field is in fewer than half
 *    the rows.** Below that the grid is mostly empty cells: a heterogeneous
 *    bag of records is a list, not a table, and pretty-printed JSON reads better.
 *  - **A column is right-aligned only when every present value is a number**, so
 *    counts and sizes line up on the decimal without a `null` or an id string
 *    dragging the column the wrong way.
 */
export function renderRecordTable(value: unknown, width: number): RichLine[] | null {
  const rows = tabularRows(value);
  if (!rows || width < MIN_COL_W) return null;

  // One pass over every cell: frequency, natural width, alignment, and the
  // disqualification of any field that is ever non-scalar.
  const stats = new Map<string, Candidate>();
  const nested = new Set<string>();
  let order = 0;
  for (const row of rows) {
    for (const [key, raw] of Object.entries(row)) {
      if (!isScalar(raw)) {
        nested.add(key);
        continue;
      }
      let c = stats.get(key);
      if (!c) {
        c = { key, count: 0, order: order++, width: key.length, align: 'right' };
        stats.set(key, c);
      }
      c.count++;
      c.width = Math.max(c.width, cellText(raw).length);
      if (typeof raw !== 'number') c.align = 'left';
    }
  }
  for (const key of nested) stats.delete(key);

  const candidates = [...stats.values()].sort((a, b) => b.count - a.count || a.order - b.order);
  if (candidates.length === 0) return null;
  if (candidates[0].count * 2 < rows.length) return null;

  // Greedy fit in priority order, stopping at the first column that doesn't
  // fit rather than skipping ahead to a narrower one: the kept columns then
  // stay a prefix of the priority order, which is what makes "+N more fields"
  // a suffix the reader can trust rather than an arbitrary subset.
  const shown: Candidate[] = [];
  let used = 0;
  for (const c of candidates) {
    const w = Math.min(MAX_COL_W, Math.max(MIN_COL_W, c.width));
    const need = (shown.length > 0 ? 1 : 0) + w;
    if (used + need > width) break;
    used += need;
    shown.push({ ...c, width: w });
  }
  if (shown.length === 0) return null;

  const omitted = [...candidates.slice(shown.length).map((c) => c.key), ...nested];
  const lines: RichLine[] = [];

  lines.push(
    joinCells(
      shown.map((c) => ({
        text: cell(c.key, c.width, c.align),
        role: HIGHLIGHT_KEYS.has(c.key) ? ('accent' as const) : ('muted' as const),
      })),
    ),
  );
  for (const row of rows) {
    lines.push(
      joinCells(
        shown.map((c) => ({
          text: cell(cellText(row[c.key]), c.width, c.align),
          // The highlighted field keeps the foreground; everything else recedes.
          role: HIGHLIGHT_KEYS.has(c.key) ? ('text' as const) : ('muted' as const),
        })),
      ),
    );
  }
  if (omitted.length > 0) {
    lines.push([
      {
        text: truncate(
          `+${omitted.length} more ${plural(omitted.length, 'field', 'fields')}: ${nameList(omitted)}`,
          width,
        ),
        role: 'muted',
      },
    ]);
  }
  return lines;
}

/** Interleave a muted single-space separator between pre-padded cells. */
function joinCells(cells: Span[]): RichLine {
  const out: RichLine = [];
  for (const c of cells) {
    if (out.length > 0) out.push({ text: ' ', role: 'muted' });
    out.push(c);
  }
  return out;
}
