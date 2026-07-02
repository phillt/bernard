import { memo, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Box, Text, measureElement, useInput } from 'ink';
import { getThemeColors } from '../theme.js';
import { useDimensionsCtx } from './DimensionsContext.js';
import { useMouseWheel } from './useMouseWheel.js';
import { ErrorPanel } from './ErrorPanel.js';
import { MessageBlock, StreamingAssistantMessage, type StaticItem } from './Thread.js';
import type { MessageStore } from './message-store.js';

/** Lines moved per mouse-wheel tick / arrow press. */
const WHEEL_STEP = 3;

interface TranscriptViewportProps {
  /** Append-only log of finalized turns. */
  items: StaticItem[];
  messageStore?: MessageStore;
  busy?: boolean;
  interrupted?: boolean;
  streamingToolDetails?: boolean;
  /**
   * True when the input line is empty (or disabled while busy), so Home/End may
   * jump the transcript without stealing those keys from the line editor. Plain
   * arrows and letter keys are deliberately NOT bound — Ink broadcasts every
   * keypress to all `useInput`s with no stop-propagation, so they would collide
   * with history recall / text entry in `<Prompt>`.
   */
  promptEmpty?: boolean;
  /** Whether mouse-wheel capture is active (BERNARD_DISABLE_MOUSE off). */
  mouseEnabled?: boolean;
  /** Optional content rendered above the first turn (e.g. the welcome splash). */
  header?: ReactNode;
}

const MemoMessageBlock = memo(MessageBlock);

/**
 * Full-screen transcript: a fixed-height, line-scrollable window over the
 * append-only turn log plus the in-flight streaming turn. Replaces Ink's
 * `<Static>` (which writes to terminal scrollback — unavailable in the
 * alternate screen buffer).
 *
 * Scrolling is implemented with the standard Ink technique: render the full
 * content in an inner column shifted up by `marginTop={-offset}` inside an
 * `overflow="hidden"` viewport box. This reuses the existing `<MessageBlock>` /
 * `<StreamingAssistantMessage>` components verbatim (no second rendering path to
 * drift from), and `measureElement` gives the real content + viewport heights so
 * the offset is clamped exactly and "stick to bottom" tracks streaming growth.
 */
export function TranscriptViewport({
  items,
  messageStore,
  busy,
  interrupted,
  streamingToolDetails = false,
  promptEmpty = false,
  mouseEnabled = false,
  header,
}: TranscriptViewportProps) {
  const colors = getThemeColors();
  useDimensionsCtx(); // re-render (and re-measure) on terminal resize
  // Subscribe to the stream so a token delta re-renders this component (not just
  // the child below) — that's what re-runs the measure effect and lets the
  // bottom-stick offset follow the growing in-flight turn.
  const noopSubscribe = useRef(() => () => {}).current;
  const noopSnapshot = useRef(() => 0).current;
  useSyncExternalStore<unknown>(
    messageStore?.subscribe ?? noopSubscribe,
    messageStore?.getSnapshot ?? noopSnapshot,
  );
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [viewportH, setViewportH] = useState(0);
  const [contentH, setContentH] = useState(0);
  // Scroll offset in lines from the top of the content. `stick` pins the window
  // to the bottom so new output (and streaming deltas) stay in view until the
  // user scrolls up.
  const [offset, setOffset] = useState(0);
  const [stick, setStick] = useState(true);

  // Re-measure after every commit. measureElement is synchronous; the change
  // guards keep this from looping (heights settle within a frame or two). Runs
  // each streaming delta too — `messageStore` re-renders this component via the
  // child below — so `contentH` tracks the growing in-flight turn.
  useEffect(() => {
    if (outerRef.current) {
      const m = measureElement(outerRef.current);
      if (m.height > 0 && m.height !== viewportH) setViewportH(m.height);
    }
    if (innerRef.current) {
      const m = measureElement(innerRef.current);
      if (m.height !== contentH) setContentH(m.height);
    }
  });

  const maxOffset = Math.max(0, contentH - viewportH);
  const effectiveOffset = stick ? maxOffset : Math.min(offset, maxOffset);

  // Re-stick once the user scrolls back to the bottom so streaming resumes
  // following. Also keeps `stick` honest after a resize grows the viewport.
  useEffect(() => {
    if (!stick && effectiveOffset >= maxOffset) setStick(true);
  }, [stick, effectiveOffset, maxOffset]);

  const scrollBy = (deltaLines: number) => {
    if (maxOffset === 0) return; // nothing to scroll
    const base = stick ? maxOffset : Math.min(offset, maxOffset);
    const next = Math.max(0, Math.min(maxOffset, base + deltaLines));
    setStick(next >= maxOffset);
    setOffset(next);
  };

  useMouseWheel((event) => {
    scrollBy(event.direction === 'up' ? -WHEEL_STEP : WHEEL_STEP);
  }, mouseEnabled);

  useInput((input, key) => {
    const page = Math.max(1, viewportH - 1);
    if (key.pageUp) scrollBy(-page);
    else if (key.pageDown) scrollBy(page);
    // Home/End aren't named keys in Ink — match their raw escape sequences, and
    // only when the input line is empty so they don't fight the line editor.
    else if (promptEmpty && (input === '\x1b[H' || input === '\x1b[1~')) {
      setStick(false);
      setOffset(0);
    } else if (promptEmpty && (input === '\x1b[F' || input === '\x1b[4~')) {
      setStick(true);
      setOffset(maxOffset);
    }
  });

  const scrolledUp = !stick && effectiveOffset < maxOffset;
  // Reserve a row for the position indicator so the content height math stays
  // honest; the indicator sits just below the windowed content.
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box ref={outerRef} flexDirection="column" flexGrow={1} overflow="hidden">
        <Box ref={innerRef} flexDirection="column" marginTop={-effectiveOffset} flexShrink={0}>
          {header}
          {items.map((item) => (
            <Box key={item.key} flexDirection="column">
              {item.error ? (
                <ErrorPanel data={item.error} />
              ) : item.message ? (
                <MemoMessageBlock
                  message={item.message}
                  rewriteOriginal={item.rewriteOriginal}
                  timing={item.timing}
                  costUsd={item.costUsd}
                  toolDetails={item.toolDetails}
                />
              ) : null}
            </Box>
          ))}
          {busy && messageStore && (
            <StreamingAssistantMessage store={messageStore} toolDetails={streamingToolDetails} />
          )}
          {!busy && interrupted && (
            <Box marginTop={1}>
              <Text color={colors.muted} italic>
                ⏹ you interrupted
              </Text>
            </Box>
          )}
        </Box>
      </Box>
      {scrolledUp && (
        <Box justifyContent="space-between">
          <Text color={colors.muted} dimColor>
            ↑ scrolled · PgUp/PgDn{promptEmpty ? ' · Home/End' : ''}
            {mouseEnabled ? ' · wheel' : ''}
          </Text>
          {busy && <Text color={colors.accent}>↓ new output</Text>}
        </Box>
      )}
    </Box>
  );
}
