import { tokenize, stemMatch } from './specialist-matcher.js';

export interface OverlapResult {
  score: number;
  nameScore: number;
  descriptionScore: number;
  promptScore: number;
  guidelineScore: number;
}

export interface OverlapCheckResult {
  maxScore: number;
  bestMatch: { type: 'specialist' | 'candidate'; id: string; name: string } | null;
  details: string;
}

export const OVERLAP_THRESHOLD = 0.6;

/**
 * Computes token-based Jaccard-like similarity between a candidate and a specialist/candidate.
 */
export function computeOverlapScore(
  candidateTokens: {
    name: string[];
    description: string[];
    systemPrompt: string[];
    guidelines: string[];
  },
  targetTokens: {
    name: string[];
    description: string[];
    systemPrompt: string[];
    guidelines: string[];
  },
): OverlapResult {
  const nameScore = jaccardStemMatch(candidateTokens.name, targetTokens.name);
  const descriptionScore = jaccardStemMatch(candidateTokens.description, targetTokens.description);
  const promptScore = jaccardStemMatch(candidateTokens.systemPrompt, targetTokens.systemPrompt);
  const guidelineScore = jaccardStemMatch(candidateTokens.guidelines, targetTokens.guidelines);

  const score = nameScore * 0.3 + descriptionScore * 0.3 + promptScore * 0.2 + guidelineScore * 0.2;

  return { score, nameScore, descriptionScore, promptScore, guidelineScore };
}

function jaccardStemMatch(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 && tokensB.length === 0) return 0;
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  let intersectionCount = 0;
  const matched = new Set<number>();

  for (const a of tokensA) {
    for (let j = 0; j < tokensB.length; j++) {
      if (!matched.has(j) && stemMatch(a, tokensB[j])) {
        intersectionCount++;
        matched.add(j);
        break;
      }
    }
  }

  const unionCount = tokensA.length + tokensB.length - intersectionCount;
  return unionCount === 0 ? 0 : intersectionCount / unionCount;
}

/**
 * Checks a candidate against all existing specialists and pending candidates for overlap.
 */
export function checkOverlaps(
  candidate: {
    name: string;
    description: string;
    systemPrompt: string;
    guidelines: string[];
  },
  existingSpecialists: {
    id: string;
    name: string;
    description: string;
    systemPrompt?: string;
    guidelines?: string[];
  }[],
  pendingCandidates: {
    draftId: string;
    name: string;
    description: string;
    systemPrompt: string;
    guidelines: string[];
  }[],
): OverlapCheckResult {
  const candidateTokens = {
    name: tokenize(candidate.name),
    description: tokenize(candidate.description),
    systemPrompt: tokenize(candidate.systemPrompt),
    guidelines: candidate.guidelines.flatMap((g) => tokenize(g)),
  };

  let maxScore = 0;
  let bestMatch: OverlapCheckResult['bestMatch'] = null;

  for (const spec of existingSpecialists) {
    const targetTokens = {
      name: tokenize(spec.name),
      description: tokenize(spec.description),
      systemPrompt: tokenize(spec.systemPrompt ?? ''),
      guidelines: (spec.guidelines ?? []).flatMap((g) => tokenize(g)),
    };
    const result = computeOverlapScore(candidateTokens, targetTokens);
    if (result.score > maxScore) {
      maxScore = result.score;
      bestMatch = { type: 'specialist', id: spec.id, name: spec.name };
    }
  }

  for (const cand of pendingCandidates) {
    const targetTokens = {
      name: tokenize(cand.name),
      description: tokenize(cand.description),
      systemPrompt: tokenize(cand.systemPrompt),
      guidelines: cand.guidelines.flatMap((g) => tokenize(g)),
    };
    const result = computeOverlapScore(candidateTokens, targetTokens);
    if (result.score > maxScore) {
      maxScore = result.score;
      bestMatch = { type: 'candidate', id: cand.draftId, name: cand.name };
    }
  }

  const details = bestMatch
    ? `Best match: ${bestMatch.name} (${bestMatch.type}, score: ${maxScore.toFixed(2)})`
    : 'No significant overlap found';

  return { maxScore, bestMatch, details };
}

/**
 * Computes a composite confidence score for a candidate.
 */
export function computeConfidence(
  llmConfidence: number,
  overlapScore: number,
  candidate: {
    systemPrompt: string;
    guidelines: string[];
    description: string;
    draftId: string;
  },
  conversationLength: number,
): number {
  // LLM confidence (weight 0.4)
  const llmComponent = Math.max(0, Math.min(1, llmConfidence)) * 0.4;

  // Overlap inverse (weight 0.3) — high overlap reduces confidence for new candidates
  const overlapComponent = (1 - Math.max(0, Math.min(1, overlapScore))) * 0.3;

  // Prompt completeness (weight 0.2)
  let completeness = 0;
  if (candidate.systemPrompt.length > 0) completeness += 0.4;
  if (candidate.guidelines.length > 0) completeness += 0.3;
  if (candidate.description.length > 10) completeness += 0.2;
  if (/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(candidate.draftId)) completeness += 0.1;
  const completenessComponent = completeness * 0.2;

  // Conversation evidence strength (weight 0.1)
  const evidenceStrength = Math.min(1, conversationLength / 2000);
  const evidenceComponent = evidenceStrength * 0.1;

  return llmComponent + overlapComponent + completenessComponent + evidenceComponent;
}
