import { z } from 'zod';
import { generateText } from 'ai';
import { resolveSiteModel } from './model-policy.js';
import { usageRecordFromSite, type UsageRecorder } from './framework/hooks/token-stats.js';
import { parseStructuredOutput } from './structured-output.js';
import { debugLog, traceLlm } from './logger.js';
import type { BernardConfig } from './config.js';
import type { MemoryRecord, MemoryStore } from './memory.js';
import { REWRITER_HINTS_KEY } from './memory.js';

/**
 * Noticing that persistent memory has accumulated things it no longer needs.
 *
 * Memory only ever grows: the `memory` tool is its single writer, it is
 * model-driven, and until #513 nothing could even express "this one is done".
 * Measured on a real install, 30 files / 6,177 chars over five months — roughly
 * 1,000 chars a month, which reaches `MAX_PERSISTENT_MEMORY_CHARS` in about
 * eighteen. At the cap, #528's silent filename-ordered drop begins.
 *
 * The cost is per DISPATCH, not per turn: `run.ts` injects the store into every
 * context message, so a turn with three sub-agents pays for all of memory four
 * times.
 *
 * ## What the measurement said, and what it changed
 *
 * Sizing every disposition against the real store before designing:
 *
 * | category | chars | share |
 * | --- | --- | --- |
 * | contained duplicates | 56 | 0.9% |
 * | one-off episodic records | 1,801 | 29.2% |
 * | standing rules, contacts, preferences | ~4,300 | 70% |
 *
 * So deduplication — the obvious framing, and the one #529 was filed with —
 * addresses under one percent. The category worth clearing is 32x larger and is
 * exactly the one that needs judgement: two logs of specific emails sent in
 * May, an "I gave you the link ...", a "that's an image I uploaded, that can be
 * ignored". That is why {@link StaleProposal} exists and why nothing here is
 * applied automatically.
 *
 * ## This pass PROPOSES. It never writes a memory.
 *
 * The exit worker's existing invariant, kept: both detectors there `create()` a
 * candidate and touch no user data. The deciding argument is not caution — the
 * worker is spawned `detached` with `stdio: 'ignore'` and so **cannot print**,
 * which means "announce what was retired" can only fire at the next startup
 * either way. At that point "we retired three" and "shall we retire these
 * three?" cost the user the same keystroke, and only one of them can be wrong.
 *
 * ## Why a model and not a similarity score
 *
 * Embedding similarity is deliberately not used. On the real store it scores
 * `email-accounts` and `email-accounts-professional` as near-duplicates — one
 * lists work and personal Gmail, the other adds a third professional account,
 * and neither contains the other. "These say the same thing" is a semantic
 * judgement; cosine distance answers a different question.
 */

/** One memory, as the model sees it. */
export interface ConsolidationInput {
  key: string;
  content: string;
  writtenAt?: string;
}

/** A group whose keeper already says everything the others do. */
export interface DuplicateProposal {
  kind: 'duplicate';
  /** Every key in the group, keeper included. */
  keys: string[];
  /** The one to keep, verbatim. Must be a member of {@link keys}. */
  keeper: string;
  reason: string;
}

/** A genuine merge: neither contains the other, but one record would serve better. */
export interface MergeProposal {
  kind: 'merge';
  keys: string[];
  proposedKey: string;
  proposedText: string;
  reason: string;
}

/** A one-off record that has served its purpose and is worth retiring outright. */
export interface StaleProposal {
  kind: 'stale';
  keys: string[];
  reason: string;
}

export type MemoryProposal = DuplicateProposal | MergeProposal | StaleProposal;

/**
 * Per run, across all kinds.
 *
 * A cap for the reason `correction.ts`'s `MAX_CANDIDATES_PER_RUN` is one: a
 * pass over a store this size can in principle propose retiring most of it, and
 * a startup notice offering twenty changes is one nobody reads. Five is enough
 * to make progress every session without ever presenting a wall.
 */
export const MAX_PROPOSALS_PER_RUN = 5;

/** Output cap. A handful of key lists and one drafted paragraph. */
const MEMORY_CONSOLIDATION_MAX_TOKENS = 1024;

/**
 * Skipped below this. Two memories cannot be redundant with each other in a way
 * worth a model call, and a store this small is nowhere near any budget.
 */
const MIN_MEMORIES_TO_CONSIDER = 3;

const ProposalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('duplicate'),
    keys: z.array(z.string()).min(2),
    keeper: z.string(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('merge'),
    keys: z.array(z.string()).min(2),
    proposedKey: z.string(),
    proposedText: z.string(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('stale'),
    keys: z.array(z.string()).min(1),
    reason: z.string(),
  }),
]);

const ResponseSchema = z.object({ proposals: z.array(ProposalSchema) });

const SYSTEM_PROMPT = `You review a user's saved notes and propose which ones are no longer earning their place. You do NOT edit anything — every proposal is shown to the user, who decides.

These notes are pasted into the model's context on every request, so each one costs something forever. But they are the USER'S OWN WORDS, and a wrong proposal wastes their attention. Propose nothing rather than something doubtful.

Return JSON: {"proposals": [...]}. Return {"proposals": []} when nothing qualifies — that is the common and correct answer for a well-kept store.

Three kinds:

1. {"kind":"duplicate","keys":["a","b"],"keeper":"a","reason":"..."}
   Use ONLY when the keeper already states everything the others state. Not "related", not "same topic" — CONTAINED. If one note mentions issues and another mentions pull requests, neither contains the other: they are about different things and both stay.

2. {"kind":"merge","keys":["a","b"],"proposedKey":"...","proposedText":"...","reason":"..."}
   Neither contains the other, but one note would serve better than two. Write the merged text preserving EVERY fact from every note — losing a clause here loses an instruction the user wrote. If you cannot merge without dropping something, do not propose it.

3. {"kind":"stale","keys":["a"],"reason":"..."}
   A record of one past event that has served its purpose: a log of a specific message already sent, a note about one link already followed, "that's an image I uploaded, it can be ignored". These describe something that happened once, not something that is true.

NEVER propose:
- a standing instruction or preference, however old ("always check unread only", "keep answers short")
- contact details, identifiers, account names, phone numbers, file numbers
- anything describing how the user wants work done
- a note you are unsure about

Two notes on the same subject are usually COMPLEMENTARY, not redundant. A list of two email accounts and a note adding a third are both needed.`;

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
 * Modelled on `appletSuggestionBlock`, including the half that one had to learn:
 * the decline instruction. Without it the block tells the agent what to do when
 * the user says yes and nothing at all when they say no, so the proposal stays
 * pending, the startup notice keeps counting it, and this very block re-injects
 * it next session.
 *
 * The proposal's own `reason` is model-written prose being used to argue for
 * retiring the user's notes, so it is presented as a suggestion to raise, never
 * as a finding to act on.
 */
export function memoryProposalBlock(
  pending: Array<{ id: string; proposal: MemoryProposal }>,
): string {
  const rows = pending.map((c) => `- (${c.id}) ${describeProposal(c.proposal)}`);
  return [
    '## Memory Housekeeping',
    '',
    "Bernard noticed saved notes that may have outlived their use. These are suggestions, not findings — the notes are the user's own words.",
    '',
    ...rows,
    '',
    'Raise these only when relevant, and never all at once. Apply one only with the `memory` tool and only when the user agrees: `supersede` for a duplicate, `retire` for one that is simply done, `write` then `retire` for a merge.',
    '',
    "If the user turns one down, record it with the `memory` tool's `proposals` action so it stops being raised. Do not argue with a no, and do not silently drop it — an unrecorded decline comes back next session.",
  ].join('\n');
}

/** Renders the corpus for the model. Keys are what a proposal refers to. */
function buildUserContent(entries: ConsolidationInput[]): string {
  const rows = entries.map((e) => {
    const when = e.writtenAt ? ` (written ${e.writtenAt.slice(0, 10)})` : '';
    return `### ${e.key}${when}\n${e.content.trim()}`;
  });
  return `Here are ${entries.length} saved notes.\n\n${rows.join('\n\n')}`;
}

/**
 * Drops proposals the store cannot honour.
 *
 * The `correction.ts` shape: the model is advisory, and this is the sole gate.
 * A key it invented, a keeper outside its own group, a group of one pretending
 * to be a duplicate — each would surface to the user as a change Bernard cannot
 * make, and the first one that fails teaches them to ignore the rest.
 *
 * Semantics are NOT verified here, because they cannot be. That is the whole
 * reason nothing is applied automatically.
 */
export function validProposals(
  proposals: MemoryProposal[],
  known: ReadonlySet<string>,
): MemoryProposal[] {
  const out: MemoryProposal[] = [];
  const claimed = new Set<string>();
  for (const p of proposals) {
    if (p.keys.length === 0 || p.keys.some((k) => !known.has(k))) continue;
    if (p.kind === 'duplicate' && (!p.keys.includes(p.keeper) || p.keys.length < 2)) continue;
    if (p.kind === 'merge' && p.keys.length < 2) continue;
    if (p.kind === 'merge' && !p.proposedText.trim()) continue;
    // One memory, one proposal. Two proposals touching the same key would have
    // the user accept both and find the second refers to a record the first
    // already retired.
    if (p.keys.some((k) => claimed.has(k))) continue;
    for (const k of p.keys) claimed.add(k);
    out.push(p);
    if (out.length >= MAX_PROPOSALS_PER_RUN) break;
  }
  return out;
}

/**
 * Reads the live store into the shape the pass takes.
 *
 * Skips `rewriter-hints`, which is machinery rather than a note — the same
 * exclusion `recall-filter` and `reference-resolver` both make — and anything
 * already retired or superseded, which is not shown to the model and so cannot
 * be proposed about twice.
 */
export function consolidationInputs(store: MemoryStore): ConsolidationInput[] {
  const out: ConsolidationInput[] = [];
  for (const key of store.listMemory()) {
    if (key === REWRITER_HINTS_KEY) continue;
    const record: MemoryRecord | null = store.readRecord(key);
    if (record?.content.trim()) {
      out.push({
        key,
        content: record.content,
        ...(record.writtenAt ? { writtenAt: record.writtenAt } : {}),
      });
    }
  }
  return out;
}

/**
 * Proposes what memory could shed. Never throws, never writes.
 *
 * **Fails closed**, the `claim-verifier` posture rather than
 * `speech-normalizer`'s: the neutral outcome here is a proposal to retire the
 * user's own notes, so unparseable output must propose nothing rather than
 * something approximate.
 *
 * **Not routed through the LLM sub-call cache**, and that is a decision.
 * `claim-verifier` records the reasoning for exactly this shape: the key embeds
 * `userContent` verbatim, so a corpus that changes between runs has a
 * structurally zero hit rate while each miss retains a multi-kilobyte key in an
 * uncapped Map for the session's life. The `writtenAt` gate at the call site is
 * the real "don't run again" mechanism.
 */
export async function proposeConsolidation(
  entries: ConsolidationInput[],
  config: BernardConfig,
  opts: { abortSignal?: AbortSignal; onUsage?: UsageRecorder } = {},
): Promise<MemoryProposal[]> {
  if (entries.length < MIN_MEMORIES_TO_CONSIDER) return [];

  const site = resolveSiteModel(config, 'memory-consolidator');
  const userContent = buildUserContent(entries);

  try {
    const t0 = Date.now();
    const result = await traceLlm('memory-consolidator', site.model.modelId, () =>
      generateText({
        model: site.model,
        providerOptions: site.providerOptions,
        // Before maxTokens so this site's cap stays authoritative (#286).
        ...site.params,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
        maxSteps: 1,
        maxTokens: MEMORY_CONSOLIDATION_MAX_TOKENS,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      }),
    );
    opts.onUsage?.(
      usageRecordFromSite(site, 'memory-consolidator', result.usage, result.providerMetadata, {
        latencyMs: Date.now() - t0,
      }),
    );

    const parsed = parseStructuredOutput(result.text, ResponseSchema);
    if (!parsed) {
      debugLog('memory-consolidation:parse-failed', { raw: result.text.slice(0, 200) });
      return [];
    }
    const known = new Set(entries.map((e) => e.key));
    const kept = validProposals(parsed.proposals as MemoryProposal[], known);
    debugLog('memory-consolidation:proposed', {
      considered: entries.length,
      returned: parsed.proposals.length,
      kept: kept.length,
    });
    return kept;
  } catch (err) {
    debugLog('memory-consolidation:error', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
