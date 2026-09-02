import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Path scoping for unattended writes (#340).
 *
 * A write performed with nobody approving it needs a *where*, not just a
 * *what*. The risk tiers cannot express this: a write into a job's own
 * workspace is low risk regardless of which tool made it, and a write to
 * `~/.ssh/authorized_keys` is high risk regardless. That mismatch is why #337
 * withheld the write-capable file tools from cron rather than fix the
 * underlying problem, and why cron cannot write files at all today.
 *
 * **Deliberately per-dispatch, not per-cron-job.** Cron was where the problem
 * was found, but it is not the only unattended writer: an applet action
 * (#445) is triggered from a browser with a caller supplying the arguments,
 * which is a materially less trusted origin than a cron job the user wrote.
 * Attaching the grant to a `CronJob` record would mean building the same
 * mechanism a second time for applets.
 *
 * **A scope is opt-in.** No scope means no restriction, which is what keeps
 * the interactive REPL unchanged — scoping the writes a user is watching
 * themselves make would be obstruction, not safety.
 *
 * This module is a leaf: `node:path` and `node:fs` only. It is consulted from
 * the tool gate in `augmentTools`, so it must not drag config, tools or the
 * agent runtime behind it.
 */

export interface WriteScope {
  /**
   * The directory this dispatch may always write to, no configuration needed.
   * Created on demand by the caller; this module only compares paths.
   */
  workspace: string;
  /**
   * Additional locations the user explicitly granted. Absolute paths; a
   * directory grants its whole subtree.
   */
  grants?: string[];
}

/**
 * True when `child` is `parent` or sits beneath it.
 *
 * @internal Exported for testing only.
 *
 * Separator-aware on purpose. A bare `startsWith` matches `/safe-dir-evil`
 * against a `/safe-dir` grant — the allowlist would read as scoped and would
 * not be. Both sides are already resolved when this is called.
 */
export function isContainedIn(parent: string, child: string): boolean {
  if (parent === child) return true;
  const base = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(base);
}

/**
 * Resolves a path for comparison, following symlinks as far as the filesystem
 * actually goes.
 *
 * @internal Exported for testing only.
 *
 * The target of a write usually does not exist yet, so `realpathSync` on it
 * would throw. Resolving the nearest existing ancestor and re-appending the
 * missing tail is what makes containment survive a symlinked parent —
 * `~/safe/link -> /etc` must not let `~/safe/link/passwd` through. Without
 * this the allowlist is decoration, which is the failure mode #340 calls out
 * by name.
 */
export function resolveForComparison(target: string): string {
  const abs = path.resolve(target);
  let existing = abs;
  const tail: string[] = [];

  // Walk up until something exists. Bounded by the path's own depth.
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return abs; // reached the root without finding one
    tail.unshift(path.basename(existing));
    existing = parent;
  }

  try {
    return path.join(fs.realpathSync(existing), ...tail);
  } catch {
    // A race (the ancestor vanished) or a permission error. Fall back to the
    // lexically resolved path: `path.resolve` has already removed `..`, so the
    // check stays conservative rather than opening up.
    return abs;
  }
}

/**
 * Decides whether `target` may be written under `scope`.
 *
 * Returns `null` to allow, or a model-facing refusal that **names where the
 * write may go instead** — the caller is generated code with no operator
 * watching, and a bare "denied" gets retried against the same path forever.
 *
 * Reason-or-`null` rather than a `{allowed}` union because the only consumer
 * flattened the union to exactly this in three lines; the two now agree
 * instead of translating between each other.
 *
 * Every allowed location is resolved the same way as the target, so a grant
 * that is itself a symlink compares correctly.
 */
export function checkWritePath(scope: WriteScope, target: string): string | null {
  if (typeof target !== 'string' || target.trim() === '') {
    return refusal(scope, '(empty path)');
  }

  const resolved = resolveForComparison(target);
  const allowed = [scope.workspace, ...(scope.grants ?? [])];

  for (const location of allowed) {
    if (isContainedIn(resolveForComparison(location), resolved)) return null;
  }

  return refusal(scope, resolved);
}

function refusal(scope: WriteScope, resolved: string): string {
  const extra = scope.grants?.length ? ` Also granted: ${scope.grants.join(', ')}.` : '';
  return (
    `Write to ${resolved} refused — outside this run's allowed paths. ` +
    `Write to ${scope.workspace} instead, or ask the user to grant the location.${extra}`
  );
}

/**
 * The instruction that keeps a scoped run from burning its step budget.
 *
 * Authored here, beside {@link checkWritePath}'s refusal, because the two are
 * halves of one contract: the refusal names where the write may go, and this
 * says the same thing before the model has to be refused at all. Split across
 * files they drift, and the failure is silent — a job with no operator retries
 * a rejected path until its steps run out.
 *
 * It lived on `cronDefinition` first, which meant any second scoped caller
 * either re-authored it or shipped without it.
 */
export function writeScopePrompt(scope: WriteScope): string {
  const also = scope.grants?.length ? ` You may also write to: ${scope.grants.join(', ')}.` : '';
  return [
    '## Where you may write',
    `Write files to \`${scope.workspace}\` — it exists and is yours for this run.${also}`,
    'Writes anywhere else are refused. Do not retry a refused path; use the workspace instead.',
  ].join('\n');
}
