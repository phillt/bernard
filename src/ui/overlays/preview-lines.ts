import { truncate } from '../../text.js';
import { wrapText } from './viewer-util.js';
import { cell, cellText, renderRecordTable, type RichLine } from './table.js';

/**
 * Turning a tool-result preview into readable lines — the string half of the
 * citation card (#248).
 *
 * A `.ts` beside `table.ts` rather than private to `SourcesViewer.tsx`, on the
 * same rule as `line-geometry.ts` and `plan-window.ts`: this is pure string
 * math, so its tests should drag in neither React nor Ink. That is not
 * cosmetic here — the width fitting below is only checkable at widths the test
 * renderer cannot produce, since `DimensionsProvider` takes no override and
 * ink-testing-library's stdout reports a fixed 100 columns.
 */

/** Longest `<tool>:` prefix the preview grammar recognises. */
const MAX_PREFIX = 40;
/** Widest the key column of a flat-object render may grow. */
const MAX_KEY_W = 18;

/**
 * Word-wrapped prose as single-span lines. A blank line becomes an empty
 * `RichLine`, which the renderer paints as one blank row.
 */
export function plainLines(s: string, width: number): RichLine[] {
  return wrapText(s, width).map((line) => (line === '' ? [] : [{ text: line, role: 'text' }]));
}

/**
 * Make machine-y content human-readable. Tool-result previews are typically
 * `<tool>: <json>` — detect the embedded JSON, parse it, and render it as an
 * auto-columned table (an array of flat-ish objects — the common shape of an
 * MCP list result, #248), an aligned key/value table (a flat object), or
 * 2-space-indented JSON (anything else). Falls back to the raw string when
 * there's no JSON or the preview was truncated mid-object (so it won't parse).
 *
 * Returns styled lines rather than a string because the table needs per-cell
 * color AND must not be word-wrapped afterwards: its columns are already fitted
 * to the width, and `wrapText` would re-flow them into a shape the
 * one-row-per-entry windowing no longer describes.
 */
export function buildPreviewLines(content: string, width: number): RichLine[] {
  const m = content.match(
    new RegExp(`^([A-Za-z0-9_.\\- ]{1,${MAX_PREFIX}}?):\\s*([[{][\\s\\S]*)$`),
  );
  const prefix = m ? m[1].trim() : null;
  const body = (m ? m[2] : content).trim();
  if (body[0] === '{' || body[0] === '[') {
    const cleaned = body.replace(/[\s…]*$/, ''); // drop a trailing ellipsis from truncation.
    const parsed = tryParseJson(cleaned);
    if (parsed !== undefined) {
      // Fitted to `width` like every other line this function produces. A
      // prefix may be MAX_PREFIX characters while the card's inner width can be
      // ~20 on a narrow terminal, and the renderer wraps each `RichLine` in a
      // plain `<Text>` — so an over-width header would soft-wrap into two rows
      // and desync the one-row-per-entry windowing this card rests on. The
      // fallback path below never had the bug: it routes the prefix through
      // `plainLines` → `wrapText(..., width)`.
      const header: RichLine[] = prefix
        ? [[{ text: truncate(`${prefix}:`, width), role: 'accent' }]]
        : [];
      // `null` from the table renderer means "this shape isn't a table" — empty
      // arrays, arrays of scalars, arrays of nested objects, and arrays too
      // ragged to grid. Those keep the pretty-printed JSON they already had.
      const table = renderRecordTable(parsed, width);
      if (table) return [...header, ...table];
      const rendered = renderJsonValue(parsed);
      return plainLines(prefix ? `${prefix}:\n${rendered}` : rendered, width);
    }
  }
  return plainLines(content, width);
}

export function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Aligned key/value lines for a flat object; pretty-printed JSON otherwise. */
export function renderJsonValue(v: unknown): string {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    const allScalar =
      entries.length > 0 && entries.every(([, val]) => val === null || typeof val !== 'object');
    if (allScalar) {
      const keyW = Math.min(MAX_KEY_W, Math.max(...entries.map(([k]) => k.length)));
      // `cell`, not `padEnd`: a key longer than MAX_KEY_W pads to nothing and
      // pushes its own value out of the column, so the one row that most needed
      // the alignment is the one that loses it.
      return entries.map(([k, val]) => `${cell(k, keyW)}  ${cellText(val)}`).join('\n');
    }
  }
  return JSON.stringify(v, null, 2);
}
