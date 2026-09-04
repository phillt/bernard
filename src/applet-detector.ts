import { generateText } from 'ai';
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
  onUsage?: UsageRecorder,
): Promise<AppletDetectionResult | null> {
  if (serializedText.length < MIN_CONVERSATION_LENGTH) return null;

  try {
    const site = resolveSiteModel(config, 'applet-detector');
    const existing = existingAppIds.length ? existingAppIds.join(', ') : '(none)';
    const pending = pendingCandidates.length
      ? pendingCandidates.map((c) => c.draftId).join(', ')
      : '(none)';

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

    // `checkOverlaps` is reused verbatim: it is token overlap over name +
    // description + optional prompt/guidelines, which is exactly as meaningful
    // for an applet as for a specialist.
    const overlap = checkOverlaps(
      { name: draft.name, description: draft.description, systemPrompt: '', guidelines: [] },
      existingAppIds.map((id) => ({ id, name: id.replace(/-/g, ' '), description: '' })),
      pendingCandidates.map((c) => ({
        draftId: c.draftId,
        name: c.name,
        description: c.description,
        systemPrompt: '',
        guidelines: [],
      })),
    );
    if (overlap.maxScore > OVERLAP_THRESHOLD) {
      debugLog('applet-detector:overlap', { draftId: draft.draftId, score: overlap.maxScore });
      return null;
    }

    const confidence = appletConfidence(
      draft.confidence,
      overlap.maxScore,
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
        overlapScore: overlap.maxScore,
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
    // The one door that is not a hope: this is already an ordinary main-agent
    // turn, so it has `ask_user` and the full step budget. A suggestion is
    // inferred from a transcript, which is a guess about what someone wanted —
    // confirming it costs four questions and is what stops the applet being
    // built for the wrong problem.
    `Before building, call \`applet\` with \`{"action":"interview"}\` and follow it: ` +
    `the description above is inferred from a conversation, not something they said ` +
    `they wanted. Then write the page, consistent with the served token stylesheet.`
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
  return `## Applet Suggestions\n\nBernard noticed recurring, structured work that an applet could serve. Mention these when relevant; build one only with the \`applet\` tool and only when the user agrees.\n\n${lines.join('\n')}`;
}
