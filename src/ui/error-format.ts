import { extractErrorFields } from '../error-fields.js';
import { extractJsonBlock } from '../structured-output.js';
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
  const fields = extractErrorFields(err);
  const message = cleanMessage(fields.message);
  // The status and errno the error already carries, not just its prose. Passing
  // only the message left three ordinary provider failures — a terse 429, a 503
  // "Internal error", a 401 "invalid x-api-key" — all reading `unknown` with
  // the unrecognised-error hint, which is the defect this whole change set is
  // about, on the paths where the answer was sitting on the object.
  //
  // This does not replace the capacity regex: the motivating case is HTTP 200
  // with the refusal in the BODY, so it arrives with no status at all and the
  // message is the only signal. Both are needed.
  const cls = classifyError({
    message,
    ...(fields.httpStatus !== undefined ? { httpStatus: fields.httpStatus } : {}),
    ...(fields.errno !== undefined ? { errno: fields.errno } : {}),
  });
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

/**
 * Pull `.error.message` / `.message` out of a JSON envelope embedded in the string.
 *
 * The envelope is located by BRACE MATCHING from the first `{`, not by scanning
 * back from the last `}`. That distinction is the whole bug: the AI SDK builds
 * a `TypeValidationError` as
 *
 *     Type validation failed: Value: ${JSON.stringify(value)}.
 *     Error message: ${zod issues}
 *
 * and the trailing zod issues carry their own braces. `lastIndexOf('}')` landed
 * inside that array, the parse failed, and the raw string went to the panel
 * untouched — which is how a user saw "Type validation failed: Value: {…}"
 * when the envelope inside it said, in plain English, that the model was at
 * capacity. The old fixture had nothing after the closing brace, so the path
 * that actually runs in production was never exercised.
 */
function extractJsonMessage(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  // `extractJsonBlock` is the repo's balanced-JSON scanner and does exactly
  // this — depth counting that respects string literals and escapes. An earlier
  // cut wrote a second copy here; `structured-output.ts` is a zod-only leaf, so
  // there is no import cost worth a duplicate, and its escape handling is the
  // stricter of the two.
  const block = extractJsonBlock(s, start);
  if (!block) return null;
  try {
    return pickMessage(JSON.parse(block));
  } catch {
    return null;
  }
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
