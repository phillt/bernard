import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import { KEY, HINT_MOVE, HINT_SELECT, HINT_CANCEL } from '../hints.js';
import { isDismissKeyWithQ } from './overlay-contract.js';
import { useListCursor, useListWindow } from './use-list-cursor.js';
import {
  chromeRows,
  countItemsBefore,
  entryIndexOfItem,
  isSection,
  itemsOf,
  overlayViewport,
  pullBackSection,
} from './menu-geometry.js';
import { listPosition } from './viewer-util.js';
import { useDimensionsCtx } from '../DimensionsContext.js';
import type { MenuEntry, MenuItem, MenuOptions } from '../menu-types.js';
import { MenuRow } from './MenuRow.js';
import { OverlayFooter, OVERLAY_FOOTER_ROWS } from './OverlayFooter.js';

interface MenuOverlayBaseProps {
  entries: MenuEntry[];
  options?: MenuOptions;
  onCancel: () => void;
  /**
   * Rows consumed by chrome OUTSIDE this overlay, which only the caller knows:
   * the alert banner, and legacy inline mode where the overlay is appended
   * below the live prompt instead of replacing it. Same shape and reasoning as
   * `BoundedLine`'s `reserveColumns` — each caller passes its own because only
   * it knows what box it sits in.
   */
  reserveRows?: number;
}

/**
 * Single- vs multi-select is a discriminated union so the right commit callback
 * is required by the type: `multiSelect: true` demands `onMultiSelect` (and
 * forbids `onSelect`); the default single-select mode uses `onSelect`. This
 * makes "set multiSelect but forget onMultiSelect" unrepresentable.
 */
type MenuOverlayProps = MenuOverlayBaseProps &
  (
    | {
        multiSelect?: false;
        /** Single-select commit — receives the highlighted/picked row. */
        onSelect?: (index: number, item: MenuItem) => void;
        onMultiSelect?: never;
      }
    | {
        /**
         * Multi-select mode ("select all that apply"). Space and digits toggle a
         * per-row checkbox instead of committing; Enter commits the whole checked
         * set via {@link onMultiSelect} (falling back to the highlighted row when
         * nothing is checked). Issue #231.
         */
        multiSelect: true;
        /** Commit callback for multi-select mode — receives the checked items in row order. */
        onMultiSelect: (items: MenuItem[]) => void;
        onSelect?: never;
      }
  );

/**
 * Replaces `selectFromMenu` from `src/menu.ts` with an Ink overlay.
 *
 * Keyboard contract matches the legacy menu (`src/menu.ts:325-360`):
 *   - ↑/↓ moves the highlight (sections are skipped)
 *   - digits 1-9 commit the matching item immediately
 *   - Enter commits the highlighted item
 *   - Esc / q cancel (see `overlay-contract.ts`; Ctrl-C quits Bernard and
 *     never reaches an overlay — #360)
 *
 * Section dividers from `MenuEntry` are rendered as muted headers between
 * items, never selectable. `options.headerLines` renders above the title so
 * the `ask_user` tab strip continues to work unchanged.
 */
export function MenuOverlay({
  entries,
  options,
  onSelect,
  onCancel,
  reserveRows = 0,
  multiSelect = false,
  onMultiSelect,
}: MenuOverlayProps) {
  const colors = getThemeColors();
  // Terminal size comes from the context, never `useStdout`: the context is the
  // one reactive source (it subscribes to SIGWINCH once at the top of the tree),
  // and under the test renderer the two disagree — no provider falls back to 80
  // columns while ink-testing-library's stdout reports 100.
  const { columns: termColumns, rows: termRows } = useDimensionsCtx();
  const items = itemsOf(entries);
  // Set of *item* indices (sections excluded) currently checked. Multi-select only.
  const [checked, setChecked] = useState<Set<number>>(() => new Set());

  const toggle = (idx: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });

  const commit = (idx: number) => {
    if (multiSelect) {
      // Commit the checked set in row order; fall back to the highlighted row
      // when nothing is checked so Enter is never a no-op.
      const picked =
        checked.size > 0 ? items.filter((_, i) => checked.has(i)) : items[idx] ? [items[idx]] : [];
      // The discriminated-union props type requires onMultiSelect in
      // multi-select mode; the fallback is belt-and-suspenders for untyped JS
      // callers so a missing handler can never strand the overlay.
      if (onMultiSelect) onMultiSelect(picked);
      else onCancel();
      return;
    }
    const item = items[idx];
    if (item) onSelect?.(idx, item);
  };

  // The cursor starts on the caller-requested item (clamped) so a looping
  // manager can restore it when it re-shows a list; defaults to the first item.
  //
  // Multi-select's one difference — a digit TOGGLES rather than commits — is
  // the VALUE of `onDigit`, not a mode flag in the shared module: `list-nav.ts`
  // answers "which index did the user name?", and this overlay answers "what
  // does naming an index mean here?".
  const { index: highlight, handleKey } = useListCursor({
    total: items.length,
    initialIndex: options?.initialIndex ?? 0,
    onCommit: commit,
    toggleOnSpace: multiSelect,
    onToggle: toggle,
    onDigit: multiSelect ? toggle : commit,
  });

  useInput((input, key) => {
    // Dismissal is decided first, ahead of the shared list keystream, so
    // "dismiss beats digit" stays a readable if-chain — see the note on
    // `useListCursor` for why the hook does not own a `useInput` of its own.
    if (isDismissKeyWithQ(input, key)) {
      onCancel();
      return;
    }
    handleKey(input, key);
  });

  // Split layout: numbered list on the left, a bordered detail card for the
  // highlighted row on the right. Falls back to the classic single column when
  // no detail renderer is supplied. Multi-select never uses split (checkboxes
  // belong in a flat list), so the branch is single-select only.
  const isSplit = options?.layout === 'split' && !multiSelect && !!options?.renderDetail;
  const highlightedItem = items[highlight];

  // Windowing (#266). The cursor is in ITEM space and the window in ENTRY
  // space; `entryIndexOfItem` / `countItemsBefore` are the only conversion.
  //
  // Rows are uniform-plus-a-constant — every entry is one row except the
  // highlighted one, which adds a second when it carries a description — so ONE
  // reserved row makes `clampOffset` apply as-is. See `menu-geometry.ts` for why
  // that beats a variable-cost algorithm.
  //
  // App wraps the overlay in paddingX={2}, so the usable width is columns - 4.
  // Header lines and the title are MEASURED rather than charged a flat row
  // each: an `ask_user` question or a long title soft-wraps to two, and a
  // constant would silently hand back a row the frame does not have.
  const usableColumns = termColumns - 4;
  // The widest description any row could show, so the reserved height is stable
  // as the highlight moves. Split layout suppresses descriptions entirely.
  const longestDescription = isSplit
    ? undefined
    : items.reduce<string | undefined>(
        (longest, item) =>
          item.description && item.description.length > (longest?.length ?? 0)
            ? item.description
            : longest,
        undefined,
      );
  const headerLines = options?.headerLines ?? [];
  const chrome =
    1 /* the marginTop below */ +
    chromeRows([...headerLines, options?.title], usableColumns) +
    (headerLines.length > 0 ? 1 : 0) /* blank after the header block */ +
    (options?.title ? 1 : 0) /* blank after the title */ +
    // The highlighted row's description, MEASURED for the same reason the title
    // is. It renders at `marginLeft={4}` inside App's `paddingX={2}`, so it
    // wraps at `columns - 8` — 72 on an 80-column terminal — and real menu
    // content already exceeds that (`domains.ts` and the profile wizard both
    // carry 76–79-char descriptions). A flat row here would under-count by one
    // on exactly those entries and overflow the frame: the defect this
    // windowing exists to fix, reintroduced by the one term that wasn't
    // measured. Reserved unconditionally rather than only when the highlighted
    // entry has a description, so moving the cursor never resizes the window.
    chromeRows([longestDescription], usableColumns - 4) +
    OVERLAY_FOOTER_ROWS /* blank + position line + HintRow */ +
    reserveRows;
  const viewport = overlayViewport(termRows, chrome);
  const cursorEntry = entryIndexOfItem(entries, highlight);
  const { offset: rawOffset } = useListWindow(cursorEntry, viewport, entries.length);
  const offset = pullBackSection(entries, rawOffset, viewport, cursorEntry);
  const visibleEntries = entries.slice(offset, offset + viewport);

  // The position line counts ITEMS, not entries — a section header is not
  // something the user can be "on", so `items 3–9 of 40` is the number that
  // matches the digits printed beside the rows.
  const itemsBefore = countItemsBefore(entries, offset);
  const visibleItemCount = itemsOf(visibleEntries).length;
  const pos = listPosition(itemsBefore, visibleItemCount, items.length);
  const position = pos ? `items ${pos.first}–${pos.last} of ${pos.total}` : null;

  return (
    <Box flexDirection="column" marginTop={1}>
      {options?.headerLines?.map((line, idx) => (
        <Text key={`h-${idx}`}>{line}</Text>
      ))}
      {options?.headerLines && options.headerLines.length > 0 && <Text> </Text>}
      {options?.title && (
        <>
          <Text color={colors.accent} bold>
            {options.title}
          </Text>
          <Text> </Text>
        </>
      )}
      {isSplit ? (
        <Box flexDirection="row">
          <Box flexDirection="column" marginRight={3}>
            <MenuList
              entries={visibleEntries}
              startEntry={offset}
              itemsBefore={itemsBefore}
              highlight={highlight}
              multiSelect={false}
              checked={checked}
              suppressDescription
            />
          </Box>
          {highlightedItem && (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={colors.muted}
              paddingX={1}
              minWidth={50}
            >
              <Text color={colors.accent} bold>
                {highlightedItem.label}
              </Text>
              <Text> </Text>
              {options!.renderDetail!(highlightedItem)}
            </Box>
          )}
        </Box>
      ) : (
        <MenuList
          entries={visibleEntries}
          startEntry={offset}
          itemsBefore={itemsBefore}
          highlight={highlight}
          multiSelect={multiSelect}
          checked={checked}
        />
      )}
      <OverlayFooter
        position={position}
        hints={[
          HINT_MOVE,
          ...(multiSelect
            ? [
                { key: KEY.space, label: 'toggle' },
                { key: KEY.enter, label: 'confirm' },
              ]
            : [HINT_SELECT]),
          HINT_CANCEL,
        ]}
      />
    </Box>
  );
}

function MenuList({
  entries,
  startEntry,
  itemsBefore,
  highlight,
  multiSelect = false,
  checked,
  suppressDescription = false,
}: {
  /** The VISIBLE window of entries. */
  entries: MenuEntry[];
  /** Index in the FULL list that `entries[0]` came from — seeds the React keys. */
  startEntry: number;
  /**
   * Selectable items scrolled off the top. Passed in rather than recomputed
   * here: the parent already needs it for the position line, and a second
   * `countItemsBefore` call with the same arguments is one more place for the
   * seed below to go wrong.
   */
  itemsBefore: number;
  highlight: number;
  multiSelect?: boolean;
  checked?: Set<number>;
  /** Split layout hides the per-row description — the detail card shows it. */
  suppressDescription?: boolean;
}) {
  const colors = getThemeColors();
  // Seeded with the items scrolled off the top, NOT 0. Three things read this
  // counter — the number printed beside the row, the digit shortcut's target,
  // and `checked.has(i)` — so a zero seed on a scrolled multi-select renumbers
  // the visible rows and ticks the wrong box.
  let itemIndex = itemsBefore;
  return (
    <Box flexDirection="column">
      {entries.map((entry, idx) => {
        if (isSection(entry)) {
          return (
            <Text key={`s-${startEntry + idx}`} color={colors.muted}>
              {entry.title}
            </Text>
          );
        }
        // Digits stay ABSOLUTE: the number beside a row is its index in the
        // whole menu, so `3` always names the third item whether or not the
        // window has scrolled. Window-relative numbering would make every
        // printed number lie the moment the list moved.
        const n = itemIndex + 1;
        const myIndex = itemIndex;
        itemIndex++;
        const activeMarker = entry.active ? ' (active)' : '';
        const annotation = entry.annotation ? ` ${entry.annotation}` : '';
        const isHighlighted = myIndex === highlight;
        const checkbox = multiSelect ? `${checked?.has(myIndex) ? '[x]' : '[ ]'} ` : '';
        const label = `${checkbox}${n}. ${entry.label}${activeMarker}${annotation}`;
        return (
          <Box key={`i-${startEntry + idx}`} flexDirection="column">
            <MenuRow selected={isHighlighted} label={label} />
            {!suppressDescription && isHighlighted && entry.description && (
              <Box marginLeft={4}>
                <Text dimColor>{entry.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
