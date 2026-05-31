import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import type { MenuEntry, MenuItem, MenuOptions } from '../../menu.js';

interface MenuOverlayProps {
  entries: MenuEntry[];
  options?: MenuOptions;
  onSelect: (index: number, item: MenuItem) => void;
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
}: MenuOverlayProps) {
  const colors = getThemeColors();
  const items = entries.filter((e): e is MenuItem => !isSection(e));
  const [highlight, setHighlight] = useState(0);

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
      const item = items[highlight];
      if (item) onSelect(highlight, item);
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
    if (/^[1-9]$/.test(input)) {
      const idx = parseInt(input, 10) - 1;
      if (idx < items.length) onSelect(idx, items[idx]);
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
      <MenuList entries={entries} highlight={highlight} />
      <Text> </Text>
      <Text dimColor>↑/↓ move · Enter select · Esc cancel</Text>
    </Box>
  );
}

function MenuList({ entries, highlight }: { entries: MenuEntry[]; highlight: number }) {
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
        const label = `${n}. ${entry.label}${activeMarker}${annotation}`;
        return (
          <Box key={`i-${idx}`} flexDirection="column">
            <Box>
              <Text color={colors.accent}>{isHighlighted ? '> ' : '  '}</Text>
              <Text bold={isHighlighted} color={isHighlighted ? colors.accent : undefined}>
                {label}
              </Text>
            </Box>
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
