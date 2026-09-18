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
 * ## The `+ <request>` prefix, which this module used to record as absent
 *
 * It is here now (#202), and it really was "a parser and a branch on top of
 * this": the queue, the ordering, the drain loop and the per-turn lifecycle all
 * carried over untouched. What cost something was the input path — `<Prompt
 * disabled={busy}>` gated every keystroke, so the branch would have been
 * unreachable — and dropping `busy` from that expression puts the Prompt's own
 * Esc (dismiss the picker) against App's (abort the turn), which Ink cannot
 * arbitrate because it broadcasts every key to every mounted handler with no
 * stop-propagation.
 *
 * The resolution is App **declining** rather than Prompt consuming: `Prompt`
 * reports the boolean that IS its own Esc guard and App skips the abort while
 * it is set, so the first Esc dismisses and the second interrupts. See
 * `Prompt.tsx`'s `onEscapeGuardChange`.
 */

import type { UntrustedData } from '../framework/agents/user-message.js';
import type { ObservationSummary } from '../watchers/wake.js';

/** Where a queued turn came from, which decides how it is announced. */
export type QueuedTurnSource =
  /** A watcher fired. */
  | { kind: 'watcher'; watcherId: string; name: string; reason: string }
  /** A `bernard say --run` arrived from another process (#493). */
  | { kind: 'remote'; label: string }
  /** The user typed `+ <request>` while a turn was in flight (#202). */
  | { kind: 'user' };

export interface QueuedTurn {
  id: string;
  /** The instruction channel. Never contains anything observed. */
  text: string;
  /**
   * The data channel — see `watchers/wake.ts`.
   *
   * The branded type, not a structural `{ text: string }`. A structural widening
   * is exactly what #509's brand test declares must NOT satisfy `UntrustedData`,
   * and it forced an `as UntrustedData` at the drain — the escape hatch the brand
   * exists to make unnecessary, in the one path that actually carries a live
   * observation into a turn. Type-only import, so this leaf gains no runtime edge.
   */
  data?: UntrustedData;
  /**
   * What the TRANSCRIPT may say about {@link data} — never the payload.
   *
   * Beside `data` rather than on the `watcher` arm of {@link QueuedTurnSource},
   * because it abstracts the data CHANNEL: the `remote` arm would have to carry
   * a field it can never populate.
   */
  observation?: ObservationSummary;
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

/** Whether the turn was accepted. */
export type EnqueueResult = { ok: boolean };

/**
 * A plain FIFO — and deliberately NOT a coalescing one.
 *
 * Folding two wakes from one watcher into one entry is the obvious shape and it
 * fixes almost nothing: `drainNextTurn` calls `take()` before awaiting the
 * turn, so while a turn runs the queue is EMPTY and a repeat fire has no
 * sibling to fold into. That is the whole of the measured cascade. "One
 * outstanding wake per watcher" is a fact about the watcher's lifecycle, so it
 * lives in `App`'s `outstandingWakesRef`, which can see the in-flight window
 * this class cannot.
 *
 * Deliberately not a React store: `App` holds it in a ref and
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
    if (this.items.length >= MAX_QUEUED_TURNS) return { ok: false };
    this.items.push({ ...turn, id: `q${++this.seq}`, queuedAt: now });
    return { ok: true };
  }

  /** Removes and returns the next turn, or `null`. */
  take(): QueuedTurn | null {
    return this.items.shift() ?? null;
  }

  /**
   * Everything still waiting, oldest first — what `/queue` lists.
   *
   * A copy, so a caller holding the result across an `await` (every overlay
   * does) cannot watch the live array shift under it while the drain loop or a
   * watcher mutates it.
   */
  list(): readonly QueuedTurn[] {
    return [...this.items];
  }

  /**
   * Drops a waiting turn. `false` when the id names nothing — which is the
   * ordinary outcome of removing from a menu whose rows were read before the
   * previous turn finished, since the drain may have taken it in between.
   */
  remove(id: string): boolean {
    const i = this.items.findIndex((t) => t.id === id);
    if (i === -1) return false;
    this.items.splice(i, 1);
    return true;
  }

  get size(): number {
    return this.items.length;
  }
}

/** What the transcript panel says about a queued turn. */
export interface QueuedTurnAnnouncement {
  /**
   * The panel's title. Plain glyphs only — an emoji here makes the header row
   * a different width from every other row in the box and breaks the border
   * (see `glyph-width.ts`).
   */
  title: string;
  /** The dim meta beside it: where the turn came from. */
  origin: string;
}

/**
 * One table for the whole panel vocabulary, so a new source cannot be announced
 * under another one's words.
 *
 * It returns the title as well as the origin because the two are not
 * independent: "Woken" is true of a watcher and of a message from another
 * process, and false of a request the user queued themselves — so a source
 * supplying only the meta row would have rendered under a title contradicting
 * it. The switch has no `default` arm on purpose: a new {@link
 * QueuedTurnSource} is then a compile error here until it has been given
 * something to say.
 */
export function announcementFor(source: QueuedTurnSource): QueuedTurnAnnouncement {
  switch (source.kind) {
    case 'watcher':
      return { title: WOKEN_TITLE, origin: `watcher "${source.name}" — ${source.reason}` };
    case 'remote':
      return { title: WOKEN_TITLE, origin: `sent by ${source.label}` };
    case 'user':
      return { title: '◷ Queued', origin: 'by you, with `+`' };
  }
}

/**
 * Exported for `buildResumeSeed`, which rebuilds a wake panel from the
 * persisted message alone: the source object is gone by then, so without this
 * the title would be hand-written there — a second copy of a cell in the table
 * above, free to drift from it.
 */
export const WOKEN_TITLE = '◷ Woken';
