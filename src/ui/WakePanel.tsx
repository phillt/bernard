import { Box, Text } from 'ink';

import { getThemeColors } from '../theme.js';
import { formatBytes } from '../output.js';
import { plural } from '../text.js';
import { WAKE_EXCERPT_CHARS, type ObservationSummary } from '../watchers/wake.js';
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
  const obs = data.observation;
  // Computed only where it is read: the expanded branch takes the instruction
  // whole and asks nothing about its lines, so scanning them there was work
  // whose result had no consumer.
  const collapsed = toolDetails ? null : collapseInstruction(data.instruction);

  // Keyed on `collapsed` rather than on `toolDetails` so the narrowing is the
  // type system's rather than a non-null assertion's — they carry the same
  // information, since `collapsed` is null exactly when `toolDetails` is on.
  const detail = collapsed ? (
    // One row, joining whichever halves exist. Both absent — a one-line
    // instruction on a `time` watcher — and the row is dropped entirely rather
    // than rendered empty.
    collapsedNote(collapsed.hidden, obs)
  ) : obs ? (
    // The vocabulary of `renderResultSnippet` — `↳`, dim, a two-space
    // continuation — but not the function: that one is private to `Thread.tsx`
    // and takes the full text, so reusing it would mean plumbing the whole
    // observation here for it to re-truncate. The excerpt is already bounded at
    // the mint.
    <Box flexDirection="column">
      <Text dimColor>↳ {obs.excerpt}</Text>
      <Text dimColor>
        {'  '}· {sizeNote(obs)}
        {obs.clipped ? `, showing first ${WAKE_EXCERPT_CHARS}` : ''}
      </Text>
    </Box>
  ) : null;

  return (
    <TranscriptPanel
      color={colors.accent}
      title="⏰ Woken"
      meta={` · ${data.source}`}
      body={collapsed ? collapsed.first : data.instruction}
      detail={detail}
      hintColor={colors.accent}
      footer="Bernard is acting on this now."
    />
  );
}

/**
 * The first line that says anything, and how many lines that leaves unseen.
 *
 * A wake instruction frequently opens with a blank or a heading rule, and a body
 * whose first row is empty reads as a panel that failed to render — so the body
 * is the first NON-EMPTY line rather than `lines[0]`.
 *
 * No clamp on the subtraction: `split('\n')` always yields at least one element
 * and the subtrahend is 0 or 1, so it cannot go negative. The `Math.max` this
 * replaces looked like a guard and could never fire.
 */
function collapseInstruction(instruction: string): { first: string; hidden: number } {
  const lines = instruction.split('\n');
  const i = lines.findIndex((l) => l.trim().length > 0);
  return { first: i === -1 ? '' : lines[i], hidden: lines.length - (i === -1 ? 0 : 1) };
}

function sizeNote(obs: ObservationSummary): string {
  return `${formatBytes(obs.bytes)} observed`;
}

function collapsedNote(hiddenLines: number, obs: ObservationSummary | undefined) {
  const parts: string[] = [];
  if (hiddenLines > 0) {
    parts.push(`… ${hiddenLines} more instruction ${plural(hiddenLines, 'line', 'lines')}`);
  }
  // `obs` itself rather than a pre-rendered string: an empty string as the
  // "there was no observation" sentinel meant this had to re-derive a fact the
  // caller already held.
  if (obs) parts.push(sizeNote(obs));
  if (parts.length === 0) return null;
  return <Text dimColor>{parts.join(' · ')}</Text>;
}
