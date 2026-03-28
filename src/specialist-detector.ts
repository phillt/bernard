import { generateText } from 'ai';
import { getModel } from './providers/index.js';
import { debugLog } from './logger.js';
import type { BernardConfig } from './config.js';
import type { Specialist, SpecialistSummary } from './specialists.js';
import type { SpecialistCandidate } from './specialist-candidates.js';
import { checkOverlaps, computeConfidence, OVERLAP_THRESHOLD } from './overlap-checker.js';

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

If a candidate significantly overlaps with an existing specialist:
- Set shouldCreate to false and shouldEnhance to true
- In enhancementTarget, specify which specialist to enhance and what to add
- Include merged guidelines that combine the existing specialist's strengths with the new pattern

Respond with a JSON object (no markdown fences):
{
  "shouldCreate": boolean,
  "shouldEnhance": boolean,
  "candidate": {
    "draftId": "kebab-case-id",
    "name": "Display Name",
    "description": "One-line description",
    "systemPrompt": "The specialist's persona and behavioral instructions",
    "guidelines": ["Rule 1", "Rule 2"],
    "confidence": 0.0-1.0,
    "reasoning": "Why this specialist was proposed"
  } | null,
  "enhancementTarget": {
    "existingSpecialistId": "string",
    "mergedGuidelines": ["rule1", "rule2"],
    "mergedDescription": "enhanced description",
    "reasoning": "Why this should be merged"
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

interface EnhancementTarget {
  existingSpecialistId: string;
  mergedGuidelines: string[];
  mergedDescription?: string;
  reasoning: string;
}

/**
 * Result of specialist detection — either a new candidate, an enhancement suggestion,
 * or null if nothing was detected.
 */
export type DetectionResult =
  | {
      type: 'new-candidate';
      candidate: Omit<
        SpecialistCandidate,
        'id' | 'detectedAt' | 'acknowledged' | 'status' | 'source'
      >;
    }
  | {
      type: 'enhance-existing';
      enhancement: {
        existingSpecialistId: string;
        mergedGuidelines: string[];
        mergedDescription?: string;
        reasoning: string;
      };
    }
  | null;

/**
 * Analyze a serialized conversation for recurring delegation patterns
 * that would benefit from a saved specialist agent.
 *
 * Returns a discriminated union: a new candidate, an enhancement suggestion, or null.
 */
export async function detectSpecialistCandidate(
  serializedText: string,
  config: BernardConfig,
  existingSpecialists: (SpecialistSummary | Specialist)[],
  pendingCandidates: SpecialistCandidate[],
): Promise<DetectionResult> {
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
      shouldEnhance?: boolean;
      candidate: DetectedCandidate | null;
      enhancementTarget?: EnhancementTarget | null;
    };

    // Handle enhancement suggestion
    if (parsed.shouldEnhance && parsed.enhancementTarget) {
      const { existingSpecialistId, mergedGuidelines, mergedDescription, reasoning } =
        parsed.enhancementTarget;
      if (existingSpecialistId && Array.isArray(mergedGuidelines)) {
        return {
          type: 'enhance-existing',
          enhancement: {
            existingSpecialistId,
            mergedGuidelines,
            mergedDescription,
            reasoning: reasoning || '',
          },
        };
      }
    }

    if (!parsed.shouldCreate || !parsed.candidate) return null;
    if (parsed.candidate.confidence < MIN_CONFIDENCE) return null;

    const { draftId, name, description, systemPrompt, guidelines, confidence, reasoning } =
      parsed.candidate;

    // Validate required fields
    if (!draftId || !name || !systemPrompt) return null;

    // Run overlap check against existing specialists and pending candidates
    const overlapResult = checkOverlaps(
      {
        name,
        description: description || '',
        systemPrompt,
        guidelines: Array.isArray(guidelines) ? guidelines : [],
      },
      existingSpecialists.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        systemPrompt: 'systemPrompt' in s ? (s as Specialist).systemPrompt : undefined,
        guidelines: 'guidelines' in s ? (s as Specialist).guidelines : undefined,
      })),
      pendingCandidates.map((c) => ({
        draftId: c.draftId,
        name: c.name,
        description: c.description,
        systemPrompt: c.systemPrompt,
        guidelines: c.guidelines,
      })),
    );

    // If overlap exceeds threshold, reject the candidate
    if (overlapResult.maxScore > OVERLAP_THRESHOLD) {
      debugLog(
        'specialist-detector',
        `Overlap detected: "${draftId}" overlaps with ${overlapResult.details} (score: ${overlapResult.maxScore.toFixed(2)} > threshold ${OVERLAP_THRESHOLD})`,
      );
      return null;
    }

    // Duplicate check against existing specialists (strict ID/name match)
    const normalizedName = name.toLowerCase();
    const normalizedDraftId = draftId.toLowerCase();

    for (const s of existingSpecialists) {
      if (
        s.id === draftId ||
        s.name.toLowerCase() === normalizedName ||
        s.id.startsWith(normalizedDraftId) ||
        normalizedDraftId.startsWith(s.id)
      ) {
        debugLog(
          'specialist-detector',
          `Duplicate: "${draftId}" matches existing specialist "${s.id}"`,
        );
        return null;
      }
    }

    // Duplicate check against pending candidates
    for (const c of pendingCandidates) {
      const pendingDraftId = c.draftId.toLowerCase();
      if (
        c.draftId === draftId ||
        c.name.toLowerCase() === normalizedName ||
        pendingDraftId.startsWith(normalizedDraftId) ||
        normalizedDraftId.startsWith(pendingDraftId)
      ) {
        debugLog(
          'specialist-detector',
          `Duplicate: "${draftId}" matches pending candidate "${c.draftId}"`,
        );
        return null;
      }
    }

    // Compute composite confidence using overlap data
    const compositeConfidence = computeConfidence(
      confidence,
      overlapResult.maxScore,
      {
        systemPrompt,
        guidelines: Array.isArray(guidelines) ? guidelines : [],
        description: description || '',
        draftId,
      },
      serializedText.length,
    );

    return {
      type: 'new-candidate',
      candidate: {
        draftId,
        name,
        description: description || '',
        systemPrompt,
        guidelines: Array.isArray(guidelines) ? guidelines : [],
        confidence: compositeConfidence,
        reasoning: reasoning || '',
        overlapScore: overlapResult.maxScore,
        overlapsWithId: overlapResult.bestMatch?.id,
      },
    };
  } catch (err) {
    debugLog(
      'specialist-detector',
      `Detection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
