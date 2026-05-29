/**
 * Feature extractors for the v1 Qualifier (#167). Each function is pure and
 * operates on the raw user message. Features are deliberately surface-level —
 * the LLM-routing literature (RouteLLM, FrugalGPT, Topaz, MoMA, RouterArena)
 * consistently uses these as a baseline before training a learned router.
 *
 * Reference signals:
 * - Topaz / MoMA: tool-invocation intent is the highest-signal gate
 * - RouterArena: Bloom's-Taxonomy levels partition difficulty tiers
 * - RouteLLM eval set: numbered lists and explicit step-by-step phrasing
 * - FrugalGPT: question count as a cheap cascade signal
 * - IBM RouterBench: query length correlates with task difficulty
 */

/** Length tier thresholds (whitespace-token counts) derived from RouterArena. */
export const TOKEN_LOW = 80;
export const TOKEN_HIGH = 200;

/**
 * Whitespace-tokenized length. Cheap proxy for "how complex is this ask"
 * that aligns with the IBM RouterBench tier distribution.
 */
export function tokenCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Verbs that signal the user wants Bernard to *do* something — invoke tools,
 * mutate state, run commands. Matches as whole words at the start of a clause
 * to keep noise low (e.g. "create a script" matches, "creative writing" does
 * not). Source: Topaz's "tool use" skill dimension + MoMA's tool-invocation
 * criterion.
 */
const TOOL_INVOCATION_VERBS = [
  'run',
  'execute',
  'search',
  'open',
  'read',
  'write',
  'edit',
  'send',
  'call',
  'create',
  'schedule',
  'delete',
  'remove',
  'build',
  'fix',
  'refactor',
  'implement',
  'deploy',
  'install',
  'analyze',
  'analyse',
  'fetch',
  'download',
  'upload',
  'commit',
  'push',
  'pull',
  'merge',
  'rebase',
  'generate',
  'compile',
  'test',
  'lint',
  'format',
] as const;

const TOOL_VERB_RE = new RegExp(
  `\\b(?:${TOOL_INVOCATION_VERBS.join('|')})\\b`,
  'i',
);

export function hasToolInvocationKeyword(text: string): boolean {
  return TOOL_VERB_RE.test(text);
}

/**
 * Multi-step / dependent-task phrasing. Matches numbered list markers
 * (`1.`, `2.`) at the start of a line, ordinal connectives (first/then/next),
 * conjunctive task chains (`and then`, `after that`), and explicit
 * step-by-step requests. Source: RouteLLM eval set + Hybrid-LLM baseline.
 */
const MULTI_STEP_PATTERNS: RegExp[] = [
  /^\s*\d+[.)]\s+/m, // numbered list ("1.", "2)")
  /^\s*[-*]\s+.+\n\s*[-*]\s+/m, // 2+ bullet list
  /\bstep[\s-]?by[\s-]?step\b/i,
  /\bfirst\b[^.]{0,80}\b(?:then|next|after that|finally)\b/i,
  /\bafter that\b/i,
  /\band then\b/i,
  /\band also\b/i,
];

export function hasMultiStepLanguage(text: string): boolean {
  return MULTI_STEP_PATTERNS.some((re) => re.test(text));
}

/**
 * Naive question-mark count. Treated as a cascade signal per FrugalGPT —
 * 2+ question marks usually indicates compound complexity (multiple
 * sub-questions in one message).
 */
export function subQuestionCount(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

/**
 * Explicit reasoning / analysis requests. Aligns with RouterArena's
 * Apply/Analyze/Evaluate tiers where the user is asking for derived
 * insight rather than recall.
 */
const REASONING_RE = /\b(?:explain why|analyze|analyse|compare|figure out|walk me through|reason through|why does|why is|how should)\b/i;

export function hasReasoningRequest(text: string): boolean {
  return REASONING_RE.test(text);
}

/**
 * Bloom's-Taxonomy level heuristic. v1 partitions verbs into two tiers
 * (the RouterArena partition Remember/Understand vs. Apply/Analyze/Evaluate).
 * Returns the highest tier hit, or `'remember'` when no match (the safe
 * "single-shot" default).
 */
export type BloomLevel = 'remember' | 'understand' | 'apply' | 'analyze' | 'evaluate';

const BLOOM_PATTERNS: { level: BloomLevel; re: RegExp }[] = [
  // Evaluate: compare-and-recommend, judge, decide between
  {
    level: 'evaluate',
    re: /\b(?:compare and recommend|recommend|decide|evaluate|judge|critique|best approach|trade-?offs?)\b/i,
  },
  // Analyze: dissect, design, refactor, plan
  {
    level: 'analyze',
    re: /\b(?:design|architect|refactor|plan|investigate|debug|root cause|why did)\b/i,
  },
  // Apply: do something concrete with rules already known
  {
    level: 'apply',
    re: /\b(?:apply|use|configure|set up|implement|integrate|migrate)\b/i,
  },
  // Understand: explain, summarize, paraphrase
  {
    level: 'understand',
    re: /\b(?:explain|summari[sz]e|describe|what does|how does)\b/i,
  },
  // Remember: recall facts
  { level: 'remember', re: /\b(?:what is|who is|when is|where is|define|list)\b/i },
];

const BLOOM_ORDER: BloomLevel[] = ['remember', 'understand', 'apply', 'analyze', 'evaluate'];

export function bloomLevel(text: string): BloomLevel {
  let highest: BloomLevel = 'remember';
  let highestIdx = -1;
  for (const { level, re } of BLOOM_PATTERNS) {
    if (re.test(text)) {
      const idx = BLOOM_ORDER.indexOf(level);
      if (idx > highestIdx) {
        highest = level;
        highestIdx = idx;
      }
    }
  }
  return highest;
}

/** True for Apply/Analyze/Evaluate. RouterArena's "needs coordinator" partition. */
export function bloomNeedsCoordinator(level: BloomLevel): boolean {
  return level === 'apply' || level === 'analyze' || level === 'evaluate';
}
