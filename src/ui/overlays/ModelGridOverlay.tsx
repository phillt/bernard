import { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { getThemeColors } from '../../theme.js';
import { truncate } from '../../text.js';

export interface ModelGridOverlayProps {
  title?: string;
  footer?: string;
  items: string[];
  initialIndex?: number;
  currentItem?: string;
  onSelect: (index: number) => void;
  onCancel: () => void;
  signal?: AbortSignal;
}

const MIN_TERM_WIDTH = 50;
const CELL_GUTTER = 4;
const MAX_COLUMNS = 4;

function computeColumns(termWidth: number, longestItemLen: number): number {
  if (termWidth < MIN_TERM_WIDTH) return 1;
  const usable = Math.max(1, termWidth - 4);
  const cellWidth = longestItemLen + CELL_GUTTER;
  return Math.max(1, Math.min(MAX_COLUMNS, Math.floor(usable / cellWidth)));
}

/**
 * Sister to `MenuOverlay`, but lays items out in a width-adaptive grid.
 *
 * Built for the lineup model picker where one provider can have 40+ models
 * and a single column scrolls off-screen. The grid keeps the eye-saccade
 * count low while staying within `MenuOverlay`'s keyboard idioms (Esc
 * cancels, Enter commits, abort signal pre-aborts to cancel).
 */
export function ModelGridOverlay({
  title,
  footer,
  items,
  initialIndex = 0,
  currentItem,
  onSelect,
  onCancel,
  signal,
}: ModelGridOverlayProps) {
  const colors = getThemeColors();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  const longestItemLen = items.reduce((m, s) => Math.max(m, s.length), 1);
  const columns = computeColumns(termWidth, longestItemLen);
  const cellWidth = Math.min(
    longestItemLen + CELL_GUTTER,
    Math.max(8, Math.floor((termWidth - 4) / columns)),
  );

  const [highlight, setHighlight] = useState(
    Math.max(0, Math.min(items.length - 1, initialIndex)),
  );

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
    if (items.length === 0) {
      if (key.escape || (key.ctrl && input === 'c')) onCancel();
      return;
    }
    if (key.ctrl && input === 'c') {
      onCancel();
      return;
    }
    if (key.escape || input === 'q') {
      onCancel();
      return;
    }
    if (key.return) {
      onSelect(highlight);
      return;
    }
    if (key.leftArrow) {
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.rightArrow) {
      setHighlight((h) => Math.min(items.length - 1, h + 1));
      return;
    }
    if (key.upArrow) {
      setHighlight((h) => Math.max(0, h - columns));
      return;
    }
    if (key.downArrow) {
      setHighlight((h) => Math.min(items.length - 1, h + columns));
      return;
    }
  });

  const rows: number[][] = [];
  for (let i = 0; i < items.length; i += columns) {
    rows.push(items.slice(i, i + columns).map((_, j) => i + j));
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {title && (
        <>
          <Text color={colors.accent} bold>
            {title}
          </Text>
          <Text> </Text>
        </>
      )}
      {footer && (
        <>
          <Text dimColor>{footer}</Text>
          <Text> </Text>
        </>
      )}
      <Box flexDirection="column">
        {rows.map((row, rowIdx) => (
          <Box key={`r-${rowIdx}`} flexDirection="row">
            {row.map((cellIndex) => {
              const value = items[cellIndex];
              const isHighlighted = cellIndex === highlight;
              const isCurrent = currentItem !== undefined && value === currentItem;
              const inner = `${value}${isCurrent ? ' *' : ''}`;
              const text = truncate(inner, cellWidth - 2);
              return (
                <Box key={`c-${cellIndex}`} width={cellWidth}>
                  <Text color={colors.accent}>{isHighlighted ? '> ' : '  '}</Text>
                  <Text bold={isHighlighted} color={isHighlighted ? colors.accent : undefined}>
                    {text}
                  </Text>
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
      <Text> </Text>
      <Text dimColor>
        ←/→/↑/↓ move · Enter select · Esc back
        {currentItem !== undefined ? ' · * = current' : ''}
      </Text>
    </Box>
  );
}
