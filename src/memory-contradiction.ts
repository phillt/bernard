import { z } from 'zod';
import { generateText } from 'ai';
import { resolveSiteModel } from './model-policy.js';
import { usageRecordFromSite, type UsageRecorder } from './framework/hooks/token-stats.js';
import { parseStructuredOutput } from './structured-output.js';
import { debugLog, traceLlm } from './logger.js';
import type { BernardConfig } from './config.js';
import type { ConsolidationInput } from './memory-consolidation.js';
import { MAX_PERSISTENT_MEMORY_CHARS } from './context-message.js';

/**
 * Noticing, at write time, that a new memory disagrees with one already saved
 * (#373).
 *
 * ## The case this exists for
 *
 * Same key is fine — a replacement is what the caller asked for, and
 * `writeMemory` already refuses a *different* raw key that sanitizes onto an
 * existing file. The bad case is a DIFFERENT key with contradicting content:
 * both stay, both are injected into `<persistent_memory>` on every dispatch,
 * both are the user's own words, and nothing separates them. It is also the
 * case a user is most likely to create, because a correction is naturally
 * written under a new descriptive name rather than the old one.
 *
 * Observed near-miss: a "no Time line in Daily Blaze" correction landed in
 * `daily-blaze-no-time`. Had a `daily-blaze-format` existed saying the template
 * *includes* a Time line, both would now be in every prompt.
 *
 * ## Three constraints, all from the code rather than from taste
 *
 * **1. It fails OPEN, which is the opposite of its two nearest neighbours.**
 * `claim-verifier` and `memory-consolidation` both fail closed, because their
 * neutral outcome is "assert nothing" and "propose nothing". Here the neutral
 * outcome is *losing a memory the user asked to keep*, so an error, a timeout,
 * an unparseable reply and a missing config all resolve to
 * {@link NO_CONTRADICTION} and the write proceeds exactly as it does today.
 * Keeping a duplicate is cheap; dropping a correction is not.
 *
 * **2. It never refuses a write.** `tools/memory.ts` already argues against a
 * refusing memory tool, and the argument holds: a false refusal silently loses
 * a standing fact at the moment the user asked to keep it. The verdicts here
 * are *supersede* and *ask*. There is no *no*.
 *
 * **3. It is reached by a dynamic import.** `tools/memory.ts` sits in
 * `createTools`' eager `audience:'any'` group, and #529 already paid for this
 * once: importing a `generateText`-owning module from there put `ai` and
 * `model-policy` on every tool-registry build, **+17 ms measured**, which is
 * why `memory-proposal.ts` exists as a pure leaf. Same trap, one file over.
 *
 * ## What is reused, and the one thing that is not
 *
 * `consolidationInputs` renders exactly the corpus this needs, and
 * `parseStructuredOutput`, the site/`traceLlm`/usage shape and
 * `MAX_PERSISTENT_MEMORY_CHARS` all transfer from #529.
 *
 * `ProposalSchema` deliberately does **not**. Encoding "this incoming write
 * supersedes `X`" as a `duplicate` proposal fails by construction:
 * `validProposals` gates every key on existing in the store, and the incoming
 * key does not exist yet — that is the whole premise. The question is also a
 * different shape: one candidate against N, yielding one verdict, not a list of
 * up to five.
 */

/** What the check decided about one incoming write. */
export type ContradictionVerdict =
  | { kind: 'none' }
  /** The incoming content replaces an existing entry outright. */
  | { kind: 'supersede'; key: string; reason: string }
  /** They disagree, but which one is right is the user's call. */
  | { kind: 'ask'; key: string; reason: string };

/** The fail-open answer, and the answer for every error path. */
export const NO_CONTRADICTION: ContradictionVerdict = Object.freeze({ kind: 'none' });

/** A verdict is one small object; a list would be a different question. */
const MAX_TOKENS = 400;

/**
 * Below this there is nothing to contradict, and the call is pure cost.
 * One existing entry is enough — the failure needs only two records.
 */
const MIN_ENTRIES = 1;

const ResponseSchema = z.object({
  verdict: z.enum(['none', 'supersede', 'ask']),
  key: z.string().optional(),
  reason: z.string().max(240).optional(),
});

const SYSTEM_PROMPT = `You are shown one note a user is about to save, and the notes they have already saved. Decide whether the new note CONTRADICTS an existing one.

Return JSON: {"verdict":"none"} — or {"verdict":"supersede","key":"<existing key>","reason":"..."} or {"verdict":"ask","key":"<existing key>","reason":"..."}.

"none" is the common and correct answer. Two notes on the same subject are usually COMPLEMENTARY: a list of two email accounts and a note adding a third are both needed, and a note about issues and a note about pull requests are about different things. Adding detail is not contradicting.

"supersede" — the new note states the OPPOSITE of an existing one about the same thing, and is plainly the newer, corrected version. The old note would be wrong to keep. Example: an existing note says a report includes a Time line; the new note says it must not.

"ask" — they disagree, but you cannot tell which the user means to keep, or the old note contains something the new one does not. When in doubt between "supersede" and "ask", choose "ask". When in doubt between "ask" and "none", choose "none".

NEVER report a contradiction between:
- a note and itself under a different name, where both say the same thing (that is duplication, not disagreement — return "none")
- notes about different subjects that merely share a word
- a general preference and a specific exception to it — both are true

The reason is one short sentence, addressed to the user, naming what disagrees.`;

/** Renders the incoming note plus the existing corpus, bounded. */
function buildUserContent(
  key: string,
  content: string,
  existing: ConsolidationInput[],
): { content: string; included: number } {
  const head = `## The note about to be saved\n\n### ${key}\n${content}\n\n## Already saved\n`;
  const parts: string[] = [head];
  let used = head.length;
  let included = 0;
  for (const e of existing) {
    // Whole records only, the rule `buildUserContent` follows in #529: a note
    // cut in half can read as saying the opposite of what it says.
    const block = `\n### ${e.key}\n${e.content}\n`;
    if (used + block.length > MAX_PERSISTENT_MEMORY_CHARS) break;
    parts.push(block);
    used += block.length;
    included++;
  }
  return { content: parts.join(''), included };
}

/**
 * Asks whether an incoming write contradicts something already saved.
 *
 * Never throws, and never returns a verdict naming a key that was not sent —
 * a model that invents a key would otherwise have the caller offer to retire a
 * memory that does not exist, or one the corpus cap cut.
 */
export async function checkContradiction(
  incoming: { key: string; content: string },
  existing: ConsolidationInput[],
  config: BernardConfig,
  opts: { abortSignal?: AbortSignal; onUsage?: UsageRecorder } = {},
): Promise<ContradictionVerdict> {
  const others = existing.filter((e) => e.key !== incoming.key);
  if (others.length < MIN_ENTRIES) return NO_CONTRADICTION;

  const { content: userContent, included } = buildUserContent(
    incoming.key,
    incoming.content,
    others,
  );

  try {
    const site = resolveSiteModel(config, 'memory-contradiction');
    const t0 = Date.now();
    const result = await traceLlm('memory-contradiction', site.model.modelId, () =>
      generateText({
        model: site.model,
        providerOptions: site.providerOptions,
        // Before maxTokens so this site's cap stays authoritative (#286).
        ...site.params,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
        maxSteps: 1,
        maxTokens: MAX_TOKENS,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      }),
    );
    opts.onUsage?.(
      usageRecordFromSite(site, 'memory-contradiction', result.usage, result.providerMetadata, {
        latencyMs: Date.now() - t0,
      }),
    );

    const parsed = parseStructuredOutput(result.text, ResponseSchema);
    if (!parsed || parsed.verdict === 'none') return NO_CONTRADICTION;

    // Only a key that was actually sent. A verdict naming one the cap cut is
    // one the model could not have read, so it is invented by definition.
    const sent = new Set(others.slice(0, included).map((e) => e.key));
    if (!parsed.key || !sent.has(parsed.key)) {
      debugLog('memory-contradiction:unknown-key', { key: parsed.key, verdict: parsed.verdict });
      return NO_CONTRADICTION;
    }

    const verdict: ContradictionVerdict = {
      kind: parsed.verdict === 'supersede' ? 'supersede' : 'ask',
      key: parsed.key,
      // `||`, not `??`: an empty-string reason is as useless as a missing one,
      // and the model returns one often enough to matter.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      reason: parsed.reason?.trim() || 'It disagrees with what is already saved.',
    };
    debugLog('memory-contradiction:verdict', {
      incoming: incoming.key,
      considered: included,
      kind: verdict.kind,
      key: parsed.key,
    });
    return verdict;
  } catch (err) {
    // Fail OPEN. See the module docstring: the neutral outcome here is losing a
    // memory, so every error path resolves to "no contradiction" and the write
    // proceeds exactly as it does today.
    debugLog('memory-contradiction:error', {
      message: err instanceof Error ? err.message : String(err),
    });
    return NO_CONTRADICTION;
  }
}
