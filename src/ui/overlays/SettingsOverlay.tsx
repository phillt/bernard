import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import type { MenuEntry, MenuItem } from '../menu-types.js';
import { ViewerShell, type OverlayTab } from './ViewerShell.js';
import { MenuRow } from './MenuRow.js';
import { HINT_MOVE, HINT_SELECT, HINT_SWITCH_TAB, HINT_CLOSE } from '../hints.js';
import { isShellOwnedKey } from './overlay-contract.js';
import { useListCursor } from './use-list-cursor.js';
import { isSection, itemsOf } from './menu-geometry.js';

/** The settings tabs, in cycle order. `id` matches the `SettingsTab` union. */
export type SettingsTab = 'options' | 'agent-options';
export const SETTINGS_TABS: readonly OverlayTab[] = [
  { id: 'options', label: 'Options' },
  { id: 'agent-options', label: 'Agent options' },
];

const KEY_HINTS = [HINT_MOVE, HINT_SELECT, HINT_SWITCH_TAB, HINT_CLOSE];

interface SettingsOverlayProps {
  initialTab: SettingsTab;
  /** Item index (sections excluded) to restore the cursor onto when re-shown. */
  initialIndex: number;
  optionsEntries: MenuEntry[];
  agentEntries: MenuEntry[];
  /** Commit — receives the active tab plus the item index (sections excluded). */
  onSelect: (tab: SettingsTab, index: number, item: MenuItem) => void;
  onClose: () => void;
}

/**
 * The tabbed settings screen — the interactive analogue of the read-only
 * Shift+Tab viewers. Reuses the shared {@link ViewerShell} chrome (bottom tab
 * strip + theme legend) with "Options" / "Agent options" as its two tabs, so
 * `/options` and `/agent-options` open the same frame on their respective tab
 * and Shift+Tab cycles between them. Owns the ↑/↓ / Enter / digit keystream;
 * ViewerShell owns Esc (close) and Shift+Tab (cycle) — the latter flips the tab
 * in place rather than closing.
 */
export function SettingsOverlay({
  initialTab,
  initialIndex,
  optionsEntries,
  agentEntries,
  onSelect,
  onClose,
}: SettingsOverlayProps) {
  const colors = getThemeColors();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const entries = tab === 'options' ? optionsEntries : agentEntries;
  const items = itemsOf(entries);
  const {
    index: highlight,
    setIndex: setHighlight,
    handleKey,
  } = useListCursor({
    total: items.length,
    initialIndex,
    onCommit: (idx) => {
      const item = items[idx];
      if (item) onSelect(tab, idx, item);
    },
  });

  useInput((input, key) => {
    // Esc + Shift+Tab belong to ViewerShell (close / cycle-tab); Ink dispatches
    // to both handlers, so this one must decline them explicitly. A
    // pre-condition, not a branch — which is exactly why `useListCursor` hands
    // back a `handleKey` instead of owning a second `useInput` of its own.
    if (isShellOwnedKey(input, key)) return;
    handleKey(input, key);
  });

  const highlighted = items[highlight];

  return (
    <ViewerShell
      tabs={SETTINGS_TABS}
      activeTab={tab}
      position={null}
      keyHints={KEY_HINTS}
      onClose={onClose}
      onCycleTab={() => {
        setTab((t) => (t === 'options' ? 'agent-options' : 'options'));
        setHighlight(0);
      }}
    >
      <SettingsList entries={entries} highlight={highlight} />
      <Text> </Text>
      {highlighted?.description ? (
        <Text color={colors.muted}>{highlighted.description}</Text>
      ) : (
        <Text> </Text>
      )}
    </ViewerShell>
  );
}

function SettingsList({ entries, highlight }: { entries: MenuEntry[]; highlight: number }) {
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
        const label = `${n}. ${entry.label}${activeMarker}${annotation}`;
        return <MenuRow key={`i-${idx}`} selected={myIndex === highlight} label={label} />;
      })}
    </Box>
  );
}
