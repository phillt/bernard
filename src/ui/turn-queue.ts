/**
 * @module ui/turn-queue
 *
 * Turns that are waiting for the current one to finish.
 *
 * ## Why this has to exist before anything can wake Bernard
 *
 * A turn started while one is already running currently hits `submittingRef` at
 * the top of `runAgentTurn` and **returns silently** — not queued, not surfaced,
 * no error. That guard is right for its own case (a second Enter arriving before
 * `<Prompt disabled={busy}>` re-renders), and harmless there because the
 * keystroke that produced it was never going to be honoured anyway.
 *
 * It stops being harmless the moment something other than a keystroke can start
 * a turn. A watcher firing mid-turn would vanish, having already marked itself
 * fired — the user asked to be told when John replied, was told nothing, and the
 * watcher is spent. So the queue is a prerequisite for waking, not a convenience
 * on top of it.
 *
 * ## Why queue rather than steer
 *
 * #493 requires the mid-turn answer to be one of the two already designed: #200
 * (inject at a safe checkpoint, steering the CURRENT turn) or #202 (queue as a
 * new top-level request). A watcher's instruction is a new job — *"draft a reply
 * to John"* has nothing to do with whatever the user is asking about right now —
 * so it queues. #200's mid-run injection needs defined yield points inside the
 * run loop and is a separate change.
 *
 * Note the contrast with `src/inbox/`, which states that nothing queues and
 * "a queue protects a singleton — a notice contends for none of them". That is
 * still true of a notice. A turn contends for all three.
 *
 * ## What is deliberately NOT here: the `+ <request>` prefix
 *
 * #202's user-facing half needs the user to be able to TYPE while a turn runs,
 * and they cannot: `<Prompt disabled={busy}>` gates keystrokes, so the branch
 * would be unreachable. Enabling input mid-turn is not a one-line change either
 * — `Prompt.tsx` says outright that *"while a turn is busy the Prompt is
 * disabled and App owns Esc for interrupt"*, and Ink broadcasts to every
 * mounted handler with no stop-propagation, so an enabled prompt puts its own
 * Esc (clear the buffer) in competition with App's (abort the turn). Resolving
 * that ownership is #200/#202's real cost and belongs with them.
 *
 * The queue lands anyway because a wake needs it and has two producers that do
 * not require typing: a watcher firing, and `bernard say --run`. When the
 * prefix arrives it is a parser and a branch on top of this, not a rewrite.
 */

/** Where a queued turn came from, which decides how it is announced. */
export type QueuedTurnSource =
  /** The user typed `+ something` while busy. */
  | { kind: 'user' }
  /** A watcher fired. */
  | { kind: 'watcher'; watcherId: string; name: string; reason: string }
  /** A `bernard say --run` arrived from another process (#493). */
  | { kind: 'remote'; label: string };

export interface QueuedTurn {
  id: string;
  /** The instruction channel. Never contains anything observed. */
  text: string;
  /** The data channel, carried opaquely — see `watchers/wake.ts`. */
  data?: { readonly text: string };
  source: QueuedTurnSource;
  queuedAt: number;
}

/**
 * How many turns may wait.
 *
 * Bounded because the producers are not: a chatty watcher set, several `say
 * --run` senders, or a user holding down `+` all append here, and an unbounded
 * queue means a session that spends the next hour working through a backlog
 * nobody remembers asking for. Small, because a queue this deep is already a
 * sign something is wrong.
 */
export const MAX_QUEUED_TURNS = 10;

export type EnqueueResult =
  | { ok: true; position: number }
  | { ok: false; reason: 'full' };

/**
 * A plain FIFO. Deliberately not a React store: `App` holds it in a ref and
 * drains it from `runAgentTurn`'s `finally`, so nothing here needs to notify —
 * and a queue that triggered renders would repaint the transcript on every
 * background arrival.
 */
export class TurnQueue {
  private items: QueuedTurn[] = [];
  private seq = 0;

  enqueue(turn: Omit<QueuedTurn, 'id' | 'queuedAt'>, now = Date.now()): EnqueueResult {
    // Refuses the NEWEST rather than dropping the oldest, matching
    // `WorkQueue.enqueue`. Dropping the oldest silently discards something
    // already accepted and reported as queued; refusing tells the producer now,
    // while it still has the payload.
    if (this.items.length >= MAX_QUEUED_TURNS) return { ok: false, reason: 'full' };
    this.items.push({ ...turn, id: `q${++this.seq}`, queuedAt: now });
    return { ok: true, position: this.items.length };
  }

  /** Removes and returns the next turn, or `null`. */
  take(): QueuedTurn | null {
    return this.items.shift() ?? null;
  }

  peek(): readonly QueuedTurn[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  /** Drops everything. Returns how many went. */
  clear(): number {
    const n = this.items.length;
    this.items = [];
    return n;
  }

  /** Drops one by id. */
  remove(id: string): boolean {
    const i = this.items.findIndex((t) => t.id === id);
    if (i === -1) return false;
    this.items.splice(i, 1);
    return true;
  }
}

/** One line describing where a queued turn came from, for the panel. */
export function describeSource(source: QueuedTurnSource): string {
  switch (source.kind) {
    case 'user':
      return 'queued by you';
    case 'watcher':
      return `watcher "${source.name}" — ${source.reason}`;
    case 'remote':
      return `sent by ${source.label}`;
  }
}
