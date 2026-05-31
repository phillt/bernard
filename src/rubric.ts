/**
 * Machine-checkable evaluation rubric (issue #145).
 *
 * Replaces narrative "looks good" self-evaluation with a small structured
 * judgment derived from observable signals: plan terminal state, post-write
 * tool checks, verification-attestation against the turn's tool-call log,
 * and the PAC critic verdict. Composed at end-of-turn (REPL) and end-of-run
 * (cron) and rendered as one line.
 */

export type Verdict = 'pass' | 'warn' | 'fail';

export type CheckStatus = Verdict | 'skip';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  evidence?: string;
}

export interface Rubric {
  verdict: Verdict;
  checks: Check[];
  reason?: string;
}

/**
 * Worst-of aggregation: any `fail` wins, else any `warn` wins, else `pass`.
 * `skip` counts as "not run, neither good nor bad."
 *
 * An empty (or skip-only) check list yields `pass` — there's no evidence of
 * trouble. Callers that need a "no checks ran" signal should inspect
 * `checks.every(c => c.status === 'skip')` separately.
 */
export function verdictOf(checks: readonly Check[]): Verdict {
  let warn = false;
  for (const c of checks) {
    if (c.status === 'fail') return 'fail';
    if (c.status === 'warn') warn = true;
  }
  return warn ? 'warn' : 'pass';
}

/** Count of checks at each status, used by `renderRubricLine`. */
export function countByStatus(checks: readonly Check[]): Record<CheckStatus, number> {
  const out: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) out[c.status]++;
  return out;
}

/**
 * One-line summary suitable for REPL footers and cron log alerts. Examples:
 *   `eval: PASS (4✓)`
 *   `eval: WARN (3✓ 1⚠) — post-write check failed for file_edit_lines`
 *   `eval: FAIL (2✓ 1✗) — 2 plan steps unresolved`
 */
export function renderRubricLine(r: Rubric): string {
  const counts = countByStatus(r.checks);
  const parts: string[] = [];
  if (counts.pass > 0) parts.push(`${counts.pass}✓`);
  if (counts.warn > 0) parts.push(`${counts.warn}⚠`);
  if (counts.fail > 0) parts.push(`${counts.fail}✗`);
  const tally = parts.length > 0 ? ` (${parts.join(' ')})` : '';
  const verdict = r.verdict.toUpperCase();
  const reason = r.reason ? ` — ${r.reason}` : firstNonPassReason(r);
  return `eval: ${verdict}${tally}${reason}`;
}

function firstNonPassReason(r: Rubric): string {
  if (r.verdict === 'pass') return '';
  const c = r.checks.find((x) => x.status === 'fail') ?? r.checks.find((x) => x.status === 'warn');
  if (!c) return '';
  const ev = c.evidence ? ` (${c.evidence})` : '';
  return ` — ${c.label}${ev}`;
}
