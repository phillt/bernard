import { getThemeColors } from '../theme.js';
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
 * `text` is the instruction only. Whatever the watcher observed travels in the
 * turn's data channel and is deliberately not shown here — it can be megabytes
 * of somebody's inbox, and the panel's job is attribution, not disclosure.
 */
export function WakePanel({ data }: { data: WakeData }) {
  const colors = getThemeColors();
  return (
    <TranscriptPanel
      color={colors.accent}
      title="⏰ Woken"
      meta={` · ${data.source}`}
      body={data.text}
      hintColor={colors.accent}
      footer="Bernard is acting on this now."
    />
  );
}
