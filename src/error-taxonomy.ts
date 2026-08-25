import type { ToolErrorType } from './framework/tools/types.js';

/**
 * Result of classifying a tool error. `correctable` gates the existing
 * learning loops (correction-candidate enqueue, tool-profile bad-example
 * recording) so that irreducible environmental failures (HTTP 404,
 * rate limits, pool exhaustion, parse failures) no longer drown the
 * call-shape mistakes the model can actually learn from.
 */
export interface Classification {
  category: ToolErrorType;
  /** Worth feeding to the correction agent / recording as a bad example. */
  correctable: boolean;
  /** Hint for `ToolError.retryable`. */
  retryable: boolean;
  /** Drives cron alert severity. */
  severity: 'low' | 'normal' | 'critical';
  playbook: { user: string; model: string };
}

export interface ClassifyInput {
  message: string;
  toolName?: string;
  errno?: string;
  httpStatus?: number;
}

const PLAYBOOKS: Record<ToolErrorType, { user: string; model: string }> = {
  invalid_args: {
    user: 'Tool was called with invalid arguments — model may retry with corrected shape.',
    model: 'Re-issue the call with corrected arguments. Re-read the tool schema if unsure.',
  },
  exec_failed: {
    user: 'Command failed — model may retry with a corrected form.',
    model:
      'Re-examine the command; a quoting, path, or flag issue is likely. Retry with a corrected form.',
  },
  not_found: {
    user: 'Target was not found.',
    model:
      'The target (URL, file, command, or resource) was not found. Do not retry the same call — try a different target or report the miss.',
  },
  auth: {
    user: 'Authentication failed — re-authenticate or check your API key.',
    model:
      'Authentication failed. Do not retry. Ask the user to re-authenticate (e.g. /models for API keys) or surface the issue.',
  },
  rate_limit: {
    user: 'Rate-limited — wait or switch lineup with /lineups.',
    model:
      'You are rate-limited. Do not retry immediately. Suggest waiting or switching to a different tier lineup via /lineups.',
  },
  permission: {
    user: 'Permission denied — check filesystem or service ACLs.',
    model: 'Permission denied. Do not retry the same call. Surface the access issue to the user.',
  },
  timeout: {
    user: 'Timed out — operation took too long.',
    model:
      'Operation timed out. Consider a narrower query or splitting the work. Do not blindly retry.',
  },
  transient: {
    user: 'Transient upstream error — try again in a moment.',
    model:
      'Transient upstream failure (network or 5xx). One retry is acceptable; if it persists, surface the issue.',
  },
  parse_failed: {
    user: 'Tool output failed to parse — internal model variance.',
    model:
      'The wrapper did not return parseable structured output. Treat as transient and retry once with simpler input.',
  },
  pool_exhausted: {
    user: 'Bernard tool-wrapper pool is saturated — wait for in-flight calls to finish.',
    model:
      'Tool-wrapper pool is at capacity. Wait or sequence the call after current work completes. Do not retry immediately.',
  },
  cancelled: {
    user: 'Cancelled.',
    model: 'The previous call was cancelled by the user. Do not retry without instruction.',
  },
  denied: {
    user: 'Denied — read-only mode is enforcing least-privilege.',
    model:
      'The call was blocked by the read-only mode gate (#179). Do not retry the same write call. Either ask the user to allow this tool / switch toolMode to write, or take a read-only alternative path.',
  },
  unknown: {
    user: 'Tool failed with an unrecognized error.',
    model:
      'The error did not match any known pattern. Read the snippet, consider whether one careful retry is justified, and otherwise surface to the user.',
  },
};

const SEVERITY: Record<ToolErrorType, 'low' | 'normal' | 'critical'> = {
  auth: 'critical',
  permission: 'critical',
  rate_limit: 'normal',
  not_found: 'normal',
  invalid_args: 'normal',
  exec_failed: 'normal',
  timeout: 'low',
  transient: 'low',
  parse_failed: 'low',
  pool_exhausted: 'low',
  cancelled: 'low',
  denied: 'normal',
  unknown: 'low',
};

/** Categories whose retry is worth attempting without external intervention. */
const RETRYABLE: ReadonlySet<ToolErrorType> = new Set<ToolErrorType>([
  'transient',
  'parse_failed',
  'pool_exhausted',
  'timeout',
]);

/**
 * Classifies a tool error into a taxonomy category, deciding whether it's
 * worth feeding to the correction loop and how to surface it.
 *
 * Order of inspection: explicit `httpStatus` → `errno` → string patterns on
 * `message`. `toolName` only matters for the `not_found` correctable split:
 * a shell "command not found" is a learnable mistake; a web 404 is not.
 */
export function classifyError(input: ClassifyInput): Classification {
  const category = pickCategory(input);
  return {
    category,
    correctable: isCorrectable(category, input.toolName),
    retryable: RETRYABLE.has(category),
    severity: SEVERITY[category],
    playbook: PLAYBOOKS[category],
  };
}

function pickCategory(input: ClassifyInput): ToolErrorType {
  const { httpStatus, errno, message } = input;

  if (typeof httpStatus === 'number') {
    if (httpStatus === 401) return 'auth';
    if (httpStatus === 403) return 'permission';
    if (httpStatus === 404) return 'not_found';
    if (httpStatus === 408 || httpStatus === 429) return 'rate_limit';
    if (httpStatus >= 500 && httpStatus < 600) return 'transient';
  }

  if (errno) {
    if (errno === 'ENOENT') return 'not_found';
    if (errno === 'EACCES' || errno === 'EPERM') return 'permission';
    if (errno === 'ETIMEDOUT') return 'timeout';
    if (errno === 'ECONNREFUSED' || errno === 'ENETUNREACH' || errno === 'ECONNRESET') {
      return 'transient';
    }
  }

  const m = message ?? '';

  // Bernard-internal markers first — they're high-confidence.
  if (/pool_exhausted|Maximum concurrent agents/i.test(m)) return 'pool_exhausted';
  if (/Specialist did not produce valid structured output|parse_failed/i.test(m)) {
    return 'parse_failed';
  }

  // HTTP signatures embedded in error strings (web.ts, gh CLI, etc.). Must run
  // before the generic `cancelled` pattern so a wrapped message like
  // "cancelled: HTTP 401" lands as `auth`, not `cancelled`.
  if (/\bHTTP\s*401\b|unauthori[sz]ed/i.test(m)) return 'auth';
  if (/\bHTTP\s*403\b|forbidden/i.test(m)) return 'permission';
  if (/\bHTTP\s*404\b|not\s*found/i.test(m)) {
    // shell `command not found` is a call-shape mistake (correctable);
    // a web 404 is the URL being gone (not correctable). The category is
    // shared; the correctable split happens in isCorrectable().
    return 'not_found';
  }
  if (/\bHTTP\s*(408|429)\b|rate[\s-]?limit|quota|too many requests/i.test(m)) return 'rate_limit';
  if (/\bHTTP\s*5\d\d\b|bad gateway|service unavailable|gateway timeout/i.test(m)) {
    return 'transient';
  }

  // User-cancel signatures. Runs after HTTP/auth so wrapped strings like
  // "cancelled: HTTP 401" still hit `auth`.
  if (/\bcancelled\b|aborted by user/i.test(m)) return 'cancelled';

  // Filesystem / shell signatures.
  if (/permission denied|EACCES/i.test(m)) return 'permission';
  if (/no such file or directory|ENOENT/i.test(m)) return 'not_found';

  // Timeout signatures (must come after rate_limit so 408 wins there).
  if (/timed?\s*out|ETIMEDOUT/i.test(m)) return 'timeout';

  // Auth-key signatures (missing API key on a wrapper provider).
  if (/no api key|missing.*key|api[_\s-]?key.*(missing|required|invalid)/i.test(m)) return 'auth';

  // Network-level transients.
  if (/network|ECONNRESET|ECONNREFUSED|ENETUNREACH|fetch failed/i.test(m)) return 'transient';

  // Schema-validation signatures from generateText.
  if (/invalid (?:tool )?arguments?|schema validation|zod/i.test(m)) return 'invalid_args';

  // Generic exec failure (shell, scripts). Patterns use word boundaries so a
  // stray "stderr" substring in a web response body or MCP error doesn't
  // mis-classify. `isCorrectable` further restricts learnability to shell.
  if (/\bexit code\b|\bstderr\b|syntax error|command failed/i.test(m)) return 'exec_failed';

  return 'unknown';
}

function isCorrectable(category: ToolErrorType, toolName?: string): boolean {
  switch (category) {
    case 'invalid_args':
      return true;
    case 'exec_failed':
      // Only the shell tool (and its sub-categorized profiles like `shell.gh`)
      // can learn from generic exec-failure patterns; a `stderr`-like substring
      // in a web/MCP error body isn't a call-shape mistake the model can fix.
      return isShellContext(toolName);
    case 'not_found':
      // shell command-not-found is a learnable mistake; a web/file 404 is not.
      return isShellContext(toolName);
    default:
      return false;
  }
}

function isShellContext(toolName?: string): boolean {
  return toolName === 'shell' || (typeof toolName === 'string' && toolName.startsWith('shell.'));
}

/**
 * Does this error mean the dispatch was *cancelled*, rather than that the work
 * *failed*? (#327)
 *
 * The three child-dispatch tool boundaries — `subagent`, `specialist-run`,
 * `delegate-dispatch` — catch everything and return the message as a string.
 * That is right for a genuine work failure: a failed MCP call IS a legitimate
 * tool result the model should see and react to, and stringifying it preserves
 * the useful behaviour where a model recovers from a failed sub-task on its
 * own. It is wrong for a cancellation, which reaches the parent as a
 * successful tool result the model reads as data and loops on — most visibly
 * turning a user's Esc into `Sub-agent error: Aborted` while the parent keeps
 * running until its own signal trips.
 *
 * Two shapes qualify, and both mean "something outside the work stopped it":
 *
 * - **An `AbortError`.** Either the user's signal or a provider-side
 *   cancellation. `classifyError` cannot answer this — a `DOMException` named
 *   `AbortError` carries the message `"Aborted"`, which matches neither
 *   `\bcancelled\b` nor `aborted by user`, so it classifies as `unknown`.
 * - **A `timeout`.** At *this* boundary a timeout is always the runner or the
 *   provider giving up (the dispatch stall guard, `BERNARD_DISPATCH_TIMEOUT_MS`,
 *   or the first-byte guard) — never a tool-level one like `shellTimeout`,
 *   which is caught inside the tool and returned as a formatted result rather
 *   than thrown. Handing these back as a string is what makes a stalled child
 *   satisfy "the parent is unblocked" only in the weak sense: the parent has no
 *   better decision available than the one we already made, and retrying a
 *   provider that just went dark is strictly worse than unwinding.
 */
export function isDispatchCancellation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  return classifyError({ message: err.message }).category === 'timeout';
}
