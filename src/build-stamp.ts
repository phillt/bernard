import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Noticing that this process is running code its own `dist/` no longer holds.
 *
 * Node caches an ES module per PROCESS, keyed on resolved URL, and never
 * re-reads it. A long-lived daemon therefore keeps whatever `dist/` held when
 * it booted — which is harmless right up until a **deferred** `await import()`
 * runs for the first time. That one loads the file as it is on disk NOW and
 * links it against the stale cache, so a module rebuilt to use a new export
 * from a module the process already holds fails to link. The tree carries 48
 * such deferred imports, and the applet host is the one they bite: its whole
 * job is to sit idle until somebody clicks, so the first invoke after a
 * rebuild is where the fresh half of the graph first gets loaded.
 *
 * Observed as a nine-day-old applet host answering every button with a bare
 * `500` and `The requested module './paths.js' does not provide an export
 * named 'WORKSPACE_MAX_AGE_MS'` — a constant added six days after it booted.
 * The same process was also serving that release's stylesheet from memory, so
 * a width fix that had shipped was invisible in the browser. Both symptoms,
 * one stale process.
 *
 * This is NOT an `ai` SDK or Node defect. Per-process module caching is the
 * specified behaviour and the deferred imports are ours and deliberate (#452
 * measured `bernard script` at 163 ms → 17 ms because of them). What was
 * missing is that nothing noticed the combination.
 */

/**
 * Content hash of every `.js` file under `dir`.
 *
 * Only `.js`, because the module cache is exactly the surface this is about.
 * A changed `dist/data/*.json` or a re-copied builtin specialist is read from
 * disk at use and needs no restart, so hashing those would restart a daemon
 * for a change that could not affect it.
 *
 * Content, never mtime: `tsc` has no `incremental` flag here and rewrites all
 * 425 outputs on every build, so a no-op rebuild moves every mtime while
 * changing nothing. Restarting on that would rotate the host's tokens — and
 * so break every open applet tab — for a build that did nothing. Measured at
 * 10 ms over the real 11 MB tree, which is cheap enough to run on every
 * debounced change rather than trusting a proxy.
 */
export function buildFingerprint(dir: string): string {
  const hash = crypto.createHash('sha256');
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // A directory that vanished mid-walk (an upgrade replacing `dist/`)
      // simply contributes nothing. The next settle pass sees the new tree.
      return;
    }
    // Sorted, or the hash depends on readdir order and every call disagrees
    // with the last for reasons that have nothing to do with the build.
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      try {
        hash.update(full);
        hash.update(fs.readFileSync(full));
      } catch {
        /* raced with the writer; the settle pass below is what covers this */
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

/**
 * The `dist/` this module was loaded from.
 *
 * Derived from `import.meta.url` rather than from `process.cwd()` or a
 * configured path, because the question is "where is the code I am RUNNING",
 * and only the module itself can answer that. It is correct for a global npm
 * install, a `npm link`, and a checkout alike.
 */
export function ownBuildDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * How often the tree is re-hashed.
 *
 * A POLL, not an `fs.watch`. The first cut watched `dist/` recursively and it
 * took the applet host down: an `FSWatcher` is an `EventEmitter`, an `'error'`
 * event with no listener THROWS, and the daemon runs `stdio: 'ignore'` — so a
 * recursive watch over ~30 directories being rewritten wholesale by `tsc`
 * ended the process with no restart line, no shutdown line and nothing on
 * disk to say why. A self-heal that can kill the thing it is healing is worse
 * than the staleness it fixes.
 *
 * Polling removes the entire surface: no inotify, no per-platform recursive
 * support, no queue to overflow, no error event. It costs a 10 ms hash of the
 * real 11 MB tree every 30 s in a process that otherwise sits idle, and the
 * only thing given up is latency — picking a rebuild up within half a minute
 * is not a property anybody needs sharpened.
 */
const POLL_MS = 30_000;

export interface WatchBuildOptions {
  /** Defaults to the `dist/` this module was loaded from. */
  dir?: string;
  /** Called once, after the new tree has settled. Never called concurrently. */
  onStale: (fingerprint: string) => void;
  log?: (msg: string) => void;
  /**
   * Timing overrides.
   *
   * Present for tests, and they are not a seam bolted on for convenience:
   * the debounce and the settle window ARE the behaviour worth pinning —
   * "a half-written tree must not trigger a restart" is a statement about
   * time, and a test that cannot compress it cannot make it. Production
   * passes neither.
   */
  pollMs?: number;
}

/**
 * Calls `onStale` when this process's own `dist/` stops matching what it
 * booted with. Returns a stop function.
 *
 * Deliberately fires at most once: every caller's response is to replace the
 * process, so there is no second event to report and a re-arm would only race
 * the shutdown it just triggered.
 */
export function watchOwnBuild(opts: WatchBuildOptions): () => void {
  const dir = opts.dir ?? ownBuildDir();
  const log = opts.log ?? ((): void => {});
  const pollMs = opts.pollMs ?? POLL_MS;
  const baseline = buildFingerprint(dir);

  let fired = false;
  /** A change seen once and not yet confirmed by a second look. */
  let pending: string | undefined;

  const stop = (): void => {
    clearInterval(timer);
  };

  /**
   * One pass. Requires the SAME new fingerprint twice before reporting.
   *
   * A build writes hundreds of files over seconds, so the first differing
   * hash describes a half-written tree; restarting on it would boot a
   * replacement against a graph `tsc` has not finished emitting — the exact
   * failure this module exists to remove, caused by its own fix.
   *
   * Written as a state machine over the one interval rather than a nested
   * settle timer. The nested version reset itself on every poll, so whenever
   * the poll was faster than the settle it never fired at all — a self-heal
   * that silently does nothing, which is the worst of the three outcomes.
   */
  const check = (): void => {
    if (fired) return;
    const now = buildFingerprint(dir);
    if (now === baseline) {
      // Written and reverted, or a rebuild whose output matched after all.
      // Back to waiting; a latch here would miss the next real build.
      pending = undefined;
      return;
    }
    if (pending !== now) {
      pending = now;
      return;
    }
    fired = true;
    stop();
    log(`build changed under a running process (${baseline.slice(0, 12)} -> ${now.slice(0, 12)})`);
    opts.onStale(now);
  };

  // `unref` so a pending timer can never be the reason a process will not
  // exit — the rule `src/inbox/` already follows for its own watcher.
  const timer = setInterval(check, pollMs);
  timer.unref?.();

  return stop;
}

/**
 * Replaces this process with a fresh one running the same entry script.
 *
 * `spawn`, never `fork`: `fork` opens an IPC channel that keeps the PARENT
 * alive past `unref()`, which is the hazard `src/host/client.ts` records at
 * length and which both daemons were moved off in #586. We are about to exit,
 * so a channel we would never talk on is purely a way to fail to.
 *
 * The caller must have released every listening socket first — the
 * replacement binds the same hash-derived ports, and a port still held by the
 * outgoing process is logged by the new one as "could not serve", which is an
 * applet that silently stops answering until somebody restarts it by hand.
 */
export function respawnSelf(opts: { entry: string; pidFile?: string }): boolean {
  const child = spawn(process.execPath, [opts.entry], { detached: true, stdio: 'ignore' });
  child.unref();
  if (!child.pid) return false;
  if (opts.pidFile) {
    try {
      fs.mkdirSync(path.dirname(opts.pidFile), { recursive: true });
      fs.writeFileSync(opts.pidFile, String(child.pid), 'utf-8');
    } catch {
      // The child writes its own pid at boot too, so this is belt and braces.
    }
  }
  return true;
}

export interface RestartOnRebuildOptions {
  /** This process's own entry, `fileURLToPath(import.meta.url)`. */
  entry: string;
  pidFile: string;
  log: (msg: string) => void;
  /** How much work is still running; the drain waits for it to reach zero. */
  inFlight: () => number;
  /** What one unit of that work is called in the log line — `invocation`, `job`. */
  unit: string;
  drainTimeoutMs: number;
  drainPollMs: number;
  /** Runs BEFORE the drain — a notice that should land while somebody is looking. */
  onRestarting?: () => void;
  /** Runs after the drain and before the respawn — close servers, stop schedulers. */
  beforeExit: () => void | Promise<void>;
}

/**
 * Replaces this process after Bernard was rebuilt or upgraded underneath it.
 *
 * Why at all: a daemon holds its module graph for its whole life, and the
 * deferred `await import()` calls scattered through the tree link fresh code
 * against that stale cache the first time they run. The applet host is where
 * it bites — it sits idle for days and then loads half the graph on the first
 * click — and the cron daemon has the same shape one job later.
 *
 * Automatic rather than a prompt, because the alternative is what shipped:
 * nothing noticed, every applet answered `500`, the only evidence was a log
 * file nothing surfaces, and the stylesheet the pages were being served was
 * nine days old. Nobody restarts a daemon by hand on a schedule they cannot
 * see.
 *
 * One sequence for both daemons rather than one each, because what differs
 * between them is two numbers, the in-flight reader and the close step, and
 * a fix to the drain landing in one and not the other is the drift this
 * repo keeps paying for. What is deliberately NOT shared is how each daemon
 * is STARTED — `startHost` and cron's client differ in how they ask whether
 * one is already up, and CLAUDE.md records that decision.
 *
 * Returns the watcher's `stop`.
 */
export function restartOnRebuild(opts: RestartOnRebuildOptions): () => void {
  const restart = async (): Promise<void> => {
    if (!fs.existsSync(opts.entry)) {
      // Mid-upgrade, or a `dist/` that was removed rather than replaced.
      // Staying up on stale code beats exiting into nothing.
      opts.log(`not restarting: own entry ${opts.entry} is gone`);
      return;
    }
    opts.log('bernard was rebuilt; restarting to pick up the new build');
    try {
      opts.onRestarting?.();
    } catch {
      // Nothing about reporting a restart may prevent one.
    }
    const deadline = Date.now() + opts.drainTimeoutMs;
    while (opts.inFlight() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, opts.drainPollMs));
    }
    const left = opts.inFlight();
    if (left > 0) opts.log(`restarting with ${left} ${opts.unit}(s) still running`);
    await opts.beforeExit();
    if (!respawnSelf({ entry: opts.entry, pidFile: opts.pidFile })) {
      opts.log('respawn failed; exiting anyway so a later start is clean');
    }
    process.exit(0);
  };
  return watchOwnBuild({ log: opts.log, onStale: () => void restart() });
}

/**
 * A crash must leave a trace.
 *
 * Both daemons are spawned `stdio: 'ignore'`, so anything Node writes to
 * stderr on the way down goes nowhere — and the daemon's own log is the only
 * place a person can look. That gap cost real debugging time: an unhandled
 * `'error'` event from a recursive `fs.watch` ended the host mid-session with
 * no restart line, no shutdown line, and nothing on disk to say it had
 * happened at all.
 *
 * It exits rather than swallowing. A process that keeps running after an
 * unhandled exception is in a state nobody designed, and the pid file would
 * still name it while it served nothing.
 */
export function exitLoudlyOnFatal(log: (msg: string) => void): void {
  const describe = (err: unknown): string =>
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.on('uncaughtException', (err: unknown) => {
    log(`fatal: ${describe(err)}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    log(`fatal (unhandled rejection): ${describe(reason)}`);
    process.exit(1);
  });
}
