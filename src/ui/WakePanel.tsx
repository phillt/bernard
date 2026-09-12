import { Box, Text } from 'ink';

import { getThemeColors } from '../theme.js';
import { formatBytes } from '../output.js';
import { plural } from '../text.js';
import { WAKE_EXCERPT_CHARS } from '../watchers/wake.js';
import { TranscriptPanel } from './TranscriptPanel.js';
import type { WakeData } from './Thread.js';

/**
 * Announces a turn that nobody typed (#479/#493).
 *
 * ## Why it renders BEFORE the turn rather than after
 *
 * The transcript has to record where an instruction came from, and it has to do
 * so at the point a reader would otherwise assume they typed it. Rendered after,
 * it explains a turn the reader has already finished misreading.
 *
 * ## Why it takes neither chevron
 *
 * The same argument {@link NoticePanel} makes. `❯` and `❮` are the transcript's
 * entire voice vocabulary — the user and Bernard — and a woken turn is neither:
 * it is the *reason* Bernard is about to speak. Rendering it behind `❯` would
 * make a watcher look like the user, which is exactly the confusion the two-
 * channel split exists to prevent one layer down.
 *
 * The distinction from `NoticePanel` is the footer, and it is the whole
 * difference between the two features: a notice ends with "Bernard has not seen
 * this", because acting on it costs a turn the reader must choose to spend. This
 * one is the turn. Saying so is what stops a reader assuming the same.
 *
 * ## What it shows of the observation, and why it is never the observation
 *
 * This panel is now the ONLY render of a wake — `App.tsx` suppresses the
 * duplicate user bubble that used to paint the instruction and the whole fenced
 * observation into the transcript seconds later.
 *
 * So the rule the old docstring stated — the observation is "deliberately not
 * shown here" — holds in the form that matters and no longer in the form it was
 * written: the panel says how much was observed, and at `toolDetails` on, up to
 * {@link WAKE_EXCERPT_CHARS} characters of it. What it must never hold is the
 * payload itself. `WakeData.observation` is an {@link ObservationSummary},
 * capped at the mint in `summariseObservation`, because this item lives in an
 * append-only array for the whole session and the thing it describes can be
 * megabytes of somebody's inbox.
 *
 * ## Detail level
 *
 * `toolDetails` is the same boolean that decides how much of a tool call the
 * transcript shows, applied to the same question one layer over: how much of
 * what Bernard is acting on does the reader want on screen. There is no wake-
 * specific setting, deliberately — a second knob for one surface is two places
 * to reason about the same preference.
 */
export function WakePanel({ data, toolDetails }: { data: WakeData; toolDetails: boolean }) {
  const colors = getThemeColors();
  const lines = data.instruction.split('\n');
  const obs = data.observation;

  // OFF: the first line that says anything. A wake instruction frequently opens
  // with a blank or a heading rule, and a body whose first row is empty reads as
  // a panel that failed to render.
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  const body = toolDetails ? data.instruction : firstIdx === -1 ? '' : lines[firstIdx];
  const hiddenLines = toolDetails ? 0 : Math.max(0, lines.length - (firstIdx === -1 ? 0 : 1));

  const sizeNote = obs ? `${formatBytes(obs.bytes)} observed` : '';

  return (
    <TranscriptPanel
      color={colors.accent}
      title="⏰ Woken"
      meta={` · ${data.source}`}
      body={body}
      detail={
        toolDetails ? (
          obs ? (
            // The vocabulary of `renderResultSnippet` — `↳`, dim, a two-space
            // continuation — but not the function: that one is private to
            // `Thread.tsx` and takes the full text, so reusing it would mean
            // plumbing the whole observation here for it to re-truncate. The
            // excerpt is already bounded at the mint.
            <Box flexDirection="column">
              <Text dimColor>↳ {obs.excerpt}</Text>
              <Text dimColor>
                {'  '}· {sizeNote}
                {obs.clipped ? `, showing first ${WAKE_EXCERPT_CHARS}` : ''}
              </Text>
            </Box>
          ) : null
        ) : (
          // One row, joining whichever halves exist. Both absent — a one-line
          // instruction on a `time` watcher — and the row is dropped entirely
          // rather than rendered empty.
          collapsedNote(hiddenLines, sizeNote)
        )
      }
      hintColor={colors.accent}
      footer="Bernard is acting on this now."
    />
  );
}

function collapsedNote(hiddenLines: number, sizeNote: string) {
  const parts: string[] = [];
  if (hiddenLines > 0) {
    parts.push(`… ${hiddenLines} more instruction ${plural(hiddenLines, 'line', 'lines')}`);
  }
  if (sizeNote) parts.push(sizeNote);
  if (parts.length === 0) return null;
  return <Text dimColor>{parts.join(' · ')}</Text>;
}
