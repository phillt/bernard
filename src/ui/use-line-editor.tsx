import { useState, useCallback } from 'react';
import { Text, type Key } from 'ink';
import { looksLikeMouseReport } from './mouse.js';
import { lineStart, lineEnd, wordLeft, wordRight } from './line-geometry.js';

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

interface EditorState {
  buffer: string;
  cursor: number;
}

/**
 * Removes `[from, to)` and leaves the cursor at `from` — what every kill and
 * delete binding wants. Clamping here subsumes each binding's own bounds
 * guard, which is why they were drifting: the four hand-written copies this
 * replaces disagreed about the no-op test (`cursor >= length` in one,
 * `from === cursor` in the others) purely because they were typed separately.
 */
function deleteRange(s: EditorState, from: number, to: number): EditorState {
  const f = Math.max(0, Math.min(from, s.buffer.length));
  const t = Math.max(f, Math.min(to, s.buffer.length));
  if (f === t) return s;
  return { buffer: s.buffer.slice(0, f) + s.buffer.slice(t), cursor: f };
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
      // `moveTo` / `deleteRange` keep every branch to one line, so the two
      // load-bearing orderings below stay visible rather than buried in
      // eight-line blocks. This is still one linear if-chain, not a dispatch
      // table: the last two branches are not "apply a state transform", so a
      // table would need an escape hatch for them AND would still have to be
      // ordered — documenting the constraint no better than these comments.
      const moveTo = (fn: (b: string, c: number) => number): true => {
        setState((s) => ({ ...s, cursor: fn(s.buffer, s.cursor) }));
        return true;
      };
      const editTo = (fn: (s: EditorState) => EditorState): true => {
        setState(fn);
        return true;
      };

      // ORDERING 1: word-wise before the plain arrows, which would otherwise
      // swallow the modified form (Ink sets `leftArrow` on both). Alt-←/→ and
      // Ctrl-←/→ are the same intent in different terminal encodings; Alt-B/F
      // are the emacs spelling.
      const wordMod = key.meta || key.ctrl;
      if (wordMod && (key.leftArrow || input === 'b')) return moveTo(wordLeft);
      if (wordMod && (key.rightArrow || input === 'f')) return moveTo(wordRight);
      if (key.leftArrow) return moveTo((_b, c) => Math.max(0, c - 1));
      if (key.rightArrow) return moveTo((b, c) => Math.min(b.length, c + 1));
      // Emacs-style Home/End — Ink's Key has no home/end flags, and the raw
      // Home/End escapes reach `useInput` as empty input with no flags at all,
      // so they are indistinguishable from noise and cannot be bound here.
      if (key.ctrl && input === 'a') return moveTo(lineStart);
      if (key.ctrl && input === 'e') return moveTo(lineEnd);

      // ORDERING 2: word-delete before plain backspace. Alt-Backspace arrives
      // as `{delete: true, meta: true}`, so the backspace branch below would
      // otherwise consume it and delete a single character.
      if ((key.ctrl && input === 'w') || (key.meta && (key.backspace || key.delete))) {
        return editTo((s) => deleteRange(s, wordLeft(s.buffer, s.cursor), s.cursor));
      }
      if (key.ctrl && input === 'u') {
        return editTo((s) => deleteRange(s, lineStart(s.buffer, s.cursor), s.cursor));
      }
      if (key.ctrl && input === 'k') {
        return editTo((s) => deleteRange(s, s.cursor, lineEnd(s.buffer, s.cursor)));
      }
      // Forward delete (the character AT the cursor), unlike backspace below.
      if (key.ctrl && input === 'd') return editTo((s) => deleteRange(s, s.cursor, s.cursor + 1));
      // Backspace and delete are conflated by terminals in Ink, matching
      // `ink-text-input`'s convention: both remove before the cursor.
      if (key.backspace || key.delete) return editTo((s) => deleteRange(s, s.cursor - 1, s.cursor));
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
