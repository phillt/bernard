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
import { isPidAlive } from '../pid.js';
import { resetActiveWatcherCount, setActiveWatcherCount } from './active-count.js';
import { evaluate, type Evaluation } from './evaluate.js';
import { probe, type ProbeDeps } from './probe.js';
import { buildWake, type Wake } from './wake.js';
import type { WatcherStore } from './store.js';
import {
  DEFAULT_MAX_FIRES,
  MAX_PROBE_FAILURES,
  carriedState,
  isDue,
  isPollable,
  type Watcher,
} from './types.js';

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
  /**
   * Called when a watcher fires. Must not throw.
   *
   * Returns whether the wake was ACCEPTED. A consumer with a bounded queue can
   * refuse, and refusing must not spend the watcher: it is marked terminal
   * before delivery (so a wake queued behind a long turn cannot fire twice), so
   * without a way to say no, one full queue permanently consumes the watcher
   * the user was waiting on.
   */
  onWake: (wake: Wake) => boolean | void;
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
    this.opts.store.sweep(this.now());
    // Look immediately, then on the interval — `InboxWatcher.start`'s shape and
    // for the same reason. A watcher adopted from a dead session, or one whose
    // `time` target came due while no session was running, should not wait a
    // full tick to be noticed; the first thing a user does after restarting is
    // ask why nothing happened. Adoption is the first thing `tick` does, so
    // this also covers "adopt before the first poll" without a second sweep of
    // the directory to do it.
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
   * `kill(pid, 0)` liveness, the idiom `inbox/registry.ts` uses — but NOT its
   * justification, which inverts here and should not be borrowed. There, a
   * stale-but-recycled pid means "do not deliver", which is safe. Here it means
   * "do not adopt", i.e. the watcher silently never fires again. The failure
   * direction is the opposite one.
   *
   * What makes it acceptable is the other half: a LIVE owner's pid is alive by
   * definition, so this can never take a watcher away from a session that is
   * still polling it. The residual is a recycled pid making an orphan look
   * owned — bounded by running this every tick rather than once, so a later tick
   * catches it once the imposter exits.
   *
   * Takes the tick's own listing and returns the records it rewrote, rather than
   * reading the directory itself. It runs on every tick beside the owned-set
   * scan, so a private read was a second full `readdir` + parse of the same
   * files milliseconds after the first — for the life of the session.
   */
  private adoptOrphans(all: readonly Watcher[]): Map<string, Watcher> {
    const adopted = new Map<string, Watcher>();
    for (const w of all) {
      if (w.status !== 'active' || isPidAlive(w.ownerPid)) continue;
      const next = this.opts.store.update(w.id, {
        ownerSessionId: this.opts.sessionId,
        ownerPid: process.pid,
      });
      if (next) adopted.set(w.id, next);
      debugLog('watcher:adopted', { id: w.id, name: w.name, fromPid: w.ownerPid });
    }
    return adopted;
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
      // Every tick, not only at `start()`. An owner that dies while this session
      // is running otherwise leaves its watchers in the "reads as active, will
      // never fire" state until the next restart — precisely the state adoption
      // exists to remove.
      const all = this.opts.store.list();
      const adopted = this.adoptOrphans(all);
      // An adopted record's entry in `all` still names its dead owner, so the
      // rewritten one replaces it — otherwise a watcher is adopted and then not
      // polled until the next tick.
      const owned = all
        .map((w) => adopted.get(w.id) ?? w)
        .filter((w) => w.ownerSessionId === this.opts.sessionId);
      // Published before the polls rather than after: a probe can take seconds,
      // and the bar should show the count for the tick it is in, not the last.
      setActiveWatcherCount(owned.filter((w) => isPollable(w, now)).length);
      for (const w of owned) {
        if (!isPollable(w, now)) {
          if (w.status === 'active') this.opts.store.finish(w.id, 'expired', {}, w);
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
      this.countFailure(w, result.error, checkedAt, 'watcher:failed');
      return;
    }

    const verdict = evaluate(w, result.observation);
    // A watcher that cannot read its own predicate is not watching anything, and
    // the user believes it is. Counted as a probe failure so it trips
    // `MAX_PROBE_FAILURES` and stops with a `lastError` naming the path, rather
    // than polling cleanly forever. The reason comes from `evaluate`, the one
    // place holding both the predicate and the payload it failed against.
    if (verdict.unreadable) {
      this.countFailure(w, verdict.unreadable, checkedAt, 'watcher:unreadable');
      return;
    }
    if (!verdict.fired) {
      // A quiet poll rewrites the record byte-identically except for
      // `lastCheckedAt`, and a repeating watcher does that for its whole life —
      // measured at 2.6 MB/day for a 20-id record at the 60 s default, 33 MB/day
      // at 500 ids. `RAGStore` debounces exactly this shape (#533), and it is
      // deliberately NOT copied here: there the write was 188 ms of
      // `JSON.stringify` on the turn's critical path, and here it is ~0.05 ms on
      // a background timer. It would also need real machinery rather than a
      // timer, because `isDue` reads `lastCheckedAt` off the record — skipping
      // the write without an in-memory overlay makes every watcher due on every
      // tick, i.e. polls somebody's server every 5 s instead of every 60.
      this.opts.store.update(
        w.id,
        {
          lastCheckedAt: checkedAt,
          // Reset on success: five *consecutive* failures is the rule, so a
          // transient blip a week ago must not add to today's.
          failureCount: 0,
          ...carriedState(verdict),
        },
        w,
      );
      return;
    }

    // Mark terminal BEFORE waking. A wake can be queued behind a long turn, and
    // a watcher left active in the meantime would fire again on the next tick —
    // the user asked to be told once.
    const firedAt = new Date(this.now()).toISOString();
    if (w.repeating) {
      // Advance and stay armed, in THIS pass. Note the ordering difference from
      // the one-shot path: there is no window in which a repeating watcher is
      // terminal, because it never becomes terminal.
      this.rearm(w, verdict, checkedAt);
    } else {
      this.opts.store.finish(
        w.id,
        'fired',
        { firedAt, lastCheckedAt: checkedAt, failureCount: 0 },
        w,
      );
    }
    debugLog('watcher:fired', {
      id: w.id,
      name: w.name,
      reason: verdict.reason,
      repeating: w.repeating === true,
    });

    const wake = buildWake(
      w,
      verdict.reason ?? 'condition met',
      w.target.kind === 'time' ? null : { value: result.observation.value },
      new Date(this.now()),
    );
    // Terminal BEFORE delivery, then restored if the consumer refuses. Marking
    // after would let a wake sitting behind a long turn fire again on the next
    // tick; not restoring would spend the watcher on a refusal the user never
    // got the benefit of — and the watcher is the thing they were waiting on.
    if (this.opts.onWake(wake) === false) {
      // Put the record we were HOLDING back, whole. `w` is by construction the
      // state before any of the fire, so it cannot be an incomplete list of what
      // to undo — and `lastCheckedAt` is the one field kept, because we really
      // did look.
      //
      // The patch this replaces was correct, and only for a reason nobody should
      // have to hold in their head: it enumerated five fields, and the other
      // four came back because `update` merges the patch onto the `known`
      // record — which was `w` — rather than onto disk. So the enumeration was
      // redundant rather than wrong, and it read as the thing doing the work.
      // Delete the `known` argument as an optimisation nobody needs and the
      // advanced `etag` silently survives a refusal, which sends the next poll's
      // `If-None-Match` for a body this watcher never acted on.
      //
      // `replace`, not `update`, for the same reason: a patch merges, so it can
      // add and overwrite but never REMOVE, and `firedAt` is a key the fire path
      // added. Spreading `w` into a patch cannot take it away again.
      this.opts.store.replace({ ...w, lastCheckedAt: checkedAt });
      debugLog('watcher:wake-refused', { id: w.id, name: w.name });
    }
  }

  /**
   * Records a failed poll, and stops the watcher once they stack up.
   *
   * One helper rather than the two byte-identical branches this replaces — a
   * probe that could not run and a predicate that could not be read are the same
   * bookkeeping, and written twice they are two places to keep in step the day a
   * sixth field joins the patch.
   *
   * A watcher that has been failing all day is not watching anything, and the
   * user believes it is. It stops rather than retrying forever.
   */
  private countFailure(w: Watcher, lastError: string, checkedAt: string, event: string): void {
    const failureCount = w.failureCount + 1;
    const patch = { failureCount, lastError, lastCheckedAt: checkedAt };
    if (failureCount >= MAX_PROBE_FAILURES) {
      this.opts.store.finish(w.id, 'failed', patch, w);
      debugLog(event, { id: w.id, name: w.name, error: lastError });
      return;
    }
    this.opts.store.update(w.id, patch, w);
  }

  /**
   * Re-arms a repeating watcher, in the same pass that fired it.
   *
   * The baseline advances to the ids THIS poll saw, which is what removes the
   * gap: re-arming from a later turn re-reads the target, so anything arriving
   * in between is already present and is silently swallowed into the new
   * baseline. Observed in use — replies landed in that window, across six
   * hand-made re-arms.
   */
  private rearm(w: Watcher, verdict: Evaluation, checkedAt: string): void {
    const fireCount = (w.fireCount ?? 0) + 1;
    const maxFires = w.maxFires ?? DEFAULT_MAX_FIRES;
    if (fireCount >= maxFires) {
      // Stops rather than continuing quietly: a repeating watcher is the one
      // shape here that can run away, and the user should find it finished with
      // a reason rather than still going.
      this.opts.store.finish(
        w.id,
        'fired',
        { fireCount, firedAt: new Date(this.now()).toISOString(), lastCheckedAt: checkedAt },
        w,
      );
      debugLog('watcher:max-fires', { id: w.id, name: w.name, fireCount });
      return;
    }
    this.opts.store.update(
      w.id,
      {
        fireCount,
        lastCheckedAt: checkedAt,
        failureCount: 0,
        ...carriedState(verdict),
      },
      w,
    );
  }
}
