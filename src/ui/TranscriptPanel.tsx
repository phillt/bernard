import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

/**
 * A bordered transcript block: a titled, coloured frame with body lines and an
 * optional pointer row.
 *
 * Shared by `ErrorPanel` and `NoticePanel`, which had copied the same
 * scaffold — frame, bold-icon-plus-dim-meta header, blank-line-preserving
 * body, `→ hint` row — differing only in a colour token. That is the same
 * argument `StaticItemView` makes one layer up, and it applies here for the
 * same reason: the next panel would otherwise be a third copy, and the two
 * that exist could drift on padding or spacing with nothing to notice.
 *
 * Deliberately not "a panel component that knows about errors and notices":
 * it takes rendered pieces, so each caller keeps its own vocabulary and this
 * file never has to grow a variant switch.
 */
export function TranscriptPanel({
  color,
  title,
  meta,
  body,
  detail,
  hint,
  hintColor,
  footer,
  children,
}: {
  color: string;
  title: string;
  /** Dim text after the title, on the same row. */
  meta?: string;
  /** Body text; blank lines are preserved as blank rows. */
  body: string;
  /**
   * Anything the body needs to be read WITH — rendered directly beneath it and
   * above the hint.
   *
   * Distinct from `children`, which lands below the footer: a disclosure about
   * the body would then sit under the closing line, reading as an afterthought
   * about the panel rather than a fact about its content. Kept generic — name
   * it for the slot, not for one caller's use, or this file grows the variant
   * switch it exists to avoid.
   */
  detail?: ReactNode;
  hint?: string;
  hintColor: string;
  /** Dim closing row, below the hint. */
  footer?: string;
  /** Anything else, after the footer. */
  children?: ReactNode;
}) {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={color} paddingX={1}>
      <Box>
        <Text color={color} bold>
          {title}
        </Text>
        {meta && <Text dimColor>{meta}</Text>}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {body.split('\n').map((line, i) => (
          // A blank line renders as a space: Ink collapses an empty <Text>,
          // which would silently close up the paragraph breaks in a message.
          <Text key={i}>{line.length === 0 ? ' ' : line}</Text>
        ))}
      </Box>
      {detail}
      {hint && (
        <Box marginTop={1}>
          <Text color={hintColor}>→ {hint}</Text>
        </Box>
      )}
      {footer && (
        <Box marginTop={1}>
          <Text dimColor>{footer}</Text>
        </Box>
      )}
      {children}
    </Box>
  );
}
