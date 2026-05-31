/**
 * Module-level seam connecting the framework's output channel to a live
 * consumer (the Ink message store in Phase C, but the interface is concrete
 * enough that anything implementing {@link OutputSink} can be plugged in).
 *
 * The seven `outputHook(prefix)` call sites across the agent definitions
 * (`main`, `sub`, `specialist`, `task`, `tool-wrapper`, the three PAC phases)
 * are static — threading a sink reference through every `AgentDefinition`
 * signature would touch every call site and every test that constructs an
 * `AgentContext`. A module-level slot keeps the seam narrow: callers that
 * want stream events register a sink at startup; callers that don't (the
 * legacy readline REPL, cron) leave the slot null and the framework falls
 * through to its existing stdout printers verbatim.
 *
 * Phase D consideration: when the readline REPL is deleted, the slot becomes
 * always-set under normal operation. It still falls back to null for cron and
 * for the few unit tests that import `outputHook` without mounting `<App>`.
 */

/** Per-step events the framework pushes to a registered sink. */
export type StreamEvent =
  | {
      kind: 'text-delta';
      /** Incremental text delta. May be a full step's text in the bulk path. */
      text: string;
      /** Sub-agent / wrapper prefix (e.g. `sub:2`). Undefined for the main agent. */
      agentLabel?: string;
    }
  | {
      kind: 'tool-call';
      callId: string;
      toolName: string;
      args: unknown;
      agentLabel?: string;
    }
  | {
      kind: 'tool-result';
      callId: string;
      result: unknown;
      isError: boolean;
      agentLabel?: string;
    };

/**
 * Minimal contract the framework needs from a consumer. The concrete
 * `MessageStore` under `src/ui/message-store.ts` adds React-specific
 * `subscribe` / `getSnapshot` on top, but the framework layer only sees this.
 */
export interface OutputSink {
  append(event: StreamEvent): void;
}

let activeSink: OutputSink | null = null;

/**
 * Register (or clear with `null`) the live output sink. `<App>` calls this
 * once in a mount-time `useEffect` and again with `null` on unmount.
 *
 * This is global by design — see the module-level comment. The expected
 * single-mounted-app pattern means only one consumer can be registered at a
 * time; calling `setOutputSink` while one is already active overwrites it
 * silently. Callers that need to compose sinks should do so on their side.
 */
export function setOutputSink(sink: OutputSink | null): void {
  activeSink = sink;
}

/**
 * Read the current sink. Returns `null` when no consumer is registered, in
 * which case `outputHook` falls through to its stdout printers. The legacy
 * readline REPL never calls `setOutputSink`, so its behavior is unchanged.
 */
export function getOutputSink(): OutputSink | null {
  return activeSink;
}
