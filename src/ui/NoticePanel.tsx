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
 * that the message is **not in Bernard's context**.
 *
 * It used to read *"type to act on it"*, which was false: the text never enters
 * `agent.history`, so a reader who typed got an agent hunting for something it
 * could not see. Observed costing eight dispatches across two mail accounts and
 * a chat bridge before the user interrupted.
 *
 * **It states a fact and names no key**, which is a correction to the first fix
 * for that. Naming one made the row a present-tense instruction on a panel that
 * cannot take it back: every earlier notice still said "press ↵ to act on it"
 * after it had been acted on, or superseded by a newer message. The defence
 * offered was that `<Static>` never repaints — true of the legacy surface and
 * false of the default one, since `TranscriptViewport` re-renders every item
 * every frame. `HintBar` owns the affordance, because it is the only surface
 * that can stop saying it.
 */
export function NoticePanel({ data }: { data: NoticeData }) {
  const colors = getThemeColors();
  return (
    <TranscriptPanel
      color={colors.warning}
      title={`» Message from ${data.sourceLabel}`}
      // Same dim weight as the timestamp, deliberately: the label is a claim
      // by whoever wrote the file, not something Bernard verified.
      meta={` · ${data.sourceKind} · ${formatFriendlyTimestamp(new Date(data.receivedAt))}`}
      body={data.text}
      hint={data.hint}
      hintColor={colors.accent}
      footer="Bernard has not seen this."
    />
  );
}
