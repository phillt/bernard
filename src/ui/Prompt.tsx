import { useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../theme.js';
import { SlashHints, matchSlashCommands, type SlashCommand } from './SlashHints.js';
import { useLineEditor } from './use-line-editor.js';
import { BoundedLine, PROMPT_RESERVED_COLUMNS } from './BoundedLine.js';
import { useDimensionsCtx } from './DimensionsContext.js';
import { planPanelMaxRows } from './plan-window.js';

/**
 * Columns the rounded box costs its children — one border cell each side.
 * Handed to `renderAbove` rather than assumed by it, on the same contract as
 * `BoundedLine`'s `reserveColumns`: the border belongs to this component, so
 * the child must not be guessing at it.
 */
export const PROMPT_BORDER_COLUMNS = 2;

/**
 * The row/column budget `Prompt` grants whatever renders inside its border
 * above the input line (today: the pinned `<PlanPanel>`).
 */
export interface PromptAboveBudget {
  /** Total rows the pinned content may occupy, its own chrome included. */
  maxRows: number;
  /** Columns of this box's chrome to subtract from the terminal width. */
  reserveColumns: number;
}

interface PromptProps {
  /** When true, suppress key handling — used while an overlay is open. */
  disabled?: boolean;
  /** Called on Enter with the current buffer (trimmed of trailing newline). */
  onSubmit: (text: string) => void;
  /**
   * Fired whenever the slash-hint strip toggles. Lets the parent show the
   * contextual hint bar without lifting the whole input buffer out of Prompt.
   */
  onSlashActiveChange?: (active: boolean) => void;
  /**
   * Fired only when the buffer's empty/non-empty state flips (not on every
   * keystroke). Lets the full-screen transcript gate Home/End scroll without
   * lifting the buffer out of Prompt or re-rendering the parent per character.
   */
  onEmptyChange?: (empty: boolean) => void;
  /**
   * Session input history (oldest → newest) for ↑/↓ recall. Owned by the
   * parent so it survives this component unmounting (e.g. a Shift-Tab viewer).
   * Mutated in place by `onRecordInput`; read live on each keystroke.
   */
  history?: string[];
  /** Append a user-submitted line to {@link history} (deduped by the parent). */
  onRecordInput?: (text: string) => void;
  /**
   * Supplies dynamic, session-specific slash commands (the user's saved
   * routines and tasks) merged into the autocomplete list. A getter, not an
   * array, so it reads the routine store live without re-render churn.
   */
  dynamicCommands?: () => readonly SlashCommand[];
  /**
   * Optional content rendered inside the input box, above the input line —
   * the pinned `<PlanPanel>` slots in here so the plan + input share one
   * rounded border (the plan reads as an extension of the input box). When
   * absent (or returning `null`), the box collapses to a plain single-line
   * input.
   *
   * A render prop, not a `ReactNode` (#358), so the height budget can flow
   * DOWN. Both children of this box are unbounded by nature — a pasted answer
   * on the input line, an unbounded step list above it — and this is the one
   * component that sees both plus the border, so the box's total height should
   * read as an expression here rather than as an emergent sum of two files'
   * private constants.
   */
  renderAbove?: (budget: PromptAboveBudget) => ReactNode;
}

/**
 * Single-line input box. Uses Ink's `useInput` directly so the surface area
 * stays small (no `ink-text-input` dep). Maintains its own buffer state and
 * emits `onSubmit(text)` on Enter; an empty buffer is rejected silently to
 * match the legacy prompt's behavior.
 *
 * Slash-command autocomplete: when the buffer starts with `/` and has no
 * trailing args, a hint strip renders directly below the input. Up/Down
 * arrows move the selection; Tab completes the highlighted name into the
 * buffer (keeps focus so the user can add args); Enter submits the
 * highlighted command. Once the user types a space, hints clear and Enter
 * submits the literal buffer.
 */
export function Prompt({
  disabled = false,
  onSubmit,
  onSlashActiveChange,
  onEmptyChange,
  history = [],
  onRecordInput,
  dynamicCommands,
  renderAbove,
}: PromptProps) {
  const editor = useLineEditor('', { multiline: true });
  const { buffer } = editor;
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Position in `history` while browsing with ↑/↓; null = editing the live
  // buffer (not on the history rail).
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const colors = getThemeColors();
  // Read here rather than inside the child so the whole box's height is one
  // readable expression: `planPanelMaxRows(rows)` above + `BoundedLine`'s
  // `max(3, min(10, floor(rows / 3)))` below, PLUS its two `▲/▼` affordance
  // rows, which sit outside its own cap — plus this border and the marginTop,
  // which is `PROMPT_CHROME_ROWS`. The two caps stay INDEPENDENT — see
  // `plan-window.ts` for why a shared pool would need both children to lift
  // their demand up here — but they are jointly bounded there, because the
  // fractions alone are not a bound once both floors are counted.
  const { rows } = useDimensionsCtx();

  // Computed every render rather than memoized: `dynamicCommands` is a stable
  // getter whose *returned* list changes when routines/tasks are added/removed,
  // so a memo keyed on the getter identity would serve a stale hint list when
  // the buffer is unchanged. The match is a cheap prefix filter over a small
  // command set, so recomputing is negligible.
  const matches = matchSlashCommands(buffer, dynamicCommands?.() ?? []);
  // Clamp selection whenever the match list shrinks (e.g. user typed another
  // character and fewer commands match). Avoids dangling out-of-range cursor.
  const clampedIndex = matches.length === 0 ? 0 : Math.min(selectedIndex, matches.length - 1);

  // Keep the underlying state in sync with the clamped value so arrow-key
  // handlers don't decrement from a stale high index (e.g. 19 → 18 → 17 …)
  // when the list shrinks from 20 to 3.
  useEffect(() => {
    if (selectedIndex !== clampedIndex) setSelectedIndex(clampedIndex);
  }, [selectedIndex, clampedIndex]);

  const slashActive = matches.length > 0;
  useEffect(() => {
    onSlashActiveChange?.(slashActive);
  }, [slashActive, onSlashActiveChange]);

  const bufferEmpty = buffer.length === 0;
  useEffect(() => {
    onEmptyChange?.(bufferEmpty);
  }, [bufferEmpty, onEmptyChange]);

  useInput(
    (input, key) => {
      // Newline intent — Shift+Enter where the terminal transmits it
      // distinctly, plus the universal Ctrl+J fallback. Most terminals
      // (e.g. VTE/GNOME Terminal) send plain \r for Shift+Enter, which is
      // byte-identical to Enter; for those, Ctrl+J or trailing-\ work.
      const newlineIntent =
        input === '\n' || // Ctrl+J (LF) — works everywhere
        (!key.return && input === '\r') || // ESC+CR (iTerm2 / VS Code Shift+Enter) — Ink strips the ESC
        /^\[13;\d+u$/.test(input); // CSI-u modified Enter (kitty/foot/ghostty Shift+Enter = [13;2u)
      if (newlineIntent) {
        editor.insert('\n');
        setSelectedIndex(0);
        return;
      }
      // Esc dismisses the slash-command picker or a recalled history line —
      // clearing the buffer so the hint strip goes away. (While a turn is busy
      // the Prompt is disabled and App owns Esc for interrupt, so this only
      // fires when the user is actively editing.)
      if (key.escape) {
        if (matches.length > 0 || historyCursor !== null) {
          editor.clear();
          setSelectedIndex(0);
          setHistoryCursor(null);
        }
        return;
      }
      if (key.return) {
        // Highlighted slash command wins over the literal buffer.
        if (matches.length > 0) {
          const picked = matches[clampedIndex];
          editor.clear();
          setSelectedIndex(0);
          setHistoryCursor(null);
          onRecordInput?.(picked.name);
          onSubmit(picked.name);
          return;
        }
        // Trailing-\ continuation (Claude Code convention): swap the
        // backslash for a newline instead of submitting.
        if (buffer.endsWith('\\')) {
          editor.setBuffer(buffer.slice(0, -1) + '\n');
          return;
        }
        const text = buffer.trim();
        if (text.length === 0) return;
        editor.clear();
        setSelectedIndex(0);
        setHistoryCursor(null);
        onRecordInput?.(text);
        onSubmit(text);
        return;
      }
      // History recall takes precedence while actively browsing — so ↑/↓ keep
      // walking the history even when a recalled line looks like a slash command.
      if (historyCursor !== null && key.upArrow) {
        const next = Math.max(0, historyCursor - 1);
        setHistoryCursor(next);
        editor.setBuffer(history[next] ?? '');
        return;
      }
      if (historyCursor !== null && key.downArrow) {
        const next = historyCursor + 1;
        if (next >= history.length) {
          setHistoryCursor(null);
          editor.clear();
        } else {
          setHistoryCursor(next);
          editor.setBuffer(history[next]);
        }
        return;
      }
      if (matches.length > 0 && key.upArrow) {
        setSelectedIndex((i) => (i <= 0 ? matches.length - 1 : i - 1));
        return;
      }
      if (matches.length > 0 && key.downArrow) {
        setSelectedIndex((i) => (i >= matches.length - 1 ? 0 : i + 1));
        return;
      }
      // Start browsing history: ↑ on an empty buffer recalls the most recent
      // submission (survives interrupts — recorded at submit time).
      if (key.upArrow && buffer.length === 0 && history.length > 0) {
        const start = history.length - 1;
        setHistoryCursor(start);
        editor.setBuffer(history[start]);
        return;
      }
      if (matches.length > 0 && key.tab) {
        // Autocomplete: drop the highlighted command into the buffer and add a
        // trailing space so the user can type args without re-typing the name.
        const picked = matches[clampedIndex];
        editor.setBuffer(picked.name + ' ');
        setSelectedIndex(0);
        return;
      }
      // Cursor movement, backspace-at-cursor, and printable insertion all
      // live in the shared line editor (see use-line-editor.tsx). Editing the
      // buffer drops us off the history rail (the line is now "taken").
      if (editor.handleKey(input, key)) {
        setSelectedIndex(0);
        setHistoryCursor(null);
        return;
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* The rounded box wraps both the pinned plan (renderAbove) and the input
          line so they read as one container. paddingX lives on the input row,
          not the box, so a plan's full-width interior divider touches the
          walls. SlashHints stays below the box (an autocomplete dropdown). */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={disabled ? colors.muted : colors.accent}
      >
        {renderAbove?.({
          maxRows: planPanelMaxRows(rows),
          reserveColumns: PROMPT_BORDER_COLUMNS,
        })}
        <Box flexDirection="column" paddingX={1}>
          <BoundedLine
            buffer={buffer}
            cursor={editor.cursor}
            showCursor={!disabled}
            cursorColor={colors.accent}
            reserveColumns={PROMPT_RESERVED_COLUMNS}
            prefix={
              <Text color={colors.accent} bold>
                {'› '}
              </Text>
            }
          />
        </Box>
      </Box>
      <SlashHints matches={matches} selectedIndex={clampedIndex} />
    </Box>
  );
}
