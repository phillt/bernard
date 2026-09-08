import { z } from 'zod';

/**
 * What a memory-consolidation pass can propose, and how it reads.
 *
 * A pure leaf — zod and nothing else — split out of `memory-consolidation.ts`
 * because `tools/memory.ts` needs `describeProposal`, a six-line string
 * formatter, and `tools/memory.ts` is in `tools/index.ts`'s **eager**
 * `audience: 'any'` group. Importing it from the module that owns the
 * `generateText` call dragged `ai`, `model-policy` (→ `lineups` → `providers` →
 * catalog) and `token-stats` onto the static graph of every process that builds
 * a tool registry — **+17 ms measured**, on the exact path #452 took from
 * 167 ms to 76 ms. This is the class `tool-bytes.ts`, `mcp-names.ts`,
 * `token-estimate.ts` and `headless-posture.ts` all exist to refuse.
 */

/**
 * One proposal.
 *
 * The schema is the single declaration and the type is inferred from it. An
 * earlier cut wrote both, which needed a cast at the parse site asserting an
 * equality nothing checked — so a field added to the interface and forgotten in
 * the schema would be stripped at parse while the cast said it survived.
 */
export const ProposalSchema = z.discriminatedUnion('kind', [
  z.object({
    /** The keeper already states everything the others state. */
    kind: z.literal('duplicate'),
    /** Every key in the group, keeper included. */
    keys: z.array(z.string()).min(2),
    /** The one to keep, verbatim. Must be a member of `keys`. */
    keeper: z.string(),
    reason: z.string().max(240),
  }),
  z.object({
    /** Neither contains the other, but one record would serve better. */
    kind: z.literal('merge'),
    keys: z.array(z.string()).min(2),
    proposedKey: z.string(),
    proposedText: z.string(),
    reason: z.string().max(240),
  }),
  z.object({
    /** A record of one past event that has served its purpose. */
    kind: z.literal('stale'),
    keys: z.array(z.string()).min(1),
    reason: z.string().max(240),
  }),
]);

/**
 * `reason` is capped because it is rendered into `alertContext`, which sits
 * AFTER the prompt-cache breakpoint and is re-billed on every step of every
 * turn for the session's life. Uncapped, one verbose model could make the
 * housekeeping block cost a meaningful slice of the budget the pass exists to
 * relieve. 240 chars is roughly two sentences.
 */
export type MemoryProposal = z.infer<typeof ProposalSchema>;

/** One proposal, as one line a user can read without opening anything. */
export function describeProposal(p: MemoryProposal): string {
  const keys = p.keys.map((k) => `\`${k}\``).join(', ');
  switch (p.kind) {
    case 'duplicate':
      return `${keys} — keep \`${p.keeper}\`, retire the rest: ${p.reason}`;
    case 'merge':
      return `${keys} — merge into \`${p.proposedKey}\`: ${p.reason}`;
    case 'stale':
      return `${keys} — no longer needed: ${p.reason}`;
  }
}

/**
 * The `<alert_context>` block the agent sees at startup.
 *
 * ## This block is not free, and the accounting belongs here
 *
 * It rides in `alertContext`, which `agent.ts` never clears, so it lands in
 * `<system_provided_context>` **after** the prompt-cache breakpoint and is
 * re-billed on every step of every turn for the life of the session — the cost
 * `applet-detector.ts` already records for its own block. Measured at the
 * 10-proposal cap an untrimmed version reached ~2,700 chars, 11% of
 * `MAX_PERSISTENT_MEMORY_CHARS` — a housekeeping notice costing a ninth of the
 * budget it exists to relieve. So the recipes live in the `memory` tool's own
 * description, which the agent already has, and this block carries the rows,
 * one line of framing, and the two instructions that are not inferable.
 *
 * ## Both halves of the decision, and the accept half is the one that was missing
 *
 * A first cut told the agent what to do on a decline and nothing about
 * recording an accept — so `decision: 'accepted'` existed, was classified by
 * `isWriteAction` and was unit-tested, with **no production path that reached
 * it**. An accepted proposal stayed `pending`, the startup notice kept counting
 * it, and this very block re-injected it next session: exactly the failure
 * `applet-detector.ts` records having fixed in the other direction, inherited
 * by copying its block. Both halves are stated now.
 *
 * The proposal's own `reason` is model-written prose arguing to retire the
 * user's notes, so the framing presents these as suggestions to raise, never as
 * findings to act on.
 */
export function memoryProposalBlock(
  pending: Array<{ id: string; proposal: MemoryProposal }>,
): string {
  return [
    '## Memory Housekeeping',
    '',
    "Saved notes that may have outlived their use. Suggestions, not findings — they are the user's own words. Raise one only when relevant, never all at once, and change nothing without agreement.",
    '',
    ...pending.map((c) => `- (${c.id}) ${describeProposal(c.proposal)}`),
    '',
    "Whatever the user decides, record it with the `memory` tool's `proposals` action — `accepted` once you have applied it, `declined` if they say no. An unrecorded decision comes back next session. Do not argue with a no.",
  ].join('\n');
}
