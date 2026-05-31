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
    // Coalesce consecutive text-delta events for the same agentLabel into a
    // single entry. Without this the main agent's streamText loop appends one
    // event per token — a 4 000-token response would build a 4 000-element
    // array via O(n) spread per token (O(n²) total) and force the renderer to
    // walk the full list on every snapshot. Coalescing keeps the event count
    // bounded by the number of tool boundaries instead of token count.
    if (event.kind === 'text-delta' && this.events.length > 0) {
      const tail = this.events[this.events.length - 1];
      if (tail.kind === 'text-delta' && tail.agentLabel === event.agentLabel) {
        const merged: StreamEvent = {
          ...tail,
          text: tail.text + event.text,
        };
        this.events = [...this.events.slice(0, -1), merged];
        for (const listener of this.listeners) listener();
        return;
      }
    }
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
