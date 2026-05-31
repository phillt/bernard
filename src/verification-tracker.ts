/**
 * Per-turn attestation tracker (issue #145).
 *
 * Records every tool call the agent makes during a turn so we can answer
 * "did the agent actually execute the verification it claimed?" After the
 * turn, `attest(verification)` tokenizes the plan step's verification text
 * and looks for ≥2 distinct tokens across the recorded tool calls
 * (name + args + first ~500 chars of result). Heuristic by design — meant
 * to surface "you said you'd check X but never touched anything related,"
 * not to be a proof.
 */

import type { Check } from './rubric.js';
import type { Step } from './plan-store.js';

interface RecordedCall {
  toolName: string;
  argsText: string;
  resultText: string;
}

const STOPWORDS = new Set<string>([
  'the',
  'and',
  'for',
  'that',
  'with',
  'this',
  'from',
  'into',
  'have',
  'has',
  'was',
  'were',
  'will',
  'are',
  'all',
  'any',
  'not',
  'but',
  'you',
  'your',
  'our',
  'its',
  "it's",
  'a',
  'an',
  'in',
  'on',
  'at',
  'of',
  'to',
  'is',
  'be',
  'by',
  'do',
  'or',
  'as',
  'so',
  'check',
  'verify',
  'check_',
  'should',
  'than',
  'then',
  'when',
  'must',
  'can',
  'see',
  'run',
]);

const MIN_TOKEN_LEN = 3;
const RESULT_PREVIEW_CHARS = 500;
const MIN_MATCHES_FOR_PASS = 2;

export class VerificationTracker {
  private calls: RecordedCall[] = [];

  recordCall(toolName: string, args: unknown, result: unknown): void {
    this.calls.push({
      toolName,
      argsText: safeStringify(args),
      resultText: safeStringify(result).slice(0, RESULT_PREVIEW_CHARS),
    });
  }

  clear(): void {
    this.calls = [];
  }

  callCount(): number {
    return this.calls.length;
  }

  /**
   * Attest one plan step's `verification` string against the recorded calls.
   * Returns a Check with `pass`/`warn`/`fail` based on how many distinct
   * verification-tokens were observed across the tool-call corpus.
   *
   * Only `done` steps are attested: `verification` describes the proof of
   * successful completion, so cancelled / errored / pending steps have no
   * verification to exercise. Plan-state checks (`steps_terminal`,
   * `no_error_steps`, `signoffs_present`) cover those cases independently.
   *
   * Matching uses tokenized set-membership on both the verification text and
   * the recorded tool-call corpus — substring matching would otherwise let
   * `cat` satisfy `certificate`, `file` satisfy `profile`, etc.
   */
  attest(step: Step): Check {
    const id = `attest_step_${step.id}`;
    const label = `step ${step.id} verification exercised`;
    if (step.status !== 'done') {
      return { id, label, status: 'skip', evidence: `step is ${step.status}, not done` };
    }
    const tokens = tokenize(step.verification);
    if (tokens.size === 0) {
      return { id, label, status: 'skip', evidence: 'no informative tokens' };
    }
    if (this.calls.length === 0) {
      return { id, label, status: 'fail', evidence: 'no tool calls this turn' };
    }
    const corpusTokens = new Set<string>();
    for (const c of this.calls) {
      for (const tok of tokenize(`${c.toolName} ${c.argsText} ${c.resultText}`)) {
        corpusTokens.add(tok);
      }
    }
    const matched = new Set<string>();
    for (const t of tokens) {
      if (corpusTokens.has(t)) matched.add(t);
    }
    if (matched.size >= MIN_MATCHES_FOR_PASS) {
      return {
        id,
        label,
        status: 'pass',
        evidence: `${matched.size}/${tokens.size} tokens matched`,
      };
    }
    if (matched.size === 1) {
      return { id, label, status: 'warn', evidence: `only 1/${tokens.size} tokens matched` };
    }
    return { id, label, status: 'fail', evidence: `0/${tokens.size} tokens matched` };
  }

  /**
   * Attest every step on a plan. Returns one Check per step. Non-`done` steps
   * yield a `skip` Check via {@link attest} so the consumer always gets a
   * 1:1 mapping but worst-of aggregation isn't dragged down by steps the
   * plan-state checks already classify.
   */
  attestAll(steps: readonly Step[]): Check[] {
    return steps.map((s) => this.attest(s));
  }
}

function safeStringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const lowered = text.toLowerCase();
  // Split on every non-alphanumeric character, INCLUDING underscore. Tool
  // names like `memory_write` / `file_read_lines` carry their semantics in the
  // sub-tokens, and the verification text rarely contains underscores — so
  // splitting on `_` lets corpus tokens align with plain-English verification
  // tokens (`memory`, `read`, `file`) without needing substring fallback.
  for (const raw of lowered.split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}
