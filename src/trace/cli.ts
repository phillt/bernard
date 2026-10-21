import fs from 'node:fs';
import path from 'node:path';
import { SESSION_LOGS_DIR } from '../paths.js';
import { buildTraces, summarizeTurn, type LogRow, type Turn } from './build.js';
import { renderSummary, renderTurn } from './render.js';

export interface TraceOptions {
  /** Show only this turn: its id (`turn-3`) or its number (`3`). */
  turn?: string;
  /** Show only the last N turns. */
  last?: number;
  /** Hide leaf spans shorter than this many milliseconds. */
  minMs?: number;
  /** List the session's turns instead of drawing them. */
  list?: boolean;
  /** Print the tree as JSON. */
  json?: boolean;
}

/** The debug session logs, newest first, by file. */
export function listSessionLogs(dir = SESSION_LOGS_DIR): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}-[0-9a-f]+\.jsonl$/.test(n));
  } catch {
    return [];
  }
  return names
    .map((n) => path.join(dir, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

export function readLogRows(file: string): LogRow[] {
  return parseLogRows(fs.readFileSync(file, 'utf8'));
}

function parseLogRows(text: string): LogRow[] {
  const rows: LogRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as LogRow);
    } catch {
      // A torn last line from a session still writing is skipped, not fatal.
    }
  }
  return rows;
}

/**
 * Resolves `session` to a log file: a path, a session id, an id prefix, or —
 * when omitted — the newest session that has a traced turn in it.
 */
export function resolveSessionLog(session?: string): {
  file?: string;
  rows?: LogRow[];
  error?: string;
} {
  if (session && fs.existsSync(session)) return { file: session };
  const logs = listSessionLogs();
  if (logs.length === 0) {
    return { error: 'No debug session logs yet. Start Bernard with BERNARD_DEBUG=1 first.' };
  }
  if (session) {
    const hit = logs.find((f) => path.basename(f, '.jsonl').startsWith(session));
    return hit ? { file: hit } : { error: `No session log matches "${session}".` };
  }
  for (const f of logs.slice(0, 30)) {
    // A log written before turns were stamped has no `turnId` anywhere; skip it
    // on a substring test instead of parsing and building every line of it.
    const text = fs.readFileSync(f, 'utf8');
    if (!text.includes('"turnId"')) continue;
    const rows = parseLogRows(text);
    if (buildTraces(rows).length > 0) return { file: f, rows };
  }
  return {
    error:
      'No traced turns in the recent session logs. Turns are traced from this version on, with BERNARD_DEBUG=1.',
  };
}

function pickTurns(turns: Turn[], opts: TraceOptions): Turn[] {
  if (opts.turn) {
    const want = /^\d+$/.test(opts.turn) ? `turn-${opts.turn}` : opts.turn;
    return turns.filter((t) => t.id === want);
  }
  if (opts.last && opts.last > 0) return turns.slice(-opts.last);
  return turns;
}

/** The lines `bernard trace` prints. Returns an error string when there is nothing to show. */
export function traceLines(
  session: string | undefined,
  opts: TraceOptions,
): { lines: string[]; error?: string } {
  const { file, rows, error } = resolveSessionLog(session);
  if (!file) return { lines: [], error };
  const turns = buildTraces(rows ?? readLogRows(file));
  const picked = pickTurns(turns, opts);
  const lines = [`session ${path.basename(file, '.jsonl')}`];
  if (picked.length === 0) {
    return {
      lines,
      error: opts.turn ? `No turn "${opts.turn}" in this session.` : 'No traced turns.',
    };
  }
  if (opts.json) return { lines: [JSON.stringify(picked, null, 2)] };
  if (opts.list) {
    for (const t of picked) {
      const s = summarizeTurn(t);
      lines.push(
        `  ${t.id.padEnd(10)} ${String(Math.round(s.wallMs)).padStart(7)} ms  ${t.preview ?? ''}`,
      );
    }
    return { lines };
  }
  for (const t of picked) {
    lines.push('', ...renderTurn(t, { minMs: opts.minMs }), '', ...renderSummary(summarizeTurn(t)));
  }
  return { lines };
}
