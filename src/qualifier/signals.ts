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
  'update',
  'modify',
  'replace',
  'sync',
] as const;

const TOOL_VERB_RE = new RegExp(`\\b(?:${TOOL_INVOCATION_VERBS.join('|')})\\b`, 'i');

export function hasToolInvocationKeyword(text: string): boolean {
  return TOOL_VERB_RE.test(text);
}

/**
 * Multi-step / dependent-task phrasing. Matches numbered list markers
 * (`1.`, `2.`) at the start of a line, ordinal connectives (first/then/next),
 * conjunctive task chains (`and then`, `after that`), and explicit
 * step-by-step requests. Source: RouteLLM eval set + Hybrid-LLM baseline.
 *
 * The connective patterns (`and then`, `after that`) are deliberately paired
 * with a following tool-invocation verb so plain conversational English
 * ("Python is fast and then dynamic", "what happened after that?") doesn't
 * escalate — only task chains like "build it and then deploy it" do.
 */
const MULTI_STEP_PATTERNS: RegExp[] = [
  /^\s*\d+[.)]\s+/m, // numbered list ("1.", "2)")
  /^\s*[-*]\s+.+\n\s*[-*]\s+/m, // 2+ bullet list
  /\bstep[\s-]?by[\s-]?step\b/i,
  /\bfirst\b[^.]{0,80}\b(?:then|next|after that|finally)\b/i,
];

// Sequencer + a following tool-invocation verb within ~3 words: "and then
// please run", "after that, go fix", "X, then create Y". A bare `then`/`next`
// covers the `and then` case too (the word boundary sits inside it), so one
// alternation serves both — only `after that` / `and also` need their own.
//
// The following-verb requirement is the whole guard: it is what keeps
// conversational uses out, since "I tried X and then Y happened" has no task
// verb after the connective.
const SEQUENCER_WITH_VERB_RE = new RegExp(
  `\\b(?:then|next|after that|and also)\\b[\\s,]*(?:\\w+\\s+){0,3}(?:${TOOL_INVOCATION_VERBS.join('|')})\\b`,
  'i',
);

/**
 * Conditional clauses, which are not sequences: "if the build fails then run
 * the linter" describes one branch, not two steps — and it carries a tool verb,
 * so the following-verb guard cannot reject it.
 *
 * Stripped once for the whole detector rather than for the newest pattern
 * alone: "a conditional is not a sequence" is a property of multi-step
 * detection, so `first check X, and if it fails then run Y` should not escalate
 * either. Bounded to a single sentence so an `if` early in a paragraph cannot
 * swallow a genuine sequencer later in it.
 *
 * Deliberately narrow — `when`/`unless` are unhandled. Covering them properly
 * wants clause segmentation rather than another regex (#385 follow-up).
 */
const CONDITIONAL_CLAUSE_RE = /\bif\b[^.?!]*?\bthen\b/gi;

export function hasMultiStepLanguage(text: string): boolean {
  const sequential = text.replace(CONDITIONAL_CLAUSE_RE, ' ');
  if (MULTI_STEP_PATTERNS.some((re) => re.test(sequential))) return true;
  return SEQUENCER_WITH_VERB_RE.test(sequential);
}

/**
 * Conversational "real-world action" requests — asking Bernard to interact with
 * an external party or service on the user's behalf: message a person or their
 * staff, book/cancel an appointment, place/refill an order, fill out or submit a
 * form, log into a portal. These are inherently *sustained* tool workflows
 * (usually multi-page browser or MCP interactions) even when phrased briefly
 * and conversationally ("reach out to my doctor about a refill"), so they slip
 * past the tool-keyword gate — which only fires on Apply/Analyze/Evaluate
 * framing or non-trivial length. Detecting them directly lets the qualifier
 * route them to ReAct, which grants a larger step budget and plan enforcement
 * instead of single-shot Normal's tight 25-step ceiling.
 *
 * Patterns are kept deliberately object-anchored (e.g. "message" must be
 * followed by a person-ish object) so common non-action phrasings — "what's
 * the error message", "cancel culture" — don't escalate. `call` collides
 * heavily with developer usage ("call the API/function/endpoint"), so unlike
 * the other communication verbs it only matches a *personal* object, never the
 * generic "the".
 */
const AGENTIC_ACTION_PATTERNS: RegExp[] = [
  // Outreach / communication to a person or their staff.
  /\b(?:reach out|get in touch|follow up|check in)\b/i,
  /\b(?:message|e-?mail|contact|text|notify|remind|write to)\s+(?:my|the|her|his|their|our|dr\.?|doctor|him|them|us)\b/i,
  // `call` excludes the generic "the" — "call the function/API/endpoint" is a
  // dev phrasing, not a real-world outreach action.
  /\bcall\s+(?:my|her|his|their|our|dr\.?|doctor|him|them|us)\b/i,
  /\blet\s+(?:him|her|them|my|the)\b[^.?!]{0,30}\bknow\b/i,
  // Scheduling / appointments / reservations (verb + object).
  /\b(?:book|schedule|reschedule|cancel|set up|arrange)\b[^.?!]{0,40}\b(?:appointment|meeting|reservation|visit|booking|table|call)\b/i,
  // Transactions / orders / prescriptions. Bare refill/reorder are strong
  // enough on their own; "renew" is broader (renew a cert/token in code), so it
  // requires a personal object ("renew my subscription", not "renew the token").
  /\b(?:refill|reorder|re-?order)\b/i,
  /\brenew\s+(?:my|her|his|our|their)\b/i,
  /\b(?:place|submit|fill (?:out|in)|complete)\b[^.?!]{0,30}\b(?:order|form|request|application|prescription|claim)\b/i,
  // Portals.
  /\b(?:log ?in(?:to)?|sign in|sign up)\b/i,
];

/**
 * True when the message reads as a real-world action to carry out on the user's
 * behalf (see {@link AGENTIC_ACTION_PATTERNS}). Escalates to ReAct regardless of
 * length because these tasks reliably outrun the Normal step budget.
 */
export function hasAgenticActionRequest(text: string): boolean {
  return AGENTIC_ACTION_PATTERNS.some((re) => re.test(text));
}

/**
 * Question-mark count, excluding URL query-string `?`s. Treated as a cascade
 * signal per FrugalGPT — 2+ trailing-context question marks usually indicate
 * compound complexity (multiple sub-questions in one message). A `?` that is
 * immediately followed by a non-whitespace, non-punctuation character (e.g.
 * `https://x.com?a=1`) is a URL query separator, not a sentence terminator.
 */
export function subQuestionCount(text: string): number {
  return (text.match(/\?(?=$|\s|["'\])}])/g) ?? []).length;
}

/**
 * Explicit reasoning / analysis requests. Aligns with RouterArena's
 * Apply/Analyze/Evaluate tiers where the user is asking for derived
 * insight rather than recall.
 */
const REASONING_RE =
  /\b(?:explain why|analyze|analyse|compare|figure out|walk me through|reason through|why does|why is|how should)\b/i;

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
