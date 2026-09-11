/**
 * @module watchers/poller
 *
 * The loop. Structurally `InboxWatcher` again — a plain class with no React, no
 * Ink and no agent runtime, constructed in a mount-once effect, `unref()`ed so a
 * missed `stop()` can never be why a process will not exit, re-entrancy guarded,
 * and it never throws.
 *
 * ## Why it lives in the REPL rather than the cron daemon
 *
 * It reuses the session's already-connected `MCPManager`. The REPL builds
 * exactly one and closes it only at exit, while cron connects MCP **per job
 * run** at a measured 1.1-1.6 s — a cost a 60 s poll cannot pay. It also means
 * watchers never touch the cron scheduler, so cron's silent dropping of fires
 * during OS sleep (#400) is not a prerequisite for this feature.
 *
 * Two borrowing rules, both load-bearing:
 *
 * - **Re-take the tool registry every poll.** `tools` is a getter, never a
 *   cached bag. `MCPManager.snapshot()`'s own docstring exists because handing
 *   the flat bag around without `serverTools` is the #305 regression that
 *   silently zeroed every `delegate_<server>`; a captured bag also cannot see a
 *   server that reconnected.
 * - **Never `close()`.** That tears down every client for the whole session. The
 *   poller borrows the manager; the REPL owns it.
 */
import { debugLog } from '../logger.js';
import { resetActiveWatcherCount, setActiveWatcherCount } from './active-count.js';
import { evaluate, digestOf } from './evaluate.js';
import { idsAt } from './extract.js';
import { probe, type ProbeDeps } from './probe.js';
import { buildWake, type Wake } from './wake.js';
import type { WatcherStore } from './store.js';
import { MAX_PROBE_FAILURES, isDue, isPollable, type Watcher } from './types.js';

/**
 * How often the loop LOOKS for due watchers — the granularity of the clock, not
 * the poll interval itself.
 *
 * A watcher's own `intervalMs` decides how often it is probed; this only decides
 * how precisely that interval is honoured, so the cost of a tick is one
 * `readdir` and a comparison per owned watcher, not a network call. 5 s keeps a
 * 15 s floor honest without making the idle case measurable.
 */
export const TICK_MS = 5_000;

/**
 * Tick granularity, from `BERNARD_WATCHER_TICK_MS`.
 *
 * Same parse rules as every other budget in the tree (`parseStreamStallTimeoutMs`,
 * `resolveStallTimeoutMs`): unparseable or `<= 0` falls back rather than
 * disabling, because a tick of zero is not an off switch for watchers — removing
 * the watcher is.
 */
export function resolveTickMs(): number {
  const raw = process.env.BERNARD_WATCHER_TICK_MS;
  if (!raw) return TICK_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : TICK_MS;
}

export interface WatcherPollerOptions {
  store: WatcherStore;
  sessionId: string;
  deps: ProbeDeps;
  /** Called when a watcher fires. Must not throw. */
  onWake: (wake: Wake) => void;
  /** Test seam; defaults to the wall clock. */
  now?: () => number;
  tickMs?: number;
}

export class WatcherPoller {
  private readonly opts: WatcherPollerOptions;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(opts: WatcherPollerOptions) {
    this.opts = opts;
  }

  start(): void {
    // Adopt before the first tick: a watcher whose owning session died is one
    // nobody is polling, and the alternative is a record that exists, reads as
    // active in `/watchers`, and will never fire again — the silent failure the
    // whole feature exists to remove.
    this.adoptOrphans();
    this.opts.store.sweep(this.now());
    // Look immediately, then on the interval — `InboxWatcher.start`'s shape and
    // for the same reason. A watcher adopted from a dead session, or one whose
    // `time` target came due while no session was running, should not wait a
    // full tick to be noticed; the first thing a user does after restarting is
    // ask why nothing happened.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? resolveTickMs());
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Or the status bar keeps claiming to watch something nothing is polling.
    resetActiveWatcherCount();
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /**
   * Claims watchers whose owner is gone.
   *
   * `kill(pid, 0)` liveness, the idiom `inbox/registry.ts` uses. A stale pid can
   * only fail to match — it cannot hand this session somebody else's live
   * watcher, because a live owner's pid is alive by definition.
   */
  private adoptOrphans(): void {
    for (const w of this.opts.store.orphans()) {
      this.opts.store.update(w.id, {
        ownerSessionId: this.opts.sessionId,
        ownerPid: process.pid,
      });
      debugLog('watcher:adopted', { id: w.id, name: w.name, fromPid: w.ownerPid });
    }
  }

  /**
   * One pass. Polls every watcher this session owns that is due.
   *
   * Sequential, not `Promise.all`: each probe can be a real call to somebody's
   * server, and firing ten at once every tick is the behaviour that gets a
   * watcher rate-limited out of the thing it is watching.
   */
  async tick(): Promise<void> {
    // A slow probe must not stack ticks on top of each other. The same
    // re-entrancy guard `InboxWatcher.drain` carries, for the same reason.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const owned = this.opts.store.ownedBy(this.opts.sessionId);
      // Published before the polls rather than after: a probe can take seconds,
      // and the bar should show the count for the tick it is in, not the last.
      setActiveWatcherCount(owned.filter((w) => isPollable(w, now)).length);
      for (const w of owned) {
        if (!isPollable(w, now)) {
          if (w.status === 'active') this.opts.store.finish(w.id, 'expired');
          continue;
        }
        if (!isDue(w, now)) continue;
        await this.pollOne(w);
      }
    } catch (err) {
      // Never throws: this runs from a timer with nobody to catch it, and a
      // failure to watch must not become louder than the thing being watched.
      debugLog('watcher:tick-error', {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.ticking = false;
    }
  }

  private async pollOne(w: Watcher): Promise<void> {
    const checkedAt = new Date(this.now()).toISOString();
    const result = await probe(w.target, this.opts.deps, {
      etag: w.etag,
      lastModified: w.lastModified,
    });

    if (!result.ok) {
      const failureCount = w.failureCount + 1;
      // A watcher that has been failing all day is not watching anything, and
      // the user believes it is. It stops rather than retrying forever.
      if (failureCount >= MAX_PROBE_FAILURES) {
        this.opts.store.finish(w.id, 'failed', { failureCount, lastError: result.error, lastCheckedAt: checkedAt });
        debugLog('watcher:failed', { id: w.id, name: w.name, error: result.error });
        return;
      }
      this.opts.store.update(w.id, { failureCount, lastError: result.error, lastCheckedAt: checkedAt });
      return;
    }

    const verdict = evaluate(w, result.observation);
    if (!verdict.fired) {
      this.opts.store.update(w.id, {
        lastCheckedAt: checkedAt,
        // Reset on success: five *consecutive* failures is the rule, so a
        // transient blip a week ago must not add to today's.
        failureCount: 0,
        ...(verdict.snapshot === undefined ? {} : { snapshot: verdict.snapshot }),
        ...(verdict.baselineIds === undefined ? {} : { baselineIds: verdict.baselineIds }),
        ...(verdict.etag === undefined ? {} : { etag: verdict.etag }),
        ...(verdict.lastModified === undefined ? {} : { lastModified: verdict.lastModified }),
      });
      return;
    }

    // Mark terminal BEFORE waking. A wake can be queued behind a long turn, and
    // a watcher left active in the meantime would fire again on the next tick —
    // the user asked to be told once.
    const firedAt = new Date(this.now()).toISOString();
    this.opts.store.finish(w.id, 'fired', { firedAt, lastCheckedAt: checkedAt, failureCount: 0 });
    debugLog('watcher:fired', { id: w.id, name: w.name, reason: verdict.reason });

    const wake = buildWake(
      w,
      verdict.reason ?? 'condition met',
      w.target.kind === 'time' ? null : { value: result.observation.value },
      new Date(this.now()),
    );
    this.opts.onWake(wake);
  }
}

/** The baseline a watcher must carry before its first poll. */
export async function captureBaseline(
  target: Watcher['target'],
  predicate: Watcher['predicate'],
  deps: ProbeDeps,
): Promise<
  { ok: true; snapshot?: string; baselineIds?: string[]; etag?: string; lastModified?: string }
  | { ok: false; error: string }
> {
  // A `time` target has nothing to baseline against.
  if (target.kind === 'time') return { ok: true };

  const result = await probe(target, deps);
  if (!result.ok) return { ok: false, error: result.error };

  const obs = result.observation;
  const extract = target.kind === 'mcp' ? target.extract : undefined;
  const out: { ok: true; snapshot?: string; baselineIds?: string[]; etag?: string; lastModified?: string } = {
    ok: true,
    ...(obs.etag === undefined ? {} : { etag: obs.etag }),
    ...(obs.lastModified === undefined ? {} : { lastModified: obs.lastModified }),
  };

  // Captured at CREATION, which is what makes "tell me when this changes" mean
  // what it says. Deferred to the first poll, a real digest would compare
  // unequal to an absent one and every watcher would fire the moment it was made.
  if (predicate.kind === 'changed') out.snapshot = digestOf(obs.value, extract);
  if (predicate.kind === 'appeared') {
    // `?? []` is right HERE and wrong in `evaluate`: at creation an unreadable
    // path means "nothing known yet", so the first poll's ids all count as new;
    // mid-flight it would mean "forget what you knew", which fires a false wake
    // naming items that were always there.
    out.baselineIds = idsAt(obs.value, predicate.idPath) ?? [];
  }
  return out;
}
