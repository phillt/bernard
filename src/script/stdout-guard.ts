/**
 * Redirects everything written to `process.stdout` onto stderr for the
 * duration of `fn`.
 *
 * `bernard script` promises exactly one JSON object on stdout, because that is
 * the only contract a calling program can parse. Keeping that promise by
 * auditing print call sites does not survive contact: `src/tools/augment.ts`
 * already writes to stdout from inside any dispatch that records a tool-profile
 * error or learns a fix, and it is reachable from every tool an action can
 * call. Anything reached through a third-party MCP server is further out of
 * reach still.
 *
 * So the guarantee is made structural rather than by convention — one place
 * that cannot be forgotten by a future tool author. The result line is written
 * after this returns, on a restored stdout.
 *
 * Restored in a `finally`: a throw mid-run must not leave the process with a
 * permanently hijacked stdout.
 */
export async function withStdoutRedirectedToStderr<T>(fn: () => Promise<T>): Promise<T> {
  // Captured unbound, so the restore is identity-preserving. Binding here
  // would hand back a different function than the one taken, and nesting two
  // guards would accumulate wrappers instead of unwinding cleanly.
  const original = process.stdout.write;
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: unknown,
    cb?: unknown,
  ): boolean => {
    // Signature-compatible forward; `process.stderr.write` accepts the same
    // three overloads, so nothing about the caller's contract changes.
    return (process.stderr.write as (...a: unknown[]) => boolean)(chunk, encoding, cb);
  }) as typeof process.stdout.write;

  try {
    return await fn();
  } finally {
    process.stdout.write = original;
  }
}
