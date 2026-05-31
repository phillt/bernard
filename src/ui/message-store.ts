import type { OutputSink, StreamEvent } from '../framework/hooks/output-sink.js';

export type { StreamEvent } from '../framework/hooks/output-sink.js';

/**
 * Per-turn event log consumed by `<StreamingAssistantMessage>` via
 * `useSyncExternalStore`. Phase C (#214) seam between the framework's
 * streaming output (`runner.ts` deltas + `outputHook` step events) and the
 * Ink renderer.
 *
 * Lifecycle:
 *   - `<App>` constructs one store at mount, holds it in a `useRef`, and
 *     registers it via `setOutputSink(store)`.
 *   - At the start of every turn (`handleSubmit` before `agent.processInput`)
 *     the store calls `reset()` so the in-flight `<StreamingAssistantMessage>`
 *     renders only the current turn's events.
 *   - On turn end, the existing `historyVersion` bump moves the now-complete
 *     assistant message into the static-history `<Thread>` view; the
 *     streaming component unmounts. The store's events stay in place until
 *     the next `reset()` so any late deltas land on the now-unmounted
 *     consumer without crashing.
 *
 * Snapshot identity: every `append` constructs a new array, so React's
 * `useSyncExternalStore` equality check correctly detects the change. The
 * store is a plain class (no React imports) so the framework layer's
 * `OutputSink` contract is the only seam — `src/ui/` depends on the
 * framework, never the other way around.
 */
export class MessageStore implements OutputSink {
  private events: readonly StreamEvent[] = [];
  private readonly listeners = new Set<() => void>();
  // Bound so consumers can destructure `{ subscribe, getSnapshot }` from the
  // store without losing `this`. `useSyncExternalStore` calls them as free
  // functions, so the arrow form is required.
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): readonly StreamEvent[] => this.events;

  append(event: StreamEvent): void {
    this.events = [...this.events, event];
    for (const listener of this.listeners) listener();
  }

  /**
   * Drop accumulated events. Called by `<App>` at the start of every turn so
   * the in-flight `<StreamingAssistantMessage>` only renders the current
   * turn's deltas. Notifies subscribers so any still-mounted consumer
   * re-renders with the empty snapshot.
   */
  reset(): void {
    if (this.events.length === 0) return;
    this.events = [];
    for (const listener of this.listeners) listener();
  }
}
