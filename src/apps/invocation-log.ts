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
  if (row.ok) return head;

  const lines = [`${head}  [${row.errorCode ?? 'unknown'}]`];
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
