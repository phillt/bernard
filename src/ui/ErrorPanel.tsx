import { Box, Text } from 'ink';
import { getThemeColors } from '../theme.js';
import type { ErrorPanelData } from './error-format.js';

/**
 * A bordered, error-styled transcript item for a failed turn. Replaces the old
 * raw `⚠ Agent error: <stack…>` assistant message: a rounded error-colored
 * frame with a friendly title + category tag, the unwrapped provider message,
 * a recovery hint, and (debug only) the dim stack/cause beneath.
 */
export function ErrorPanel({ data }: { data: ErrorPanelData }) {
  const colors = getThemeColors();
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={colors.error}
      paddingX={1}
    >
      <Box>
        <Text color={colors.error} bold>
          ⚠ {data.title}
        </Text>
        <Text dimColor> · {data.category}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{data.message}</Text>
      </Box>
      {data.hint && (
        <Box marginTop={1}>
          <Text color={colors.warning}>→ {data.hint}</Text>
        </Box>
      )}
      {data.details && (
        <Box flexDirection="column" marginTop={1}>
          {data.details.split('\n').map((line, i) => (
            <Text key={i} dimColor>
              {line.length === 0 ? ' ' : line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
