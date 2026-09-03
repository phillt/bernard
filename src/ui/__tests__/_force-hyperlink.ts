/**
 * Shared harness for the hyperlink-rendering test file (#464).
 *
 * Why it exists: `marked-terminal` emits an OSC 8 hyperlink only when
 * `supports-hyperlinks` says the terminal supports one, and that module computes
 * `stdout` ONCE at import from `process.stdout`. Under `vitest run` stdout is
 * not a TTY, so the branch is unreachable and every markdown test in the suite
 * passes identically whether or not it emits hyperlinks — which is precisely
 * how #464 shipped. `vi.mock` cannot reach it either: vitest externalises
 * `marked-terminal` from node_modules, so it resolves `supports-hyperlinks`
 * through Node and never sees the mock.
 *
 * Why a module rather than a copied prologue: the assignment has to run before
 * the first import that reaches `supports-hyperlinks`, and a static
 * `import './_force-hyperlink.js'` is evaluated before the importing file's own
 * top-level `await import(...)` calls. Exactly the constraint — and exactly the
 * shape — of the sibling {@link file://./_force-color.ts}.
 *
 * And it exists rather than a bare inline assignment because of the bug that
 * one documents: **`process.env` is per-worker and vitest reuses workers across
 * files**, so a forced value that is never restored leaks into every later test
 * in that worker. Verified here, not assumed: a probe file running after the
 * hyperlink test in a single-threaded pool read `FORCE_HYPERLINK="1"`. Module
 * registries are isolated per file; the environment is not.
 */

/** Captured BEFORE the assignment below — that ordering is the point. */
const ORIGINAL_FORCE_HYPERLINK = process.env.FORCE_HYPERLINK;

process.env.FORCE_HYPERLINK = '1';

/** Pass to `afterAll` so the forced value does not outlive the file. */
export function restoreForceHyperlink(): void {
  if (ORIGINAL_FORCE_HYPERLINK === undefined) delete process.env.FORCE_HYPERLINK;
  else process.env.FORCE_HYPERLINK = ORIGINAL_FORCE_HYPERLINK;
}
