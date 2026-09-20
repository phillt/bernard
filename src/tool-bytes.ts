import { zodSchema } from 'ai';
import type { Tool } from './framework/sdk.js';

/**
 * Wire size of a dispatch's tool block, in characters (#253).
 *
 * Sums `name + description + JSON Schema` per tool — what a provider actually
 * receives. Zod parameters are converted with the AI SDK's own `zodSchema()`
 * (the same path `generateText` takes), so a Zod built-in and a JSON-Schema MCP
 * tool are measured on the same scale; `JSON.stringify` on a raw Zod object
 * would under-report built-ins by roughly half and make cross-dispatch
 * comparisons meaningless — the exact thing this metric exists to enable.
 *
 * ## Why its own module
 *
 * It began private and debug-gated inside `framework/runner.ts`, where it could
 * never be anything but a log line while `emergencyTruncate` budgeted as though
 * tools cost nothing (#323). The obvious home was `context.ts`, which owns "how
 * big is what we're about to send" — but that would make the generic runner
 * import `context.ts`, dragging in `config`, `model-policy` → `lineups` →
 * `providers`, `rag`, `domains` and `generateText` for a pure measurement whose
 * only real dependency is `ai`. That is the same edge #315 refused when it kept
 * the delegation surface from depending on the agent runner.
 *
 * So: a leaf module both layers can import. `context.ts` does not import it at
 * all — `emergencyTruncate` takes a number, not a tool registry.
 *
 * Converting every schema is O(schema size), so the CALLER decides when to pay:
 * the runner calls it only under `BERNARD_DEBUG`, and the agent calls it once
 * per session (the main tool block is session-stable — the invariant the prompt
 * cache already depends on). Never throws into the dispatch path.
 */
export function toolBlockBytes(tools: Record<string, Tool> | undefined): number {
  if (!tools) return 0;
  let total = 0;
  for (const [name, t] of Object.entries(tools)) {
    total += name.length;
    // Read the SDK's `Tool` fields DIRECTLY rather than through a structural
    // cast. The predecessor was `t as {description?: unknown; parameters?:
    // unknown}`, and the optional `parameters?` is what made this boundary
    // blind: rename the field upstream and the cast still compiles, `p` is
    // `undefined`, `zodSchema(undefined)` throws into the catch below, and
    // every tool contributes its name and description only. The number then
    // under-reports by roughly an order of magnitude — and it is
    // `emergencyTruncate`'s budget, so the failure is the exact one (#323)
    // built this module to fix, silently restored. Unannotated, a rename is a
    // compile error here instead.
    if (t.description !== undefined) total += t.description.length;
    try {
      const p = t.parameters;
      // MCP tools arrive pre-wrapped by `jsonSchema()` and already expose
      // `.jsonSchema`; Zod schemas need converting first.
      const resolved = 'jsonSchema' in p ? p.jsonSchema : zodSchema(p).jsonSchema;
      total += JSON.stringify(resolved ?? {}).length;
    } catch {
      // Unconvertible or circular schema — skip this tool's parameters rather
      // than fail the dispatch. Undercounts; never crashes.
    }
  }
  return total;
}
