/**
 * @module watchers/active-count
 *
 * How many watchers this session is polling, for the status bar.
 *
 * A module-level counter, the shape `providers/request-counter.ts` already
 * uses, because the consumer and the producer must not know about each other:
 * `StatusBar` polls a plain value every 500 ms and re-renders only when its
 * serialized snapshot changes (#232), and `WatcherPoller` is a plain class with
 * no React. A subscription would give the poller an edge to the UI, and reading
 * the store from `StatusBar` would mean a `readdir` twice a second forever.
 *
 * Deliberately a count and not the records: the bar has one line and a reader
 * wants to know *that* something is watching, not what. `/watchers` answers the
 * second question.
 */
let activeCount = 0;

/** Set by the poller each tick. */
export function setActiveWatcherCount(n: number): void {
  activeCount = n;
}

export function getActiveWatcherCount(): number {
  return activeCount;
}

/**
 * Reset to zero.
 *
 * Called from `WatcherPoller.stop`, so an unmounted session does not leave the
 * bar claiming to watch something nothing is polling — the exact "reads as
 * active and will never fire" state the adoption path exists to remove, in the
 * one place a user would actually see it.
 */
export function resetActiveWatcherCount(): void {
  activeCount = 0;
}
