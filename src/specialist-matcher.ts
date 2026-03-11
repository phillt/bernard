import type { SpecialistSummary } from './specialists.js';

export interface SpecialistMatch {
  id: string;
  name: string;
  score: number;
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'for',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'with',
  'and',
  'or',
  'but',
  'not',
  'no',
  'nor',
  'so',
  'yet',
  'this',
  'that',
  'these',
  'those',
  'my',
  'me',
  'i',
  'you',
  'your',
  'he',
  'she',
  'it',
  'we',
  'they',
  'his',
  'her',
  'its',
  'our',
  'their',
  'them',
  'us',
  'do',
  'does',
  'did',
  'has',
  'have',
  'had',
  'will',
  'would',
  'could',
  'should',
  'can',
  'may',
  'might',
  'shall',
  'must',
  'if',
  'then',
  'else',
  'when',
  'where',
  'how',
  'what',
  'which',
  'who',
  'whom',
  'why',
  'all',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'some',
  'any',
  'about',
  'up',
  'out',
  'just',
  'also',
  'than',
  'very',
  'too',
  'from',
  'into',
  'over',
  'after',
  'before',
  'between',
  'under',
  'again',
  'there',
  'here',
  'once',
  'please',
  'help',
  'want',
  'need',
  'like',
  'get',
  'got',
  'make',
  'made',
]);

/**
 * Tokenizes text: lowercase, split on non-alphanumeric, remove stop words and short/numeric tokens.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * Stem-prefix match: two tokens match if one is a prefix of the other (min 3 chars) or exact match.
 */
function stemMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = 3;
  if (a.length < minLen || b.length < minLen) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Scores user input against specialist metadata and returns matches with score >= 0.4.
 * Results are sorted by score descending.
 */
export function matchSpecialists(
  input: string,
  specialists: SpecialistSummary[],
): SpecialistMatch[] {
  if (!input || specialists.length === 0) return [];

  const inputTokens = tokenize(input);
  if (inputTokens.length === 0) return [];

  const matches: SpecialistMatch[] = [];

  for (const spec of specialists) {
    // Build identity tokens from id segments + name
    const idSegments = spec.id.split('-').filter((s) => s.length >= 2 && !/^\d+$/.test(s));
    const nameTokens = tokenize(spec.name);
    const identityTokens = [...new Set([...idSegments, ...nameTokens])];

    if (identityTokens.length === 0) continue;

    // Build description tokens
    const descTokens = tokenize(spec.description);

    // Count identity hits
    let identityHits = 0;
    for (const idToken of identityTokens) {
      for (const inputToken of inputTokens) {
        if (stemMatch(idToken, inputToken)) {
          identityHits++;
          break;
        }
      }
    }

    // Primary score from identity match
    let score = identityHits / identityTokens.length;

    // Description boost: up to 0.15 bonus for description overlap
    if (descTokens.length > 0 && score > 0) {
      let descHits = 0;
      for (const descToken of descTokens) {
        for (const inputToken of inputTokens) {
          if (stemMatch(descToken, inputToken)) {
            descHits++;
            break;
          }
        }
      }
      const descRatio = descHits / descTokens.length;
      score = Math.min(1, score + descRatio * 0.15);
    }

    if (score >= 0.4) {
      matches.push({ id: spec.id, name: spec.name, score: Math.round(score * 100) / 100 });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}
