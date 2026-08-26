import { useState, useCallback } from 'react';
import { Text, type Key } from 'ink';
import { looksLikeMouseReport } from './mouse.js';

/**
 * Shared single-line editing state for the REPL's text inputs (`Prompt`,
 * `TextInputOverlay`). Owns the buffer *and* an insertion-point cursor so
 * Left/Right arrows, mid-string insertion, and backspace-before-cursor work
 * the same way in both components.
 *
 * Cursor indexes UTF-16 code units; splitting an astral pair / emoji is a
 * known limitation shared with `ink-text-input` — acceptable for a CLI input.
 */
export interface LineEditor {
  buffer: string;
  /** Insertion point, 0..buffer.length. */
  cursor: number;
  /** Replaces the text and moves the cursor to the end (e.g. Tab autocomplete). */
  setBuffer: (text: string) => void;
  /** Empties the buffer and resets the cursor (post-submit). */
  clear: () => void;
  /** Inserts text at the cursor (e.g. an explicit newline from Shift+Enter). */
  insert: (text: string) => void;
  /**
   * Handles editing keys (arrows, Ctrl-A/E, backspace, printable input).
   * Returns true when consumed — the caller should stop processing. Keys with
   * caller-specific meaning (return, escape, tab, up/down) always return false.
   */
  handleKey: (input: string, key: Key) => boolean;
}

export interface LineEditorOptions {
  /**
   * When true, newlines in inserted text are kept (normalized to '\n').
   * When false (default), they are stripped — single-line inputs like the
   * overlay text fields must never accumulate newline characters from
   * pastes or half-parsed escape sequences (e.g. ESC+CR arrives as '\r').
   */
  multiline?: boolean;
}

const CRLF_RE = /\r\n?/g;
const NEWLINE_RE = /\n/g;

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

export function useLineEditor(initial = '', opts: LineEditorOptions = {}): LineEditor {
  const { multiline = false } = opts;
  // Single state object so buffer/cursor updates are atomic.
  const [state, setState] = useState({ buffer: initial, cursor: initial.length });

  const setBuffer = useCallback((text: string) => {
    setState({ buffer: text, cursor: text.length });
  }, []);

  const clear = useCallback(() => {
    setState({ buffer: '', cursor: 0 });
  }, []);

  const insert = useCallback(
    (text: string) => {
      // Normalize CRLF / bare CR (paste, ESC+CR remnants) to '\n', then strip
      // newlines entirely for single-line editors.
      let cleaned = text.replace(CRLF_RE, '\n');
      if (!multiline) cleaned = cleaned.replace(NEWLINE_RE, '');
      if (!cleaned) return;
      setState((s) => ({
        buffer: s.buffer.slice(0, s.cursor) + cleaned + s.buffer.slice(s.cursor),
        cursor: s.cursor + cleaned.length,
      }));
    },
    [multiline],
  );

  const handleKey = useCallback(
    (input: string, key: Key): boolean => {
      // Word-wise movement. Alt-←/→ and Ctrl-←/→ are the same intent with
      // different terminal encodings; Alt-B/F are the emacs spelling. Tested
      // before the plain arrows, which would otherwise swallow the modified
      // form (Ink sets `leftArrow` on both).
      const wordMod = key.meta || key.ctrl;
      if (wordMod && (key.leftArrow || input === 'b')) {
        setState((s) => ({ ...s, cursor: wordLeft(s.buffer, s.cursor) }));
        return true;
      }
      if (wordMod && (key.rightArrow || input === 'f')) {
        setState((s) => ({ ...s, cursor: wordRight(s.buffer, s.cursor) }));
        return true;
      }
      if (key.leftArrow) {
        setState((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) }));
        return true;
      }
      if (key.rightArrow) {
        setState((s) => ({ ...s, cursor: Math.min(s.buffer.length, s.cursor + 1) }));
        return true;
      }
      // Emacs-style Home/End — Ink's Key has no home/end flags, and the raw
      // Home/End escapes reach `useInput` as empty input with no flags at all,
      // so they are indistinguishable from noise and cannot be bound here.
      if (key.ctrl && input === 'a') {
        setState((s) => ({ ...s, cursor: lineStart(s.buffer, s.cursor) }));
        return true;
      }
      if (key.ctrl && input === 'e') {
        setState((s) => ({ ...s, cursor: lineEnd(s.buffer, s.cursor) }));
        return true;
      }
      // Delete word before the cursor. MUST precede the backspace branch:
      // Alt-Backspace arrives as `{delete: true, meta: true}`, so the plain
      // backspace test below would consume it and delete a single character.
      if ((key.ctrl && input === 'w') || (key.meta && (key.backspace || key.delete))) {
        setState((s) => {
          const from = wordLeft(s.buffer, s.cursor);
          if (from === s.cursor) return s;
          return { buffer: s.buffer.slice(0, from) + s.buffer.slice(s.cursor), cursor: from };
        });
        return true;
      }
      // Kill to line start / line end.
      if (key.ctrl && input === 'u') {
        setState((s) => {
          const from = lineStart(s.buffer, s.cursor);
          if (from === s.cursor) return s;
          return { buffer: s.buffer.slice(0, from) + s.buffer.slice(s.cursor), cursor: from };
        });
        return true;
      }
      if (key.ctrl && input === 'k') {
        setState((s) => {
          const to = lineEnd(s.buffer, s.cursor);
          if (to === s.cursor) return s;
          return { buffer: s.buffer.slice(0, s.cursor) + s.buffer.slice(to), cursor: s.cursor };
        });
        return true;
      }
      // Forward delete (the character AT the cursor), unlike backspace below.
      if (key.ctrl && input === 'd') {
        setState((s) => {
          if (s.cursor >= s.buffer.length) return s;
          return {
            buffer: s.buffer.slice(0, s.cursor) + s.buffer.slice(s.cursor + 1),
            cursor: s.cursor,
          };
        });
        return true;
      }
      if (key.backspace || key.delete) {
        // Both treated as backspace (delete before cursor) — terminals conflate
        // the two in Ink, matching ink-text-input's convention.
        setState((s) => {
          if (s.cursor === 0) return s;
          return {
            buffer: s.buffer.slice(0, s.cursor - 1) + s.buffer.slice(s.cursor),
            cursor: s.cursor - 1,
          };
        });
        return true;
      }
      if (key.ctrl || key.meta) return false;
      // Printable input (including multi-char paste): insert at the cursor.
      // `input` is empty for arrow/function keys, so those fall through.
      if (input && !key.escape && !key.tab && !key.return) {
        // Mouse-wheel/click reports (full-screen) leak through Ink's keypress
        // parser as `input` like `[<64;36;30M`. Swallow them so they don't get
        // typed into the buffer (the parser already consumed them).
        if (looksLikeMouseReport(input)) return true;
        insert(input);
        return true;
      }
      return false;
    },
    [insert],
  );

  return { buffer: state.buffer, cursor: state.cursor, setBuffer, clear, insert, handleKey };
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
export function cursorRowIndex(rows: readonly WrapRow[], cursor: number): number {
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

  let text = '';
  let rebased = 0;
  for (let i = 0; i < visible.length; i++) {
    const r = visible[i];
    if (i > 0) text += '\n';
    if (cursor >= r.start && cursor <= r.end) rebased = text.length + (cursor - r.start);
    text += buffer.slice(r.start, r.end);
  }

  return {
    text,
    cursor: rebased,
    above: offset,
    below: rows.length - offset - cap,
  };
}

interface LineWithCursorProps {
  buffer: string;
  cursor: number;
  /** When false (e.g. disabled prompt), render the bare text with no cursor. */
  showCursor: boolean;
  /** Color for the end-of-line block glyph. */
  cursorColor: string;
  /** Block glyph rendered when the cursor sits at the end of the line. */
  cursorGlyph?: string;
}

/**
 * Renders a buffer with its cursor: the familiar block glyph when the cursor
 * is at the end (the common case — pixel-identical to the pre-cursor look),
 * or an inverse-video character when it's mid-string.
 */
export function LineWithCursor({
  buffer,
  cursor,
  showCursor,
  cursorColor,
  cursorGlyph = '▌',
}: LineWithCursorProps) {
  if (!showCursor) {
    return <Text>{buffer}</Text>;
  }
  if (cursor >= buffer.length) {
    return (
      <Text>
        <Text>{buffer}</Text>
        <Text color={cursorColor}>{cursorGlyph}</Text>
      </Text>
    );
  }
  // Inverse-video on a bare '\n' is invisible — render an inverse space at
  // the end of the line, then the newline itself.
  const onNewline = buffer[cursor] === '\n';
  return (
    <Text>
      <Text>{buffer.slice(0, cursor)}</Text>
      <Text inverse>{onNewline ? ' ' : buffer[cursor]}</Text>
      <Text>{buffer.slice(onNewline ? cursor : cursor + 1)}</Text>
    </Text>
  );
}
