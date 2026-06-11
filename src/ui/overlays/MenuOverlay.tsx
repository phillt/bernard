import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import type { MenuEntry, MenuItem, MenuOptions } from '../menu-types.js';
import { MenuRow } from './MenuRow.js';

interface MenuOverlayBaseProps {
  entries: MenuEntry[];
  options?: MenuOptions;
  onCancel: () => void;
  /**
   * Optional external cancel signal. The legacy `selectFromMenu` accepts one
   * via `MenuOptions.signal` so a parent (e.g. an aborted agent turn) can drop
   * a stale menu without user interaction. Mirroring that here keeps the
   * `askUser` and confirm-action paths unaffected when the user presses Esc
   * mid-turn.
   */
  signal?: AbortSignal;
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

function isSection(entry: MenuEntry): entry is { type: 'section'; title: string } {
  return 'type' in entry && entry.type === 'section';
}

/**
 * Replaces `selectFromMenu` from `src/menu.ts` with an Ink overlay.
 *
 * Keyboard contract matches the legacy menu (`src/menu.ts:325-360`):
 *   - ↑/↓ moves the highlight (sections are skipped)
 *   - digits 1-9 commit the matching item immediately
 *   - Enter commits the highlighted item
 *   - Esc / q / Ctrl-C cancel
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
  signal,
  multiSelect = false,
  onMultiSelect,
}: MenuOverlayProps) {
  const colors = getThemeColors();
  const items = entries.filter((e): e is MenuItem => !isSection(e));
  // Start on the caller-requested item (clamped) so a looping manager can
  // restore the cursor when it re-shows a list; defaults to the first item.
  const [highlight, setHighlight] = useState(() =>
    Math.min(Math.max(0, options?.initialIndex ?? 0), Math.max(0, items.length - 1)),
  );
  // Set of *item* indices (sections excluded) currently checked. Multi-select only.
  const [checked, setChecked] = useState<Set<number>>(() => new Set());

  const toggle = (idx: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });

  useEffect(() => {
    if (!signal) return;
    if (signal.aborted) {
      onCancel();
      return;
    }
    const onAbort = () => onCancel();
    signal.addEventListener('abort', onAbort);
    return () => signal.removeEventListener('abort', onAbort);
  }, [signal, onCancel]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel();
      return;
    }
    if (key.escape || input === 'q') {
      onCancel();
      return;
    }
    if (key.return) {
      if (multiSelect) {
        // Commit the checked set in row order; fall back to the highlighted row
        // when nothing is checked so Enter is never a no-op.
        const picked =
          checked.size > 0
            ? items.filter((_, i) => checked.has(i))
            : items[highlight]
              ? [items[highlight]]
              : [];
        // The discriminated-union props type requires onMultiSelect in
        // multi-select mode; the fallback is belt-and-suspenders for untyped JS
        // callers so a missing handler can never strand the overlay.
        if (onMultiSelect) onMultiSelect(picked);
        else onCancel();
        return;
      }
      const item = items[highlight];
      if (item) onSelect?.(highlight, item);
      return;
    }
    if (key.upArrow) {
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.downArrow) {
      setHighlight((h) => Math.min(items.length - 1, h + 1));
      return;
    }
    // Space toggles the highlighted row in multi-select mode (no-op otherwise).
    if (multiSelect && input === ' ') {
      toggle(highlight);
      return;
    }
    if (/^[1-9]$/.test(input)) {
      const idx = parseInt(input, 10) - 1;
      if (idx < items.length) {
        // In multi-select a digit toggles that row's checkbox; in single-select
        // it commits immediately (unchanged behavior).
        if (multiSelect) toggle(idx);
        else onSelect?.(idx, items[idx]);
      }
    }
  });

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
      <MenuList entries={entries} highlight={highlight} multiSelect={multiSelect} checked={checked} />
      <Text> </Text>
      <Text dimColor>
        {multiSelect
          ? '↑/↓ move · Space toggle · Enter confirm · Esc cancel'
          : '↑/↓ move · Enter select · Esc cancel'}
      </Text>
    </Box>
  );
}

function MenuList({
  entries,
  highlight,
  multiSelect = false,
  checked,
}: {
  entries: MenuEntry[];
  highlight: number;
  multiSelect?: boolean;
  checked?: Set<number>;
}) {
  const colors = getThemeColors();
  let itemIndex = 0;
  return (
    <Box flexDirection="column">
      {entries.map((entry, idx) => {
        if (isSection(entry)) {
          return (
            <Text key={`s-${idx}`} color={colors.muted}>
              {entry.title}
            </Text>
          );
        }
        const n = itemIndex + 1;
        const myIndex = itemIndex;
        itemIndex++;
        const activeMarker = entry.active ? ' (active)' : '';
        const annotation = entry.annotation ? ` ${entry.annotation}` : '';
        const isHighlighted = myIndex === highlight;
        const checkbox = multiSelect ? `${checked?.has(myIndex) ? '[x]' : '[ ]'} ` : '';
        const label = `${checkbox}${n}. ${entry.label}${activeMarker}${annotation}`;
        return (
          <Box key={`i-${idx}`} flexDirection="column">
            <MenuRow selected={isHighlighted} label={label} />
            {isHighlighted && entry.description && (
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
