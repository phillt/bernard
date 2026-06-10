import { classifyError } from '../error-taxonomy.js';

/** Data backing the `<ErrorPanel>` transcript item. */
export interface ErrorPanelData {
  /** Friendly headline derived from the error category. */
  title: string;
  /** The taxonomy category (shown as a dim tag). */
  category: string;
  /** Human-readable primary message (provider JSON unwrapped when present). */
  message: string;
  /** One-line recovery hint from the failure taxonomy. */
  hint?: string;
  /** Stack + cause, rendered dim. Populated only when debug is on. */
  details?: string;
}

const TITLES: Record<string, string> = {
  rate_limit: 'Rate limit / quota',
  auth: 'Authentication failed',
  permission: 'Permission denied',
  timeout: 'Timed out',
  not_found: 'Not found',
  transient: 'Upstream error',
  invalid_args: 'Invalid request',
  exec_failed: 'Command failed',
  pool_exhausted: 'Pool saturated',
  parse_failed: 'Parse error',
  denied: 'Blocked',
  cancelled: 'Cancelled',
  unknown: 'Agent error',
};

/**
 * Turns a thrown agent error into the structured data the error panel renders.
 * Strips Bernard's `Agent error:` wrapper(s), unwraps a provider JSON envelope
 * to its human message, classifies via the failure taxonomy for a friendly
 * title + recovery hint, and (only when `includeDetails`) collects the stack
 * and cause for the dim detail block.
 */
export function formatAgentError(err: unknown, includeDetails: boolean): ErrorPanelData {
  const raw = err instanceof Error ? err.message : String(err);
  const message = cleanMessage(raw);
  const cls = classifyError({ message });
  return {
    title: TITLES[cls.category] ?? 'Agent error',
    category: cls.category,
    message,
    hint: cls.playbook.user,
    details: includeDetails ? collectDetails(err) : undefined,
  };
}

function cleanMessage(raw: string): string {
  let m = raw.trim();
  // Bernard wraps thrown errors as `Agent error: …`, sometimes twice.
  while (/^Agent error:\s*/i.test(m)) m = m.replace(/^Agent error:\s*/i, '').trim();
  return extractJsonMessage(m) ?? m;
}

/** Pull `.error.message` / `.message` out of a JSON envelope embedded in the string. */
function extractJsonMessage(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  const candidate = s.slice(start);
  const tryParse = (text: string): string | null => {
    try {
      return pickMessage(JSON.parse(text));
    } catch {
      return null;
    }
  };
  // First try the whole tail, then trim any prose after the final brace.
  const whole = tryParse(candidate);
  if (whole) return whole;
  const end = candidate.lastIndexOf('}');
  return end > 0 ? tryParse(candidate.slice(0, end + 1)) : null;
}

function pickMessage(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const inner = o.error;
  if (inner && typeof inner === 'object') {
    const im = (inner as Record<string, unknown>).message;
    if (typeof im === 'string') return im;
  }
  return typeof o.message === 'string' ? o.message : null;
}

function collectDetails(err: unknown): string | undefined {
  const parts: string[] = [];
  if (err instanceof Error && err.stack) parts.push(err.stack);
  if (err instanceof Error && err.cause instanceof Error && err.cause.stack) {
    parts.push('Caused by:\n' + err.cause.stack);
  }
  return parts.length ? parts.join('\n\n') : undefined;
}
