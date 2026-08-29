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
  /** Drives cron alert severity and the in-thread failure hint's colour (#353). */
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
  step_limit: {
    user: 'The sub-agent ran out of steps before finishing — its work may be partially applied.',
    model:
      'The dispatch hit its step budget and was cut off before producing a final answer. Some of its work may already be applied — check the current state before retrying, and retry with a narrower request rather than the same one.',
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
  step_limit: 'low',
  cancelled: 'low',
  denied: 'normal',
  unknown: 'low',
};

/** Categories whose retry is worth attempting without external intervention. */
const RETRYABLE: ReadonlySet<ToolErrorType> = new Set<ToolErrorType>([
  'transient',
  'parse_failed',
  'pool_exhausted',
  'step_limit',
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
  return build(pickCategory(input), input.toolName);
}

/** Assembles the classification for a category the caller already knows. */
function build(category: ToolErrorType, toolName?: string): Classification {
  return {
    category,
    correctable: isCorrectable(category, toolName),
    retryable: RETRYABLE.has(category),
    severity: SEVERITY[category],
    playbook: PLAYBOOKS[category],
  };
}

/**
 * The `[failure: <category>]` marker the wrapper shim stamps onto a failed
 * result so the category survives into the next turn's tool-result message.
 */
export function failureMarker(category: ToolErrorType): string {
  return `[failure: ${category}]`;
}

const FAILURE_MARKER_RE = /\[failure: ([a-z_]+)\]/;

/**
 * Reads a {@link failureMarker} back out of a result string, or `null`.
 *
 * Not anchored: `formatWrappedResult` wraps the shim's annotated error into
 * `Error (<marker> <hint>): <detail>`, so the marker is mid-string by the time
 * anything downstream sees it.
 */
export function parseFailureMarker(text: string): ToolErrorType | null {
  const m = FAILURE_MARKER_RE.exec(text);
  const cat = m?.[1];
  return cat && cat in PLAYBOOKS ? (cat as ToolErrorType) : null;
}

/**
 * Classifies a failed tool result, trusting an embedded marker over the
 * patterns.
 *
 * Re-running {@link classifyError} on an already-annotated result is not
 * idempotent, because the string it would match on now contains the *playbook
 * prose* rather than the original error. Measured: an `auth` failure
 * round-trips to `unknown`, dropping severity from `critical` to `low` and
 * replacing concrete recovery advice with "the error did not match any known
 * pattern". `permission` and `rate_limit` survive only by accident, their prose
 * happening to match their own regex.
 *
 * So where a marker exists it is authoritative — it was written by the
 * classifier that saw the real error.
 */
export function classifyToolFailure(input: { snippet: string; toolName?: string }): Classification {
  const marked = parseFailureMarker(input.snippet);
  return marked
    ? build(marked, input.toolName)
    : classifyError({ message: input.snippet, toolName: input.toolName });
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
  if (/step_limit|ran out of steps/i.test(m)) return 'step_limit';
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
 * `Error.name` the runner stamps on an abort it fired itself — the mid-stream
 * stall guard (#325) and `BERNARD_DISPATCH_TIMEOUT_MS`.
 *
 * A distinct name is required because the two obvious alternatives each fail.
 * It cannot be `AbortError`: the REPL renders nothing for those, treating them
 * as "user pressed Esc", so the turn would vanish silently (#302's lesson).
 * And it cannot be recognised from the message: our messages say "timed out"
 * so `classifyError` categorises them for free, but so does a provider's
 * network timeout — and the taxonomy itself marks `timeout` as
 * `retryable: true`, i.e. exactly the kind of failure a model SHOULD see and
 * work around. Keying on the message conflated the two and unwound whole turns
 * over a transient network blip.
 */
export const DISPATCH_ABORT_NAME = 'DispatchAbortError';

/**
 * Does this error mean the dispatch was *cancelled*, rather than that the work
 * *failed*? (#327)
 *
 * The five child-dispatch tool boundaries — `subagent`, `specialist-run`,
 * `delegate-dispatch`, `task`, `tool-wrapper-run` — catch everything and
 * return the message as a string. That is right for a genuine work failure: a
 * failed MCP call IS a legitimate tool result the model should see and react
 * to, and stringifying it preserves the useful behaviour where a model
 * recovers from a failed sub-task on its own. It is wrong for a cancellation,
 * which reaches the parent as a *successful* tool result the model reads as
 * data and loops on — most visibly turning a user's Esc into
 * `Sub-agent error: Aborted` while the parent keeps running until its own
 * signal trips.
 *
 * Two names qualify, and both mean "something outside the work stopped it":
 * a real `AbortError` (the user's signal, or a provider-side cancellation),
 * and {@link DISPATCH_ABORT_NAME} (an abort the runner itself fired). Note
 * `classifyError` cannot answer even the first — a `DOMException` named
 * `AbortError` carries the message `"Aborted"`, which matches neither
 * `\bcancelled\b` nor `aborted by user`, so it classifies as `unknown`.
 *
 * Deliberately NOT "any timeout". At this boundary our own timeouts are
 * covered by the name; a *provider's* timeout is a retryable work failure
 * (`RETRYABLE` includes `timeout`) that the model should be told about rather
 * than have the turn unwound over.
 */
export function isDispatchCancellation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Walk `cause`, because one of these boundaries can sit inside another and
  // the AI SDK rewrites the error in between. A throw out of `tool.execute`
  // is wrapped in `ToolExecutionError` (`name: 'AI_ToolExecutionError'`,
  // message `Error executing tool <name>: <cause message>`) — on the
  // non-streaming path directly, on the streaming path via an `error` part
  // that `runStreaming` re-throws. Reachable today as main → `agent` →
  // `delegate_<server>`, since sub-agents carry delegate tools; without the
  // walk a cancellation stops propagating after exactly one level.
  //
  // Bounded rather than `while (cause)`: an error chain is attacker-adjacent
  // input (providers and MCP servers build these) and a cycle would hang the
  // catch handler. Eight is far past any real nesting here.
  for (let e: Error | undefined = err, depth = 0; e && depth < 8; depth++) {
    if (e.name === 'AbortError' || e.name === DISPATCH_ABORT_NAME) return true;
    e = e.cause instanceof Error ? e.cause : undefined;
  }
  return false;
}
