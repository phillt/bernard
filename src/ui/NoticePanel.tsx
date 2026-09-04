import { getThemeColors } from '../theme.js';
import { TranscriptPanel } from './TranscriptPanel.js';
import { formatFriendlyTimestamp } from '../output.js';
import type { NoticeData } from './notice.js';

/**
 * A message delivered from outside this session (#462).
 *
 * ## Why this is not `pushAssistantNotice`
 *
 * That path renders in Bernard's own voice, behind the assistant's `❮`
 * chevron. Anything that can write the inbox directory could then appear to be
 * Bernard speaking — which inverts the requirement rather than satisfying it.
 *
 * So the panel takes **neither** chevron. `❯` and `❮` are the transcript's
 * entire voice vocabulary, and a third participant takes neither of them. Four
 * independent signals say this is not user input, none of them colour alone:
 * it is boxed where user messages are unboxed; left-aligned and full width
 * where they are right-aligned at 85%; it names its source; and the footer
 * states the boundary in words.
 *
 * That footer is the load-bearing row. It is the only place a reader learns
 * that the message is **not in Bernard's context** — that acting on it means
 * saying so, and costs a turn they chose to spend.
 */
export function NoticePanel({ data }: { data: NoticeData }) {
  const colors = getThemeColors();
  return (
    <TranscriptPanel
      color={colors.warning}
      title={`✉ Message from ${data.sourceLabel}`}
      // Same dim weight as the timestamp, deliberately: the label is a claim
      // by whoever wrote the file, not something Bernard verified.
      meta={` · ${data.sourceKind} · ${formatFriendlyTimestamp(new Date(data.receivedAt))}`}
      body={data.text}
      hint={data.hint}
      hintColor={colors.accent}
      footer="Bernard has not seen this — type to act on it."
    />
  );
}
