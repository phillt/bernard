import { generateText } from 'ai';
import { interviewPlaybook } from './apps/interview.js';
import { debugLog } from './logger.js';
import type { BernardConfig } from './config.js';
import { resolveSiteModel } from './model-policy.js';
import { usageRecordFromSite, type UsageRecorder } from './framework/hooks/token-stats.js';
import { getModelForConfig, getProviderOptionsForConfig } from './providers/index.js';
import { checkOverlaps, OVERLAP_THRESHOLD } from './overlap-checker.js';
import { extractJsonBlock } from './structured-output.js';
import type { AppletCandidate } from './applet-candidates.js';

/**
 * Noticing that a task would be better served by an applet than another chat
 * turn (#430).
 *
 * Mirrors `specialist-detector.ts` deliberately rather than growing a parallel
 * pipeline — same cadence, same overlap check, same candidate-queue shape, same
 * cheap tier. Two things it does NOT copy, and both are on purpose.
 *
 * **The bar is higher.** An applet is a much larger artifact than a specialist:
 * a manifest, a page, a bound agent, an origin, a launcher. Auto-creating one
 * on the same composite that auto-creates a specialist is a bigger bet, so
 * `autoCreateApplets` defaults `false` and the queue carries suggestions until
 * the signal has been seen to be good.
 *
 * **The signal is recurrence with STRUCTURE.** A one-off request is a chat
 * turn; an applet earns its cost when the user comes back to it. The detector
 * runs where `specialist-detector` runs — at session exit and on
 * `/clear --save` — so it sees a whole transcript rather than one message, and
 * it is told to look for a shape the user returns to rather than to infer one
 * from a single ask.
 */

/** Below this a transcript is too short to show recurrence. */
const MIN_CONVERSATION_LENGTH = 500;

/** The model's own confidence floor, before the composite is computed. */
const MIN_CONFIDENCE = 0.7;

export const APPLET_DETECTION_PROMPT = `You detect when a user's work would be better served by an APPLET than by more chat turns.

An applet is a small local web page with buttons. Each button runs one named Bernard action with typed arguments. The user opens it directly and uses it without the chat interface.

An applet is worth suggesting when the work is RECURRING and STRUCTURED:
- the user does the same shaped thing repeatedly (logging something, tracking a list, checking a status, filling the same fields)
- the inputs are a small set of named values, not free-form prose each time
- the user would plausibly come back to it tomorrow

Do NOT suggest an applet for:
- one-off work, however elaborate
- open-ended research or conversation, which is what the chat is for
- anything whose value is the discussion rather than the result
- a task already served by an existing applet (they are listed below)

Be conservative. A wrong suggestion costs the user attention and a wrong auto-creation costs them an artifact they did not ask for. Only suggest when the transcript actually shows the pattern twice, or shows the user saying they do this regularly.

Output strict JSON and nothing else:
{"shouldCreate": boolean, "candidate": {"draftId": "kebab-case-id", "name": "Short Name", "description": "one line", "actions": ["action-name"], "confidence": 0.0-1.0, "reasoning": "what in the transcript showed recurrence"} | null}

`;

/**
 * The most `computeOverlapScore` can return for two applets.
 *
 * Its name and description terms weigh 0.3 each; the systemPrompt and
 * guidelines terms weigh 0.2 each and are structurally zero here, since an
 * applet has neither and both sides are passed empty. So 0.6 is a perfect
 * match, not a near one.
 */
const APPLET_OVERLAP_MAX = 0.6;

/**
 * Rescales a raw {@link checkOverlaps} score onto the 0-1 range it claims.
 *
 * Its own function so the arithmetic can be tested against real
 * `checkOverlaps` output — everything downstream of it sits behind a live model
 * call, which is how the gate went unexercised long enough to be dead.
 *
 * **The gate had never once fired.** `computeOverlapScore` weights name 0.3 +
 * description 0.3 + systemPrompt 0.2 + guidelines 0.2, and an applet has
 * neither of the last two: both sides are passed `''` and `[]`. So an applet's
 * score is capped at 0.6 against a `> 0.6` comparison. Measured — two
 * byte-identical drafts score exactly 0.6 and were NOT rejected, which is why a
 * suggestion the user had already seen could always come straight back.
 *
 * Normalising the SCORE rather than the comparison, because `maxScore` has
 * three readers and only one of them is the gate: it also feeds
 * {@link appletConfidence}'s `(1 - overlapScore) * 0.3` term and is persisted
 * on the record. Left raw, a byte-identical duplicate contributes 0.12 of
 * unearned confidence toward the 0.8 auto-create threshold — the scale error is
 * a property of the score, not of the gate.
 *
 * Deliberately not `>=` at the gate, which would catch the exact duplicate and
 * still miss everything near it, and would fix neither of the other two
 * readers. Deliberately not mapping `actions` onto `guidelines` to fill the
 * empty dimension, which changes WHAT is compared where this only fixes the
 * scale. Doing it inside `overlap-checker.ts` is the deeper fix and is a
 * separate change: it makes the SPECIALIST gate stricter, which is that
 * threshold finally meaning what it says but is behaviour outside this one.
 */
export function normaliseAppletOverlap(maxScore: number): number {
  return maxScore / APPLET_OVERLAP_MAX;
}

/**
 * Whether a draft names something Bernard already has or has already proposed.
 *
 * Strict id/name equality with the prefix rule from `specialist-detector.ts`,
 * which catches the near-misses a model produces when it re-derives an id it
 * has seen — `expense-log` against `expense-logger`.
 */
export function isExactDuplicate(
  draft: { draftId: string; name: string },
  existingAppIds: string[],
  seen: { draftId: string; name: string }[],
): boolean {
  const id = draft.draftId.toLowerCase();
  const name = draft.name.toLowerCase();
  const collides = (otherId: string, otherName: string) => {
    const oid = otherId.toLowerCase();
    return (
      oid === id || otherName.toLowerCase() === name || oid.startsWith(id) || id.startsWith(oid)
    );
  };
  return (
    existingAppIds.some((appId) => collides(appId, appId.replace(/-/g, ' '))) ||
    seen.some((c) => collides(c.draftId, c.name))
  );
}

/** The draft a detection produces; the store mints id/timestamp/status. */
export type AppletCandidateDraft = Omit<AppletCandidate, 'id' | 'detectedAt' | 'status' | 'source'>;

export interface AppletDetectionResult {
  candidate: AppletCandidateDraft;
}

/**
 * Analyses a transcript and returns a candidate, or `null`.
 *
 * Fails soft at every stage, like its sibling: a detector that throws would
 * take down session exit, and its whole output is a suggestion.
 */
export async function detectAppletCandidate(
  serializedText: string,
  config: BernardConfig,
  existingAppIds: string[],
  pendingCandidates: AppletCandidate[],
  /**
   * Declines still inside their cooldown (`AppletCandidateStore.listSuppressed`).
   *
   * Treated exactly like a pending candidate — same "do NOT repeat" line, same
   * overlap target — because for this decision they mean the same thing: an
   * idea Bernard has already put in front of the user and must not put there
   * again. Before this, a decline dropped out of `listPending()` immediately,
   * so the very next session could re-suggest the identical applet with a
   * fresh id and a fresh 30-day clock. Declining did nothing that lasted.
   */
  declinedCandidates: AppletCandidate[],
  onUsage?: UsageRecorder,
): Promise<AppletDetectionResult | null> {
  if (serializedText.length < MIN_CONVERSATION_LENGTH) return null;

  try {
    const site = resolveSiteModel(config, 'applet-detector');
    const existing = existingAppIds.length ? existingAppIds.join(', ') : '(none)';
    // One list, because the model is being told one thing: do not propose
    // these. Splitting them into "suggested" and "declined" would invite it to
    // treat a decline as weaker than silence, which is backwards.
    const seen = [...pendingCandidates, ...declinedCandidates];
    const pending = seen.length ? seen.map((c) => c.draftId).join(', ') : '(none)';

    const started = Date.now();
    const result = await generateText({
      model: getModelForConfig(config, site.provider, site.modelName),
      ...getProviderOptionsForConfig(config, site.provider),
      temperature: 0,
      maxTokens: 1024,
      system: APPLET_DETECTION_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            `Existing applets (do NOT duplicate these): ${existing}\n` +
            `Already suggested (do NOT repeat these): ${pending}\n\n` +
            `Transcript:\n${serializedText}`,
        },
      ],
    });
    if (onUsage) {
      onUsage(
        usageRecordFromSite(site, 'applet-detector', result.usage, result.providerMetadata, {
          latencyMs: Date.now() - started,
        }),
      );
    }

    const parsed = parseDetection(result.text);
    if (!parsed || !parsed.shouldCreate || !parsed.candidate) return null;
    const draft = parsed.candidate;
    if (draft.confidence < MIN_CONFIDENCE) return null;

    // Exact duplication is a string problem, and the fuzzy gate below cannot
    // solve it. Ported from `specialist-detector.ts`, which has run both
    // defences from the start; the applet detector copied only the fuzzy half.
    //
    // It is the only thing that catches a draft duplicating an ALREADY-BUILT
    // applet: that arm of `checkOverlaps` synthesises `description: ''`, so
    // that dimension scores 0 with its weight still counted and the arm's
    // ceiling is 0.5 — under the gate either way, normalised or not. It is
    // also what makes `existingAppIds` load-bearing for the first time.
    if (isExactDuplicate(draft, existingAppIds, seen)) {
      debugLog('applet-detector:duplicate', { draftId: draft.draftId });
      return null;
    }

    // `checkOverlaps` is reused verbatim: it is token overlap over name +
    // description + optional prompt/guidelines, which is exactly as meaningful
    // for an applet as for a specialist.
    const overlap = checkOverlaps(
      { name: draft.name, description: draft.description, systemPrompt: '', guidelines: [] },
      existingAppIds.map((id) => ({ id, name: id.replace(/-/g, ' '), description: '' })),
      seen.map((c) => ({
        draftId: c.draftId,
        name: c.name,
        description: c.description,
        systemPrompt: '',
        guidelines: [],
      })),
    );
    const overlapScore = normaliseAppletOverlap(overlap.maxScore);
    if (overlapScore > OVERLAP_THRESHOLD) {
      debugLog('applet-detector:overlap', { draftId: draft.draftId, score: overlapScore });
      return null;
    }

    const confidence = appletConfidence(
      draft.confidence,
      overlapScore,
      draft,
      serializedText.length,
    );

    return {
      candidate: {
        draftId: draft.draftId,
        name: draft.name,
        description: draft.description,
        actions: draft.actions ?? [],
        confidence,
        reasoning: draft.reasoning,
        overlapScore,
      },
    };
  } catch (err) {
    debugLog('applet-detector:error', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * The same four weights as `computeConfidence`, with an applet-shaped
 * completeness term.
 *
 * `computeConfidence` is deliberately NOT reused. Two of its four completeness
 * terms read `systemPrompt` and `guidelines` — fields an applet candidate does
 * not have and cannot be given without smuggling unrelated text into them. An
 * applet scored through it would be capped 0.14 below a specialist on a
 * component that says nothing about applets, and the shared 0.8 auto-create
 * threshold would be nearly unreachable for reasons unrelated to quality. The
 * WEIGHTS are the shared part and are kept identical, so the two pipelines
 * still mean the same thing by "0.8".
 */
export function appletConfidence(
  llmConfidence: number,
  overlapScore: number,
  draft: { draftId: string; description: string; actions?: string[] },
  conversationLength: number,
): number {
  const llmComponent = Math.max(0, Math.min(1, llmConfidence)) * 0.4;
  const overlapComponent = (1 - Math.max(0, Math.min(1, overlapScore))) * 0.3;

  let completeness = 0;
  if ((draft.actions?.length ?? 0) > 0) completeness += 0.5;
  if (draft.description.length > 10) completeness += 0.3;
  if (/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(draft.draftId)) completeness += 0.2;
  const completenessComponent = completeness * 0.2;

  const evidenceComponent = Math.min(1, conversationLength / 2000) * 0.1;

  return llmComponent + overlapComponent + completenessComponent + evidenceComponent;
}

interface RawDetection {
  shouldCreate?: boolean;
  candidate?: {
    draftId: string;
    name: string;
    description: string;
    actions?: string[];
    confidence: number;
    reasoning: string;
  } | null;
}

/**
 * Tolerates a fenced block, which small models emit despite the instruction.
 *
 * The fallback uses `extractJsonBlock` rather than `indexOf('{')` +
 * `lastIndexOf('}')`, because this payload carries a free-prose `reasoning`
 * field: a brace inside it truncates a naive span, and the naive span is
 * exactly what the first cut of this had.
 */
function parseDetection(text: string): RawDetection | null {
  const trimmed = text.trim();
  const body = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    : trimmed;
  try {
    return JSON.parse(body) as RawDetection;
  } catch {
    const start = body.indexOf('{');
    if (start === -1) return null;
    const block = extractJsonBlock(body, start);
    if (!block) return null;
    try {
      return JSON.parse(block) as RawDetection;
    } catch {
      return null;
    }
  }
}

/**
 * The turn a "Build it" click submits.
 *
 * Prose, because the destination is the main agent's `applet` tool and the
 * agent is what turns a suggestion into a manifest and a page. The candidate's
 * own fields are named explicitly so the agent is working from what was
 * detected rather than re-deriving it from the conversation.
 */
export function buildAppletRequest(c: {
  name: string;
  draftId: string;
  description: string;
  actions: string[];
}): string {
  const actions = c.actions.length ? c.actions.join(', ') : '(decide from the description)';
  return (
    `Build an applet using the \`applet\` tool.\n\n` +
    `- id: ${c.draftId}\n` +
    `- name: ${c.name}\n` +
    `- description: ${c.description}\n` +
    `- actions to cover: ${actions}\n\n` +
    // The playbook INLINE rather than a `{"action":"interview"}` instruction.
    // This string is already submitted as a user turn, so telling the model to
    // fetch it costs an extra round trip for the same tokens, and can be
    // ignored. The tool action stays for the free-form path, where there is no
    // seed to inline into.
    `The description above is inferred from a conversation, not something they ` +
    `said they wanted, so confirm it before building.\n\n${interviewPlaybook()}\n\n` +
    `Then write the page, consistent with the served token stylesheet.`
  );
}

/**
 * The system-prompt block naming pending applet suggestions.
 *
 * `eligible` is the subset that cleared the auto-create threshold with
 * `autoCreateApplets` on. The difference between the two lists is the whole
 * effect of that flag: an eligible suggestion is one the agent is told to
 * OFFER, unprompted, this session. It is still not told to build one silently
 * — see the call site in `src/index.ts` for why that asymmetry with
 * `autoCreateSpecialists` is deliberate.
 */
export function appletSuggestionBlock(
  pending: Pick<AppletCandidate, 'draftId' | 'name' | 'description'>[],
  eligible: Pick<AppletCandidate, 'draftId'>[],
): string {
  const eligibleIds = new Set(eligible.map((c) => c.draftId));
  const lines = pending.map(
    (c) =>
      `- "${c.name}" (${c.draftId}): ${c.description}${eligibleIds.has(c.draftId) ? ' — OFFER to build this one when it becomes relevant.' : ''}`,
  );
  // The decline half is load-bearing, not politeness. Without it the tool
  // action exists and is never called: the block told the agent what to do when
  // the user says yes and nothing at all when they say no, so the suggestion
  // stayed pending, the startup notice kept counting it, and this very block
  // re-injected it next session. That is what "there is no way to decline
  // them" meant.
  //
  // It names the action and not the call shape, because the call shape is
  // already in the tool's own `.describe()` — which sits in the tool block,
  // BEFORE the prompt-cache breakpoint, so it is paid once. This block is
  // folded into `alertContext`, which `agent.ts` never clears, so it lands in
  // `<system_provided_context>` after the breakpoint and is re-billed on every
  // step of every turn for the life of the session. Two copies of one sentence
  // is also two things to keep in step.
  return `## Applet Suggestions\n\nBernard noticed recurring, structured work that an applet could serve. Mention these when relevant; build one only with the \`applet\` tool and only when the user agrees.\n\nIf the user turns one down, record it with the \`applet\` tool's \`decline\` action so it stops being raised. Do not argue with a no, and do not silently drop it — an unrecorded decline comes back next session.\n\n${lines.join('\n')}`;
}
