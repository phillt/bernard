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
import { extractPath, idPathRefusal, idsAt, stableStringify } from './extract.js';
import type { WatchPredicate, WatchState, Watcher } from './types.js';

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

/**
 * What a watcher's state should become after a poll, and whether it woke.
 *
 * The carried half is {@link WatchState}, shared with the baseline capture and
 * with the store — so "what a poll persists" is one list in one place rather
 * than four fields restated wherever they are copied.
 */
export interface Evaluation extends WatchState {
  fired: boolean;
  /**
   * Why the predicate could not be evaluated at all — an `idPath` that names no
   * list, or a pattern that will not compile. Absent when it could.
   *
   * Distinct from `fired: false`, and the distinction is the whole point: "I
   * looked and nothing had changed" and "I cannot read this" are the same value
   * without it, so a watcher pointed at a path that can never match polls
   * successfully forever and reports nothing. Three real watchers sat in that
   * state for an hour.
   *
   * It carries the REASON rather than a boolean because the reason is knowable
   * only here — this is the one place holding both the predicate and the payload
   * it failed against. As a boolean the poller had to re-derive a message from
   * the predicate alone, which it did by writing `probe.ts`'s sentence out a
   * second time and dropping the suggestions, i.e. the half that makes the
   * failure fixable.
   */
  unreadable?: string;
  /** Why, in one line, for the wake panel and the log. Present only when fired. */
  reason?: string;
}

/**
 * How much of an observation a `matches` predicate sees.
 *
 * Deliberately far below `MAX_HTTP_BODY_CHARS`: a pattern that needs more than
 * 4 KB of context is not the shape this predicate is for, and the cap is what
 * keeps a pathological pattern from holding the poll loop.
 */
export const MATCH_INPUT_MAX = 4_000;

/**
 * The digest a `changed` comparison is made against.
 *
 * Deliberately UNBOUNDED, and it must stay that way however tempting symmetry
 * with `matches` below looks: a digest over a bounded prefix makes every change
 * past that prefix invisible, so a `changed` watcher would poll cleanly forever
 * and never fire — the silent inertness this whole module is built to refuse.
 * What bounds this path is the probe's own ceiling
 * ({@link MAX_PROBE_RESULT_CHARS}), which refuses a payload rather than
 * shortening one. A test pins it.
 */
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
      const ids = idsAt(obs.value, predicate.idPath, predicate.where);
      // Could not evaluate. Deliberately NOT treated as an empty list: an empty
      // baseline would make every pre-existing item look new on the next poll
      // and fire a false wake naming things that were always there.
      // Not `hold()`: an unreadable path is not "nothing happened", and
      // reporting it as such is how a watcher becomes permanently inert while
      // looking healthy.
      if (ids === null)
        return { ...hold(), unreadable: idPathRefusal(predicate.idPath, obs.value) };
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
      // The budget goes INTO the serialiser rather than onto its output. The
      // previous form built the whole string and then kept 4 KB of it —
      // measured 61 ms for a 12 MB payload, to throw away 99.97% of the work —
      // which is exactly what `renderObservation` was fixed for. `maxChars`
      // preserves the prefix byte for byte, so no live `matches` watcher
      // changes verdict; `boundedStringify` would NOT, because it does not sort
      // keys. See `stableStringify`.
      const full =
        typeof target === 'string'
          ? target
          : stableStringify(target, { maxChars: MATCH_INPUT_MAX });
      // Bounded before it reaches the pattern. Both sides here are hostile-ish:
      // the pattern is model-authored free text and the input is whatever a
      // server returned — up to `MAX_HTTP_BODY_CHARS` on the http path and
      // `MAX_PROBE_RESULT_CHARS` on the mcp one — so a catastrophically
      // backtracking pattern would wedge the poll loop, and the poller is not
      // tied to `turnAbortRef`, so Esc does not reach it. The `try` below covers
      // a syntax error, which is a different failure.
      //
      // A cap is not a cure for backtracking, and is not claimed as one: it
      // bounds the blast radius to something a person will wait through. The
      // real fix is a matcher with a time budget, which Node has no primitive for.
      const text = full.length > MATCH_INPUT_MAX ? full.slice(0, MATCH_INPUT_MAX) : full;
      let re: RegExp;
      try {
        re = new RegExp(predicate.pattern);
      } catch (err) {
        // An unparseable pattern is a broken watcher, not a match — and naming
        // the syntax error is the difference between a model fixing the pattern
        // and retrying the same one.
        return {
          ...hold(),
          unreadable:
            `Pattern /${predicate.pattern}/ is not a valid regular expression: ` +
            (err instanceof Error ? err.message : String(err)),
        };
      }
      if (!re.test(text)) return hold();
      return { fired: true, reason: `matched /${predicate.pattern}/`, ...carry };
    }
  }
}
