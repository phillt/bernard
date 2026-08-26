/**
 * Pure geometry for the REPL's text inputs — no React, no Ink.
 *
 * Split from `use-line-editor.tsx` for the reason `mouse.ts` is split from
 * `useMouseWheel.ts` and `viewer-util.ts` from `ViewerShell`: this is string
 * math that wants unit tests, and keeping it in a `.tsx` dragged React and Ink
 * into a test suite that needs neither.
 */

/**
 * Boundary math for the readline-style bindings, exported as pure functions so
 * they can be unit-tested without rendering — the same split `mouse.ts`
 * (`parseSGRWheel`) and `viewer-util.ts` already use.
 *
 * All four are **line**-wise, not buffer-wise. The prompt is genuinely
 * multiline (Shift+Enter inserts `\n`), and readline semantics are per line;
 * for a single-line buffer — every `TextInputOverlay` caller — the two are
 * identical.
 */

/** Index of the first character on the cursor's line. */
export function lineStart(buffer: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const nl = buffer.lastIndexOf('\n', cursor - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** Index just past the last character on the cursor's line (before the `\n`). */
export function lineEnd(buffer: string, cursor: number): number {
  const nl = buffer.indexOf('\n', cursor);
  return nl === -1 ? buffer.length : nl;
}

const WS_RE = /\s/;

/**
 * Start of the word at or before the cursor: skip any whitespace immediately
 * behind it, then consume the run of non-whitespace. Matches the bash/readline
 * default (`backward-word`) and every editor's Alt-←.
 */
export function wordLeft(buffer: string, cursor: number): number {
  let i = Math.min(cursor, buffer.length);
  while (i > 0 && WS_RE.test(buffer[i - 1])) i--;
  while (i > 0 && !WS_RE.test(buffer[i - 1])) i--;
  return i;
}

/** End of the word at or after the cursor — the mirror of {@link wordLeft}. */
export function wordRight(buffer: string, cursor: number): number {
  let i = Math.max(0, cursor);
  while (i < buffer.length && WS_RE.test(buffer[i])) i++;
  while (i < buffer.length && !WS_RE.test(buffer[i])) i++;
  return i;
}

/**
 * One visual row after hard-wrapping: a half-open range of `buffer`.
 *
 * Carrying indices rather than strings is what makes the cursor rebase exact —
 * every row maps back to the slice it came from, so no counting of consumed
 * newlines is required.
 */
export interface WrapRow {
  start: number;
  end: number;
}

/**
 * Hard-wraps `buffer` at `width`, preserving every character (#355).
 *
 * Deliberately NOT `wrapText` from `overlays/viewer-util.ts`: that word-wraps,
 * collapses runs of whitespace and re-injects indentation, all of which destroy
 * the character-index → (row, col) mapping an editor cursor depends on. Here a
 * row boundary is purely positional, so the mapping stays exact.
 *
 * Measures in UTF-16 code units, inheriting the limitation this module already
 * documents for `cursor`: a CJK or emoji-heavy line renders wider than it
 * measures. Acceptable for the same reason — it can misposition the window by
 * a row, and the caller's fixed-height box enforces the bound regardless.
 */
export function wrapRows(buffer: string, width: number): WrapRow[] {
  const w = Math.max(1, width);
  const rows: WrapRow[] = [];
  let base = 0;
  for (const line of buffer.split('\n')) {
    if (line.length === 0) {
      rows.push({ start: base, end: base });
    } else {
      for (let i = 0; i < line.length; i += w) {
        rows.push({ start: base + i, end: Math.min(base + i + w, base + line.length) });
      }
    }
    base += line.length + 1; // + the '\n'
  }
  return rows;
}

/** Index into {@link wrapRows}' output of the row `cursor` sits on. */
function cursorRowIndex(rows: readonly WrapRow[], cursor: number): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (cursor >= rows[i].start) return i;
  }
  return 0;
}

export interface BufferWindow {
  /** The visible rows, pre-wrapped and newline-joined. */
  text: string;
  /** `cursor` rebased into {@link text}. */
  cursor: number;
  /** Rows hidden above / below — drives the scroll affordance. */
  above: number;
  below: number;
}

/**
 * Picks the `maxRows`-tall slice of `buffer` containing the cursor.
 *
 * The result is **pre-wrapped**: every line is at most `width`, so Ink has
 * nothing left to re-wrap and the row arithmetic cannot disagree with what is
 * rendered. That is the whole point of wrapping here instead of letting
 * `<Text>` do it — Ink word-wraps, which yields a different row count than the
 * one driving the window, and the cursor would drift out of view.
 *
 * Below the cap the buffer is returned untouched, so ordinary typing keeps
 * Ink's own word-wrapping and looks exactly as it did before.
 */
export function windowBuffer(
  buffer: string,
  cursor: number,
  width: number,
  maxRows: number,
): BufferWindow {
  const cap = Math.max(1, maxRows);
  const rows = wrapRows(buffer, width);
  if (rows.length <= cap) return { text: buffer, cursor, above: 0, below: 0 };

  // Keep the cursor on the last visible row once scrolled: predictable, and it
  // needs no offset state (this is an input, not a free-scrolling viewport).
  const cRow = cursorRowIndex(rows, cursor);
  const offset = Math.min(Math.max(0, cRow - cap + 1), rows.length - cap);
  const visible = rows.slice(offset, offset + cap);

  // `cRow` already answered "which row is the cursor on"; deriving it a second
  // time inside a loop gave a different rule (`>= start && <= end` double-
  // matches at a wrap boundary, where one row's end IS the next row's start).
  // One rule, applied once.
  const vi = cRow - offset;
  const text = visible.map((r) => buffer.slice(r.start, r.end)).join('\n');
  // Every row above the cursor's contributes its length plus the joining '\n'.
  const prefix = visible.slice(0, vi).reduce((n, r) => n + (r.end - r.start) + 1, 0);

  return {
    text,
    cursor: prefix + (cursor - visible[vi].start),
    above: offset,
    below: rows.length - offset - cap,
  };
}
