import { readJsonlTail } from '../jsonl.js';
import { SCRIPT_LOG_FILE } from '../paths.js';
import { uncoveredTools, uncoveredToolsMessage } from './invocation.js';
import type { InvocationLogRow } from './invoke.js';

/**
 * Reading `script-invocations.jsonl` back (#461).
 *
 * The file has been written since #419 and **nothing has ever read it** — no
 * CLI command, no tool, no panel. That is half of why an applet failure had to
 * be diagnosed by a human copying the browser's error text into chat: the
 * other half was that the message was dropped, which `invoke.ts` now fixes.
 *
 * A reader rather than a store: the writer owns rotation
 * (`rotateJsonlByCount`), so this only ever selects and formats.
 */

/** How many rows to scan back through when filtering for one applet. */
const SCAN_LIMIT = 500;

/** The most recent rows for one applet, newest last. */
export function readAppletLog(appId: string, limit = 20): InvocationLogRow[] {
  const rows = readJsonlTail<InvocationLogRow>(SCRIPT_LOG_FILE, SCAN_LIMIT);
  return rows.filter((r) => r.appId === appId).slice(-limit);
}

/**
 * One row as a line a person or a model can act on.
 *
 * The grant gap is rendered HERE rather than stored, because it is derivable
 * from two fields the row already carries and a stored sentence would be a
 * third thing to keep true. It is also the single most common cause of the
 * failure this log exists to explain: an action declaring
 * `toolAllowlist: ['datetime']` whose backing specialist targets none of it
 * runs with an empty registry and answers that it cannot do the job — a bad
 * ANSWER rather than an error, which is what made it hard to see.
 */
export function formatLogRow(row: InvocationLogRow): string {
  const when = row.completedAt ?? row.startedAt;
  const head = `${when}  ${row.ok ? 'ok' : 'FAILED'}  ${row.action}  ${row.durationMs}ms`;
  // A DENIED run has to survive the `ok` early-out, because it is the one
  // diagnostic that appears on a SUCCESSFUL row: the action ran, answered, and
  // was refused the capability it existed for (#447) — the "ten clean
  // successes" shape this whole log was built to explain. Reporting it only on
  // the failure path would make the field write-only for exactly that case.
  //
  // It is a LINE rather than an early return, though, and the first cut got
  // that wrong: returning here pre-empted the failure detail, so a row that
  // both failed and was denied lost its `[step_limit]` and its message — the
  // worst case for this surface, not an edge of it, since a button that was
  // refused a capability AND failed is where a reader needs both facts. The
  // two are independently reachable: `denied` is populated from
  // `run.denied.length`, which says nothing about `ok`.
  //
  // The wording follows `row.ok` for the same reason. "The action ran without
  // it" is true of a success and false three words after `FAILED`.
  const denial =
    row.denied?.length !== undefined && row.denied.length > 0
      ? `    Denied: ${row.denied.join(', ')} — ` +
        (row.ok ? 'the action ran without it.' : 'and the action then failed.')
      : null;
  if (row.ok) return denial === null ? head : `${head}\n${denial}`;

  const lines = [`${head}  [${row.errorCode ?? 'unknown'}]`];
  // Ahead of the message: a refused capability is usually the CAUSE of the
  // failure below it, so it reads as the explanation rather than an aside.
  if (denial !== null) lines.push(denial);
  if (row.errorMessage) lines.push(`    ${row.errorMessage}`);

  const missing = uncoveredTools(row.toolAllowlist ?? [], row.toolsGranted ?? []);
  if (row.specialistId && missing.length > 0) {
    lines.push(`    ${uncoveredToolsMessage(row.specialistId, row.toolAllowlist ?? [], missing)}`);
  }
  return lines.join('\n');
}

/** The whole log for one applet, formatted, newest last. */
export function formatAppletLog(appId: string, limit = 20): string[] {
  return readAppletLog(appId, limit).map(formatLogRow);
}
