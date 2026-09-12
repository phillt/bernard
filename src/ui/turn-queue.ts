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

import type { UntrustedData } from '../framework/agents/user-message.js';

/** Where a queued turn came from, which decides how it is announced. */
export type QueuedTurnSource =
  /** A watcher fired. */
  | { kind: 'watcher'; watcherId: string; name: string; reason: string }
  /** A `bernard say --run` arrived from another process (#493). */
  | { kind: 'remote'; label: string };

export interface QueuedTurn {
  id: string;
  /** The instruction channel. Never contains anything observed. */
  text: string;
  /**
   * How many later fires were folded into this entry. Absent means one.
   *
   * Rendered, because the entry's `reason` describes only the NEWEST
   * observation — "2 new items" when three arrived across two fires would be a
   * true sentence about a poll and a false one about the conversation.
   */
  coalesced?: number;
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
 * The identity of "this is the same standing request, seen again".
 *
 * A watcher has one: its instruction is fixed at creation, so two fires from one
 * watcher are the same job with a newer observation. A `say --run` does NOT —
 * each is a distinct instruction a sender wrote and was told was delivered, and
 * folding two of those together silently drops work somebody asked for.
 */
function coalesceKey(source: QueuedTurnSource): string | null {
  return source.kind === 'watcher' ? `watcher:${source.watcherId}` : null;
}

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
    // A watcher that fires again while its own earlier wake is still waiting
    // SUPERSEDES it rather than queueing a second turn.
    //
    // This is the level-triggered design applied one layer up, not a new rule:
    // a watcher compares current state against a snapshot and never consumes a
    // stream, so the newest observation IS the truth and an older one queued
    // behind it describes a conversation that has already moved. Measured on a
    // real session, without it a live chat produced five consecutive full turns
    // from one watcher over six minutes — 800-character instruction, ~900k
    // prompt tokens apiece — each reacting to a message the previous turn had
    // already read and answered.
    //
    // It keeps its PLACE in line, and that is deliberate: the position was
    // earned when the watcher first fired, and sending it to the back on every
    // supersede lets a chatty watcher starve itself behind turns that arrived
    // later. `queuedAt` stays the original for the same reason — the question
    // it answers is "how long has this been waiting".
    //
    // The honest limit, which is the feature's own: anything that scrolled out
    // of the target's result between the two polls is gone, exactly as
    // `watchers/types.ts` records for a genuinely transient event.
    const key = coalesceKey(turn.source);
    if (key !== null) {
      const prior = this.items.find((q) => coalesceKey(q.source) === key);
      if (prior) {
        Object.assign(prior, turn, { coalesced: (prior.coalesced ?? 1) + 1 });
        return { ok: true };
      }
    }
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

  get size(): number {
    return this.items.length;
  }
}

/**
 * One line describing where a queued turn came from, for the panel.
 *
 * `coalesced` is named rather than hidden: the `reason` describes the newest
 * poll only, so a folded entry that said just "2 new items" would understate
 * what the turn is about to read — and a user watching one wake answer three
 * fires should be able to see that is what happened.
 */
export function describeSource(source: QueuedTurnSource, coalesced?: number): string {
  const folded = coalesced !== undefined && coalesced > 1 ? ` (latest of ${coalesced} fires)` : '';
  switch (source.kind) {
    case 'watcher':
      return `watcher "${source.name}" — ${source.reason}${folded}`;
    case 'remote':
      return `sent by ${source.label}`;
  }
}
