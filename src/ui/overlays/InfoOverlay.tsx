import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import { HintRow } from '../hints.js';
import { isDismissKeyWithQ, KEY, HINT_CLOSE } from './overlay-contract.js';

export interface InfoLine {
  text: string;
  dim?: boolean;
  bold?: boolean;
}

interface InfoOverlayProps {
  title: string;
  lines: InfoLine[];
  onClose: () => void;
}

/**
 * Read-only multi-line display. Used by /policy, /mcp, /cron, /rag, /facts
 * and similar info commands that previously dumped to stdout via printInfo.
 * Esc / Enter / q close.
 */
export function InfoOverlay({ title, lines, onClose }: InfoOverlayProps) {
  const colors = getThemeColors();
  useInput((input, key) => {
    // Enter also closes: these are read-only, so there is nothing to commit
    // and Enter reads as "acknowledge".
    if (isDismissKeyWithQ(input, key) || key.return) onClose();
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent} bold>
        {title}
      </Text>
      <Text> </Text>
      {lines.map((line, idx) => (
        <Text key={idx} dimColor={line.dim} bold={line.bold}>
          {line.text}
        </Text>
      ))}
      <Text> </Text>
      <HintRow
        hints={[{ key: KEY.enter, label: 'close' }, HINT_CLOSE, { key: 'q', label: 'close' }]}
      />
    </Box>
  );
}
