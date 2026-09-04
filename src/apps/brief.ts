/**
 * An applet's brief — what it is for, and what has happened to it (#463).
 *
 * A pure leaf: shapes, bounds and rendering, no filesystem. `brief-store.ts`
 * owns persistence.
 *
 * ## Why one record with two halves
 *
 * `intent` is what the applet is FOR — revised deliberately, and the thing the
 * research behind #473 calls the problem model: *"The app is one proposed
 * solution to the intent. The intent should remain editable."* `notes` is what
 * HAPPENED to it — appended, and the half that answers "we already tried that
 * and reverted it".
 *
 * They are the same question at two speeds, and splitting them into two files
 * would buy two sweeps on delete, two bounds to keep in step, and two reads on
 * every edit.
 *
 * ## The fields are the research's completeness check, not an invention
 *
 * `ASSUMPTIONS` is load-bearing rather than decoration: it is the only field
 * that lets a later reader tell what Bernard was told from what Bernard
 * guessed. `applet-reviewer` already carries a clause about not asserting what
 * it did not check; this is the authoring-side counterpart.
 */

import { plural } from '../text.js';

/** The twelve things worth knowing before building, from #473's research. */
export const INTENT_FIELDS = [
  'who',
  'goal',
  'trigger',
  'example',
  'current',
  'friction',
  'outcome',
  'input',
  'output',
  'context',
  'control',
  'assumptions',
] as const;

export type IntentField = (typeof INTENT_FIELDS)[number];

/** What each field means, shown wherever the brief is rendered or asked for. */
export const INTENT_FIELD_LABELS: Record<IntentField, string> = {
  who: 'Who is trying to accomplish this',
  goal: 'What they are actually trying to achieve',
  trigger: 'When the need arises',
  example: 'What happened the last time',
  current: 'How they solve it today',
  friction: 'Where the highest-value problem is',
  outcome: 'What success looks like',
  input: 'What information or action starts the applet',
  output: 'What useful result it must produce',
  context: 'Where, when and how often it is used',
  control: 'What requires human judgement or approval',
  assumptions: 'What Bernard is guessing rather than knowing',
};

export interface BriefNote {
  /** ISO 8601. */
  timestamp: string;
  text: string;
}

export interface AppletBrief {
  intent: Partial<Record<IntentField, string>>;
  notes: BriefNote[];
}

/**
 * Bounds.
 *
 * Read from `process.env` at module load rather than `BernardConfig`, matching
 * `MAX_PERSISTENT_MEMORY_CHARS` and `SUBAGENT_RESULT_MAX_CHARS`: this module is
 * a pure function of its inputs, and a config dependency is what would stop it
 * being one.
 *
 * The whole-brief budget is the one that matters — the brief is loaded into a
 * model's context on every edit, so an unbounded one is a growing per-edit tax.
 * The per-field and per-note caps exist so a single oversized write cannot
 * consume the whole budget on its own.
 */
export const MAX_INTENT_FIELD_CHARS = 1_000;
/**
 * Notes kept on disk.
 *
 * `MAX_BRIEF_CHARS` bounds only what is RENDERED — about fifty notes at the
 * default budget — so without this the file grows without limit while every
 * note past the fiftieth is read, re-serialised and then always dropped.
 * Generous relative to the render so the bound is invisible in practice.
 */
export const MAX_NOTES = 200;
export const MAX_NOTE_CHARS = 1_000;
export const MAX_BRIEF_CHARS = (() => {
  const raw = Number(process.env.BERNARD_MAX_BRIEF_CHARS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8_000;
})();

/** An empty brief, so a missing file and a blank one read identically. */
export function emptyBrief(): AppletBrief {
  return { intent: {}, notes: [] };
}

/** Drops unknown keys and caps each field. Intent comes from a model. */
export function normalizeIntent(
  raw: Partial<Record<string, string>> | undefined,
): Partial<Record<IntentField, string>> {
  const out: Partial<Record<IntentField, string>> = {};
  if (!raw) return out;
  for (const field of INTENT_FIELDS) {
    const value = raw[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    // An empty string is a deletion, not a value: it is how a caller clears a
    // field it previously filled.
    if (trimmed.length > 0) out[field] = trimmed.slice(0, MAX_INTENT_FIELD_CHARS);
  }
  return out;
}

/**
 * Renders a brief for a model, bounded, dropping WHOLE notes oldest-first.
 *
 * Whole notes, never a mid-note cut — the reason `renderPersistentMemory`
 * gives for its own rule: a note that stops mid-sentence still reads as
 * authoritative, so a truncated one is worse than an absent one. Deliberately
 * NOT `capSubagentResult`, which truncates mid-string; that is right for a page
 * preview and wrong for a record of decisions.
 *
 * The intent block is never dropped. It is the smaller half by construction
 * (twelve capped fields), and it is the half that says what the applet is for
 * — losing it to make room for note #40 inverts the priority.
 */
export function renderBrief(brief: AppletBrief, budget = MAX_BRIEF_CHARS): string {
  const lines: string[] = [];
  const intentEntries = INTENT_FIELDS.filter((f) => brief.intent[f]).map(
    (f) => `- **${INTENT_FIELD_LABELS[f]}:** ${brief.intent[f]}`,
  );
  if (intentEntries.length > 0) lines.push('## Intent', ...intentEntries);

  let used = lines.join('\n').length;
  const kept: string[] = [];
  let dropped = 0;
  // Walked newest-first, so what survives a tight budget is the most recent
  // thinking; `continue` rather than `break`, so a small old note can still
  // land after a large new one was dropped.
  for (let i = brief.notes.length - 1; i >= 0; i--) {
    const note = brief.notes[i];
    const block = `- ${note.timestamp}: ${note.text}`;
    if (used + block.length > budget) {
      dropped++;
      continue;
    }
    kept.push(block);
    used += block.length;
  }
  // Rendered oldest-first, so it reads as a history.
  if (kept.length > 0) lines.push('', '## Decisions and notes', ...kept.reverse());
  if (dropped > 0) {
    // Visible, so the gap is never silent — the model can ask for the rest.
    lines.push(
      '',
      '### (truncated)',
      `${dropped} older ${plural(dropped, 'note was', 'notes were')} omitted to stay ` +
        'within the brief budget.',
    );
  }
  return lines.join('\n');
}
