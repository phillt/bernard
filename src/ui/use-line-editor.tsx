import { useState, useCallback } from 'react';
import { Text, type Key } from 'ink';

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
      if (key.leftArrow) {
        setState((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) }));
        return true;
      }
      if (key.rightArrow) {
        setState((s) => ({ ...s, cursor: Math.min(s.buffer.length, s.cursor + 1) }));
        return true;
      }
      // Emacs-style Home/End — Ink's Key has no home/end flags.
      if (key.ctrl && input === 'a') {
        setState((s) => ({ ...s, cursor: 0 }));
        return true;
      }
      if (key.ctrl && input === 'e') {
        setState((s) => ({ ...s, cursor: s.buffer.length }));
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
