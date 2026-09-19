import { useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../theme.js';
import { SlashHints, matchSlashCommands, type SlashCommand } from './SlashHints.js';
import { useRawKeys } from './useRawKeys.js';
import { isModifiedEnter } from './keys.js';
import { useLineEditor } from './use-line-editor.js';
import { BoundedLine, PROMPT_RESERVED_COLUMNS } from './BoundedLine.js';
import { useDimensionsCtx } from './DimensionsContext.js';
import { planPanelMaxRows } from './plan-window.js';
import { slashPickerListRows, slashPickerMaxRows } from './slash-picker.js';
import { useListCursor, useListWindow } from './overlays/use-list-cursor.js';

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
   * Enter on a buffer with nothing submittable in it (#462).
   *
   * That keystroke has always been a silent no-op, so nothing is taken away by
   * giving it a meaning — and giving it one HERE, at the guard the Prompt
   * already owns, is what avoids a second `useInput` for Enter. Ink broadcasts
   * every key to every mounted handler with no stop-propagation, so an
   * App-level Enter binding would have to be arbitrated against this one.
   */
  onEmptySubmit?: () => void;
  /**
   * Whether Esc would be CLAIMED here — a slash picker is open, or a history
   * line is on the rail (#202).
   *
   * The Prompt is live during a turn now, so its Esc (dismiss what is open) and
   * App's Esc (abort the turn) both fire on the same keystroke and **Ink has no
   * stop-propagation** — neither can consume it. So the arbitration is App
   * declining rather than this component consuming, and this is the one fact it
   * needs to decline on: first Esc dismisses, second interrupts.
   *
   * ONE boolean, and it *is* the guard the Esc branch below tests, rather than
   * two flags the parent recombines — a second expression for one condition is
   * how the two come to disagree about what is on screen.
   *
   * Reported from an effect, so the parent reads the PRE-Esc value: both
   * handlers run synchronously in one stdin tick and the re-render that would
   * update this comes after. That is correct rather than a race to work around
   * — the value describing what was on screen when the key was pressed is the
   * one that should decide what the key meant.
   */
  onEscapeGuardChange?: (guarded: boolean) => void;
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
 * emits `onSubmit(text)` on Enter; an empty buffer submits nothing and instead
 * calls `onEmptySubmit`, which is how a delivered message is acted on with no
 * typing (#462).
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
  onEmptySubmit,
  onEscapeGuardChange,
  history = [],
  onRecordInput,
  dynamicCommands,
  renderAbove,
}: PromptProps) {
  const editor = useLineEditor('', { multiline: true });
  // Home/End never reach `useInput` (Ink drops them — see `keys.ts`), so they
  // are decoded off stdin. Gated by the same `!disabled` the keystream uses, so
  // a busy turn or an open overlay silences them together with everything else.
  useRawKeys((key) => {
    if (key === 'home') editor.toLineStart();
    else editor.toLineEnd();
  }, !disabled);
  const { buffer } = editor;
  // Position in `history` while browsing with ↑/↓; null = editing the live
  // buffer (not on the history rail).
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const colors = getThemeColors();
  // Read here rather than inside the children so the whole dock's height is one
  // readable expression: `planPanelMaxRows(rows)` above + `BoundedLine`'s
  // `max(3, min(10, floor(rows / 3)))` below, PLUS its two `▲/▼` affordance
  // rows, which sit outside its own cap — plus this border and the marginTop,
  // which is `PROMPT_CHROME_ROWS` — plus `slashPickerMaxRows(rows)` for the
  // popover hanging underneath (#589). The caps stay INDEPENDENT — see
  // `plan-window.ts` for why a shared pool would need every child to lift its
  // demand up here — but they are jointly bounded there, because the
  // fractions alone are not a bound once the floors are counted. The picker's
  // budget needs no term of its own in that sum: it charges the input one row
  // where the plan's budget charges it ten, so the two overlap inside slack
  // the plan has already reserved. `slash-picker.ts` states that, and
  // `Prompt.test.tsx` measures the rendered dock rather than trusting it.
  const { rows } = useDimensionsCtx();

  // Computed every render rather than memoized: `dynamicCommands` is a stable
  // getter whose *returned* list changes when routines/tasks are added/removed,
  // so a memo keyed on the getter identity would serve a stale hint list when
  // the buffer is unchanged. The match is a cheap prefix filter over a small
  // command set, so recomputing is negligible.
  const matches = matchSlashCommands(buffer, dynamicCommands?.() ?? []);
  const pickerRows = slashPickerMaxRows(rows);

  const runPicked = (index: number) => {
    const picked = matches[index];
    if (!picked) return;
    editor.clear();
    setSelectedIndex(0);
    setHistoryCursor(null);
    onRecordInput?.(picked.name);
    onSubmit(picked.name);
  };

  // The fifth copy of this keymap, finally routed through the shared one (#589).
  // The four overlays #266 unified had already drifted; this one was missed
  // because it lives here rather than in `overlays/`, and it wrapped where they
  // clamp — see `wrap` on `ListCursorOptions` for why that stays, now as a
  // decision. Two options are load-bearing and neither is the default:
  //
  //   `digits: false` — a digit in this buffer is TEXT. `/2` is the start of a
  //   routine name, not "run the second row", and the shared keymap's default
  //   would swallow it.
  //   `total: matches.length` — `listNavIntent` answers `null` for every key
  //   once that is 0, which is what lets `handleListKey` sit ahead of the
  //   literal-buffer paths below without claiming Enter when no command matches.
  //
  // The clamp is the hook's, applied at render, so the `useEffect` that used to
  // chase a stale index down a shrinking match list is gone.
  const {
    index: selectedIndex,
    setIndex: setSelectedIndex,
    handleKey: handleListKey,
  } = useListCursor({
    total: matches.length,
    wrap: true,
    digits: false,
    onCommit: runPicked,
  });
  const { offset } = useListWindow(selectedIndex, slashPickerListRows(pickerRows), matches.length);

  const slashActive = matches.length > 0;
  useEffect(() => {
    onSlashActiveChange?.(slashActive);
  }, [slashActive, onSlashActiveChange]);

  const bufferEmpty = buffer.length === 0;
  useEffect(() => {
    onEmptyChange?.(bufferEmpty);
  }, [bufferEmpty, onEmptyChange]);

  // The Esc guard, declared once and both reported and acted on below — see
  // `onEscapeGuardChange` for why the parent must not recombine it from parts.
  const escapeGuarded = matches.length > 0 || historyCursor !== null;
  useEffect(() => {
    onEscapeGuardChange?.(escapeGuarded);
  }, [escapeGuarded, onEscapeGuardChange]);

  useInput(
    (input, key) => {
      // Newline intent — Shift+Enter where the terminal transmits it
      // distinctly, plus the universal Ctrl+J fallback. Most terminals
      // (e.g. VTE/GNOME Terminal) send plain \r for Shift+Enter, which is
      // byte-identical to Enter; for those, Ctrl+J or trailing-\ work.
      const newlineIntent =
        input === '\n' || // Ctrl+J (LF) — works everywhere
        (!key.return && input === '\r') || // ESC+CR (iTerm2 / VS Code Shift+Enter) — Ink strips the ESC
        isModifiedEnter(input); // CSI-u modified Enter (kitty/foot/ghostty Shift+Enter = [13;2u)
      if (newlineIntent) {
        editor.insert('\n');
        setSelectedIndex(0);
        return;
      }
      // Esc dismisses the slash-command picker or a recalled history line —
      // clearing the buffer so the hint strip goes away.
      //
      // This fires during a turn too (#202): the Prompt is no longer disabled
      // while Bernard works, so App's interrupt handler sees the same key. It
      // is App that stands down, on the boolean reported by
      // `onEscapeGuardChange` — which is exactly the condition tested here, so
      // "Esc was handled" and "Esc will be handled" cannot answer differently.
      if (key.escape) {
        if (escapeGuarded) {
          editor.clear();
          setSelectedIndex(0);
          setHistoryCursor(null);
        }
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
      // The shared list keystream: ↑/↓ over the matches and Enter to run the
      // highlighted one (#589). AFTER the history rail, which outranks it so
      // ↑/↓ keep walking history even when a recalled line looks like a slash
      // command — that ordering has a test, and getting it wrong is silent:
      // `listNavIntent` claims ↑ whenever anything matches, so the second ↑ of
      // a recall would move the picker instead of the history.
      //
      // BEFORE the literal-buffer Enter below, which is what makes the
      // highlighted command beat what was typed. Safe to sit there because
      // `total === 0` makes `listNavIntent` answer `null` for every key, so
      // with nothing matching this line is not in the way at all.
      if (handleListKey(input, key)) return;
      if (key.return) {
        // A highlighted slash command has already won over the literal buffer:
        // `handleListKey` above claims Enter whenever there are matches. This
        // branch is the no-matches path only.
        //
        // Trailing-\ continuation (Claude Code convention): swap the
        // backslash for a newline instead of submitting.
        if (buffer.endsWith('\\')) {
          editor.setBuffer(buffer.slice(0, -1) + '\n');
          return;
        }
        const text = buffer.trim();
        if (text.length === 0) {
          // Keyed on `trim()`, not on `bufferEmpty` — a buffer of spaces is
          // equally unsubmittable, and the two predicates genuinely disagree
          // (`bufferEmpty` tests `.length`). Whichever this is, the buffer is
          // cleared: leaving whitespace behind would make the next Enter a
          // no-op again for a reason nothing on screen explains.
          if (buffer.length > 0) editor.clear();
          onEmptySubmit?.();
          return;
        }
        editor.clear();
        setSelectedIndex(0);
        setHistoryCursor(null);
        onRecordInput?.(text);
        onSubmit(text);
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
        const picked = matches[selectedIndex];
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
      <SlashHints
        matches={matches}
        selectedIndex={selectedIndex}
        offset={offset}
        maxRows={pickerRows}
      />
    </Box>
  );
}
