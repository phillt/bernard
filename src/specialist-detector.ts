import { generateText } from 'ai';
import { getModel } from './providers/index.js';
import { debugLog } from './logger.js';
import type { BernardConfig } from './config.js';
import type { SpecialistSummary } from './specialists.js';
import type { SpecialistCandidate } from './specialist-candidates.js';

/** Minimum conversation length (chars) to bother analyzing. */
const MIN_CONVERSATION_LENGTH = 500;

/** Minimum confidence threshold to accept a candidate. */
const MIN_CONFIDENCE = 0.7;

export const DETECTION_SYSTEM_PROMPT = `You are a pattern detector that analyzes conversation transcripts to identify recurring delegation patterns that would benefit from a saved specialist agent.

A specialist is a reusable expert persona with a system prompt and behavioral guidelines. They are useful when the user repeatedly delegates similar types of work with consistent behavioral instructions.

Analyze the conversation for:
1. **Repeated sub-agent delegations** with similar behavioral instructions or system prompts
2. **User corrections** that suggest a persistent persona would help (e.g., "no, always format it like X")
3. **Detailed behavioral rules** described by the user for a type of work (e.g., "when reviewing code, always check for X, Y, Z")
4. **Similar system prompt patterns** across delegations in the conversation

Do NOT suggest a specialist for:
- One-off tasks that are unlikely to recur
- Simple tool usage without behavioral customization
- Patterns already covered by an existing specialist

Respond with a JSON object (no markdown fences):
{
  "shouldCreate": boolean,
  "candidate": {
    "draftId": "kebab-case-id",
    "name": "Display Name",
    "description": "One-line description",
    "systemPrompt": "The specialist's persona and behavioral instructions",
    "guidelines": ["Rule 1", "Rule 2"],
    "confidence": 0.0-1.0,
    "reasoning": "Why this specialist was proposed"
  } | null
}

Set shouldCreate to false and candidate to null if no strong pattern is detected.
Be conservative — only suggest specialists for clear, recurring patterns with confidence >= 0.7.`;

/**
 * Draft candidate shape returned by the LLM (before we assign id/timestamps/status).
 */
interface DetectedCandidate {
  draftId: string;
  name: string;
  description: string;
  systemPrompt: string;
  guidelines: string[];
  confidence: number;
  reasoning: string;
}

/**
 * Analyze a serialized conversation for recurring delegation patterns
 * that would benefit from a saved specialist agent.
 *
 * Returns a candidate draft ready for `CandidateStore.create()`, or `null`
 * if no strong pattern was detected.
 */
export async function detectSpecialistCandidate(
  serializedText: string,
  config: BernardConfig,
  existingSpecialists: SpecialistSummary[],
  pendingCandidates: SpecialistCandidate[],
): Promise<Omit<
  SpecialistCandidate,
  'id' | 'detectedAt' | 'acknowledged' | 'status' | 'source'
> | null> {
  // Skip trivial conversations
  if (serializedText.length < MIN_CONVERSATION_LENGTH) return null;

  const existingList =
    existingSpecialists.length > 0
      ? `\n\nExisting specialists (do NOT duplicate these):\n${existingSpecialists.map((s) => `- ${s.id}: ${s.name} — ${s.description}`).join('\n')}`
      : '';

  const pendingList =
    pendingCandidates.length > 0
      ? `\n\nPending candidate suggestions (do NOT duplicate these):\n${pendingCandidates.map((c) => `- ${c.draftId}: ${c.name} — ${c.description}`).join('\n')}`
      : '';

  try {
    const result = await generateText({
      model: getModel(config.provider, config.model),
      maxTokens: 2048,
      system: DETECTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Analyze this conversation for recurring specialist patterns:${existingList}${pendingList}\n\n---\n\n${serializedText}`,
        },
      ],
    });

    const text = result.text?.trim();
    if (!text) return null;

    // Parse JSON — handle markdown code fences
    const jsonStr = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '');
    const parsed = JSON.parse(jsonStr) as {
      shouldCreate: boolean;
      candidate: DetectedCandidate | null;
    };

    if (!parsed.shouldCreate || !parsed.candidate) return null;
    if (parsed.candidate.confidence < MIN_CONFIDENCE) return null;

    const { draftId, name, description, systemPrompt, guidelines, confidence, reasoning } =
      parsed.candidate;

    // Validate required fields
    if (!draftId || !name || !systemPrompt) return null;

    // Duplicate check against existing specialists
    if (existingSpecialists.some((s) => s.id === draftId)) {
      debugLog('specialist-detector', `Duplicate draftId "${draftId}" matches existing specialist`);
      return null;
    }

    // Duplicate check against pending candidates
    if (pendingCandidates.some((c) => c.draftId === draftId)) {
      debugLog('specialist-detector', `Duplicate draftId "${draftId}" matches pending candidate`);
      return null;
    }

    return {
      draftId,
      name,
      description: description || '',
      systemPrompt,
      guidelines: Array.isArray(guidelines) ? guidelines : [],
      confidence,
      reasoning: reasoning || '',
    };
  } catch (err) {
    debugLog(
      'specialist-detector',
      `Detection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
