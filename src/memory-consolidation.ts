import { z } from 'zod';
import { generateText } from 'ai';
import { resolveSiteModel } from './model-policy.js';
import { usageRecordFromSite, type UsageRecorder } from './framework/hooks/token-stats.js';
import { parseStructuredOutput } from './structured-output.js';
import { ProposalSchema, type MemoryProposal } from './memory-proposal.js';
import { debugLog, traceLlm } from './logger.js';
import type { BernardConfig } from './config.js';
import type { MemoryRecord, MemoryStore } from './memory.js';
import { REWRITER_HINTS_KEY } from './memory.js';
import { MAX_PERSISTENT_MEMORY_CHARS } from './context-message.js';

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
 * candidate and touch no user data.
 *
 * **A wrongly-retired standing instruction fails silently**, and that is the
 * argument. Reversibility — "one front-matter line" — is worth nothing if
 * nobody notices: the model simply stops seeing *"always check unread only"*
 * and behaves differently, with no error and no signal. A wrong PROPOSAL costs
 * a glance.
 *
 * An earlier draft argued instead that the two cost "the same keystroke", since
 * the worker is `detached` with `stdio: 'ignore'` and so cannot print, leaving
 * the next startup as the only announcement point either way. The first half is
 * true and the second half is wrong in this design's own favour: "we retired
 * three" costs zero and is ignorable, while "shall we retire these three?"
 * costs a conversation AND a context block on every dispatch until it is
 * answered. On keystrokes alone, apply-and-announce wins. It is the asymmetry
 * of the failures, not the cost of the reply, that decides it.
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

/** Renders the corpus for the model. Keys are what a proposal refers to. */
export function renderMemoryCorpus(
  entries: ConsolidationInput[],
  opts: { head?: string } = {},
): { content: string; included: number } {
  const head = opts.head ?? '';
  const rows: string[] = [];
  let used = head.length;
  for (const e of entries) {
    const when = e.writtenAt ? ` (written ${e.writtenAt.slice(0, 10)})` : '';
    const row = `### ${e.key}${when}\n${e.content.trim()}`;
    // Whole records only, and oldest-first by construction: a note cut in half
    // cannot be judged, and judging half of one is how a standing instruction
    // gets proposed for retirement on the strength of its first sentence.
    if (used + row.length > MAX_PERSISTENT_MEMORY_CHARS) break;
    used += row.length;
    rows.push(row);
  }
  return { content: head + rows.join('\n\n'), included: rows.length };
}

/**
 * Drops proposals the store cannot honour.
 *
 * The `correction.ts` shape: the model is advisory, and this is the sole gate.
 * A key it invented, a keeper outside its own group, a group of one pretending
 * to be a duplicate — each would surface to the user as a change Bernard cannot
 * make, and the first one that fails teaches them to ignore the rest.
 *
 * Semantics are not verified here, and the reason is measured rather than
 * asserted — which matters, because the system prompt defines `duplicate`
 * operationally ("the keeper already states everything the others state"), so a
 * textual containment gate looks available and would move the
 * automatic/proposal boundary if it worked.
 *
 * It does not. Against the real store's one true duplicate — `3772` under
 * `issue-3538`, which IS the entire measured 0.9% — normalized substring says
 * no, token-subset containment says no (`any`, `like`, `that`, `be`,
 * `researched` are absent from the keeper), and Jaccard is 0.26. The two state
 * one rule in different words. So a deterministic gate scores that category at
 * **zero** on the store it exists for: it would reject the only real duplicate
 * while the harder cases still needed a model. Containment-as-meaning is not
 * containment-as-text.
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
 * The corpus is capped at `MAX_PERSISTENT_MEMORY_CHARS` — the repo's own answer
 * to "how much memory fits in one prompt", which `recall-filter` already
 * imports for the same purpose. Uncapped, the store this pass exists to serve
 * is by definition the one whose prompt overruns, so the cut would land
 * provider-side and `parseStructuredOutput` would fail closed: the largest
 * stores, silently proposing nothing.
 *
 * The corpus is capped at `MAX_PERSISTENT_MEMORY_CHARS` — the repo's own answer
 * to "how much memory fits in one prompt", which `recall-filter` already
 * imports for the same purpose. Uncapped, the store this pass exists to serve
 * is by definition the one whose prompt overruns, so the cut would land
 * provider-side and `parseStructuredOutput` would fail closed: the largest
 * stores, silently proposing nothing.
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
  const { content: corpus, included } = renderMemoryCorpus(entries);
  // The count names what was actually SENT, not what was on disk — and it is
  // composed here rather than passed as `head` for that reason: `head` is
  // charged against the budget, and this line cannot be written until the
  // budget has decided.
  const userContent = `Here are ${included} saved notes.\n\n${corpus}`;

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
    // Only what was actually sent — a proposal naming a record the cap cut is
    // one the model could not have seen, so it is invented by definition.
    const known = new Set(entries.slice(0, included).map((e) => e.key));
    const kept = validProposals(parsed.proposals, known);
    debugLog('memory-consolidation:proposed', {
      considered: included,
      offered: entries.length,
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
