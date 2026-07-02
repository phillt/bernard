import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import type { MenuEntry, MenuItem } from '../menu-types.js';
import { ViewerShell, type OverlayTab } from './ViewerShell.js';
import { MenuRow } from './MenuRow.js';

/** The settings tabs, in cycle order. `id` matches the `SettingsTab` union. */
export type SettingsTab = 'options' | 'agent-options';
export const SETTINGS_TABS: readonly OverlayTab[] = [
  { id: 'options', label: 'Options' },
  { id: 'agent-options', label: 'Agent options' },
];

const KEY_HINTS = [
  { key: '↑/↓', label: 'move' },
  { key: '↵', label: 'select' },
  { key: '⇧⇥', label: 'switch tab' },
  { key: 'esc', label: 'close' },
];

function isSection(entry: MenuEntry): entry is { type: 'section'; title: string } {
  return 'type' in entry && entry.type === 'section';
}

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
  const items = entries.filter((e): e is MenuItem => !isSection(e));
  const [highlight, setHighlight] = useState(() =>
    Math.min(Math.max(0, initialIndex), Math.max(0, items.length - 1)),
  );

  useInput((input, key) => {
    // Esc + Shift+Tab belong to ViewerShell (close / cycle-tab); ignore them here.
    if (key.escape || (key.shift && key.tab)) return;
    if (key.return) {
      const item = items[highlight];
      if (item) onSelect(tab, highlight, item);
      return;
    }
    if (key.upArrow) {
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.downArrow) {
      // Clamp the lower bound to 0 so a tab with no selectable items (only
      // section headers) can't drive highlight negative via items.length - 1.
      setHighlight((h) => Math.max(0, Math.min(items.length - 1, h + 1)));
      return;
    }
    if (/^[1-9]$/.test(input)) {
      const idx = parseInt(input, 10) - 1;
      if (idx < items.length) onSelect(tab, idx, items[idx]);
    }
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
