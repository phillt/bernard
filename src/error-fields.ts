/**
 * The structured fields an SDK error already carries.
 *
 * A thrown provider error usually knows more than its message: a status code, a
 * transport `errno`. `classifyError` accepts both and classifies far better
 * with them — measured, a 429 with a terse message reads `unknown` from the
 * message alone and `rate_limit` from the status.
 *
 * Lifted out of `model-validate.ts`, where it was private and had one caller
 * (the `/models` live probe), because the turn-error formatter needs the same
 * duck-typing and a second copy is how the two drift. A leaf with no imports,
 * so nothing pays to ask this question.
 */
export function extractErrorFields(err: unknown): {
  httpStatus?: number;
  errno?: string;
  message: string;
} {
  const e = err as {
    message?: unknown;
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    errno?: unknown;
  };
  const message = typeof e?.message === 'string' && e.message ? e.message : String(err);
  let httpStatus: number | undefined;
  if (typeof e?.statusCode === 'number') httpStatus = e.statusCode;
  else if (typeof e?.status === 'number') httpStatus = e.status;
  let errno: string | undefined;
  if (typeof e?.code === 'string') errno = e.code;
  else if (typeof e?.errno === 'string') errno = e.errno;
  return { httpStatus, errno, message };
}
