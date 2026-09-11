/**
 * @module watchers/evaluate
 *
 * Given what a probe saw, did something happen?
 *
 * Pure, and the only module that decides a watcher fires. It imports the shape
 * and the two leaves beneath it and nothing else — no clock, no store, no I/O —
 * so every branch here is testable by passing two values.
 */
import { sha256Hex } from '../hash.js';
import { extractPath, idsAt, stableStringify } from './extract.js';
import type { WatchPredicate, Watcher } from './types.js';

/** What a probe managed to see. */
export interface Observation {
  /** The value the target returned, already unwrapped where that applies. */
  value: unknown;
  /** Validators worth carrying forward, for a conditional request next time. */
  etag?: string;
  lastModified?: string;
  /**
   * True when the transport itself said nothing changed — an HTTP `304`.
   *
   * A `304` is safe to act on because acting costs nothing. The inverse is NOT
   * true and is the classic mistake: a `200` is not proof of change, only proof
   * that the server did not feel like answering conditionally, so it still goes
   * through the digest below.
   */
  unchanged?: boolean;
}

/** What a watcher's state should become after a poll, and whether it woke. */
export interface Evaluation {
  fired: boolean;
  /** Why, in one line, for the wake panel and the log. Present only when fired. */
  reason?: string;
  /** Snapshot to persist for the next poll. */
  snapshot?: string;
  baselineIds?: string[];
  etag?: string;
  lastModified?: string;
}

/** The digest a `changed` comparison is made against. */
export function digestOf(value: unknown, extract?: string): string {
  const target = extract ? extractPath(value, extract) : value;
  return sha256Hex(stableStringify(target, { collapseWhitespace: true }));
}

/**
 * Evaluate one poll.
 *
 * The **baseline is taken at creation**, not on the first poll, and that is what
 * makes "tell me when this changes" mean what it says. Evaluated against an
 * absent snapshot a `changed` predicate would compare a real digest against
 * nothing and fire immediately — every watcher would wake the moment it was
 * created. So an absent snapshot here RECORDS and does not fire; `store.ts`
 * populates it at creation so that case is only ever reached by a hand-edited
 * record.
 */
export function evaluate(watcher: Watcher, obs: Observation): Evaluation {
  const carry = { etag: obs.etag, lastModified: obs.lastModified };

  // A `time` target has no value to compare — arriving here IS the event, since
  // `isDue` only lets it be polled at or after its instant.
  if (watcher.target.kind === 'time') {
    return { fired: true, reason: `scheduled time reached (${watcher.target.at})`, ...carry };
  }

  // The transport answered the question for us.
  if (obs.unchanged) {
    return { fired: false, snapshot: watcher.snapshot, baselineIds: watcher.baselineIds, ...carry };
  }

  return evaluatePredicate(watcher, watcher.predicate, obs, carry);
}

function evaluatePredicate(
  watcher: Watcher,
  predicate: WatchPredicate,
  obs: Observation,
  carry: { etag?: string; lastModified?: string },
): Evaluation {
  const extract = watcher.target.kind === 'mcp' ? watcher.target.extract : undefined;

  /**
   * "Nothing happened" — carry state forward and do not wake.
   *
   * Written out seven times before this, which is seven places to keep in step
   * and seven edits the day an eighth carried field appears.
   */
  const hold = (snapshot = watcher.snapshot, baselineIds = watcher.baselineIds): Evaluation => ({
    fired: false,
    snapshot,
    baselineIds,
    ...carry,
  });

  switch (predicate.kind) {
    case 'changed': {
      const next = digestOf(obs.value, extract);
      // No baseline means record-and-hold, not fire — see the docstring above.
      // Folded with the unchanged case because both returned a byte-identical
      // value, and two branches that cannot differ read as though they can.
      if (!watcher.snapshot || next === watcher.snapshot) return hold(next);
      return { fired: true, reason: 'content changed', snapshot: next, ...carry };
    }

    case 'appeared': {
      const ids = idsAt(obs.value, predicate.idPath);
      // Could not evaluate. Deliberately NOT treated as an empty list: an empty
      // baseline would make every pre-existing item look new on the next poll
      // and fire a false wake naming things that were always there.
      if (ids === null) return hold();
      const baseline = watcher.baselineIds ?? [];
      const known = new Set(baseline);
      const fresh = ids.filter((id) => !known.has(id));
      // Carry the CURRENT ids forward, not the original baseline: an item that
      // disappears must not be able to reappear and count as new.
      if (fresh.length === 0) return hold(watcher.snapshot, ids);
      return {
        fired: true,
        reason: fresh.length === 1 ? '1 new item' : `${fresh.length} new items`,
        snapshot: watcher.snapshot,
        baselineIds: ids,
        ...carry,
      };
    }

    case 'matches': {
      const target = extract ? extractPath(obs.value, extract) : obs.value;
      const text = typeof target === 'string' ? target : stableStringify(target);
      let re: RegExp;
      try {
        re = new RegExp(predicate.pattern);
      } catch {
        // An unparseable pattern is a broken watcher, not a match.
        return hold();
      }
      if (!re.test(text)) return hold();
      return { fired: true, reason: `matched /${predicate.pattern}/`, ...carry };
    }
  }
}
