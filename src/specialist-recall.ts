import { z } from 'zod';
import { generateText } from 'ai';
import type { BernardConfig } from './config.js';
import { resolveSiteModel } from './model-policy.js';
import { parseStructuredOutput } from './structured-output.js';
import { debugLog, traceLlm } from './logger.js';
import { usageRecordFromSite, type UsageRecorder } from './framework/hooks/token-stats.js';

/**
 * What a specialist should remember from the work it just did (#501).
 *
 * The main agent gets this at session close: the exit worker extracts facts
 * from its transcript. A specialist got nothing — its dispatch transcript was
 * discarded, so the one agent that most needs to remember its own mistakes
 * could not. This is that pass, per specialist, over the reasoning-log entries
 * it produced.
 *
 * ## One call, not four
 *
 * `extractDomainFacts` fans out one model call per domain over the frozen
 * registry — four calls, each carrying the whole transcript. Telemetry shows
 * four distinct specialists in a single real session, so mirroring that shape
 * would be sixteen extra calls at exit, on a process whose entire job is to
 * finish. A specialist's memories are domain-scoped BY DEFINITION — a coder
 * agent produces coding notes — so the domain fan-out buys nothing here and the
 * pass is a single call.
 *
 * ## It writes rather than proposes, which inverts memory consolidation
 *
 * That pass proposes because its records are the user's own and shared: a wrong
 * retirement changes behaviour everywhere, silently. These records are private
 * to one specialist, so a bad one misleads exactly one agent and is deleted
 * with it. And the review cost is what would actually sink it — N specialists
 * each queuing proposals at every startup is a queue nobody drains.
 */

const MAX_NOTES_PER_SPECIALIST = 3;
const NOTE_MAX_CHARS = 500;
const RECALL_MAX_TOKENS = 1024;

/** Below this a dispatch has not done enough to be worth a model call. */
const MIN_TRANSCRIPT_CHARS = 400;

const ResponseSchema = z.object({
  notes: z
    .array(
      z.object({
        key: z.string(),
        content: z.string(),
      }),
    )
    .default([]),
});

export interface SpecialistNote {
  key: string;
  content: string;
}

const SYSTEM_PROMPT = `You are reviewing what one specialist agent did, so it can do better next time.

Return JSON: {"notes": [{"key": "...", "content": "..."}]}

Write a note ONLY for something that will still be true the next time this specialist runs:
- a mistake it made and what the correct approach turned out to be
- a durable fact about this environment it had to discover (a path, a command, a convention)
- a preference the user expressed about how this kind of work should be done

Do NOT write a note for:
- what happened this time (that is a log, not a memory)
- anything about the user personally — that is not this specialist's business
- restating its own instructions back to itself

Keys are short, lowercase and hyphenated, and name the SUBJECT — "build-uses-pnpm", not "note-1".
Return {"notes": []} when nothing durable came up. That is the common case and is a good answer.`;

/**
 * Extracts up to {@link MAX_NOTES_PER_SPECIALIST} durable notes from one
 * specialist's recent activity.
 *
 * Fails closed on a parse failure, following `claim-verifier` and
 * `memory-consolidation`: the neutral outcome here is "remember nothing", which
 * costs a specialist one session's learning, while a hallucinated note is a
 * standing instruction it will act on every run afterwards.
 */
/**
 * What one extraction produced, and whether it ran at all.
 *
 * `failed` is the half the CALLER needs and cannot infer: this function fails
 * closed, so a timed-out round trip and a session with nothing worth remembering
 * both return no notes. The caller advances a cursor past the entries it just
 * read — so without this, a cheap-tier call failing silently discards those
 * dispatches forever, which is the exact loss the cursor was introduced to stop.
 * "Nothing to learn" must advance the marker; "could not look" must not.
 */
export interface SpecialistNotesResult {
  notes: SpecialistNote[];
  failed: boolean;
}

export async function extractSpecialistNotes(
  specialistId: string,
  transcript: string,
  config: BernardConfig,
  opts: { abortSignal?: AbortSignal; onUsage?: UsageRecorder } = {},
): Promise<SpecialistNotesResult> {
  // Not a failure: there is genuinely nothing here to extract from, and the
  // caller should move past it.
  if (transcript.trim().length < MIN_TRANSCRIPT_CHARS) return { notes: [], failed: false };

  const site = resolveSiteModel(config, 'specialist-recall');
  try {
    const t0 = Date.now();
    const result = await traceLlm('specialist-recall', site.model.modelId, () =>
      generateText({
        model: site.model,
        providerOptions: site.providerOptions,
        // Before maxTokens so this site's cap stays authoritative (#286).
        ...site.params,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Specialist: ${specialistId}\n\nWhat it did:\n\n${transcript}`,
          },
        ],
        maxSteps: 1,
        maxTokens: RECALL_MAX_TOKENS,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      }),
    );
    opts.onUsage?.(
      usageRecordFromSite(site, 'specialist-recall', result.usage, result.providerMetadata, {
        latencyMs: Date.now() - t0,
      }),
    );

    const parsed = parseStructuredOutput(result.text, ResponseSchema);
    if (!parsed) {
      debugLog('specialist-recall:parse-failed', {
        specialistId,
        raw: result.text.slice(0, 200),
      });
      // A reply we could not read is a failed look, not an empty one.
      return { notes: [], failed: true };
    }
    // Bounded here rather than trusted from the model: `MAX_NOTES_PER_SPECIALIST`
    // is what stops one talkative session filling a specialist's whole context
    // budget, and the model is the last thing that should decide it.
    return {
      notes: parsed.notes
        .filter((n) => n.key.trim().length > 0 && n.content.trim().length > 0)
        .slice(0, MAX_NOTES_PER_SPECIALIST)
        .map((n) => ({ key: n.key.trim(), content: n.content.trim().slice(0, NOTE_MAX_CHARS) })),
      failed: false,
    };
  } catch (err) {
    debugLog('specialist-recall:error', {
      specialistId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { notes: [], failed: true };
  }
}
