import type { Agent } from '../agent.js';
import type { HistoryStore } from '../history.js';
import type { ProvenanceHistoryStore } from '../provenance-history.js';
import type { TurnContextStore } from '../turn-context.js';

/**
 * Persists the agent's current conversation and per-turn provenance to disk.
 *
 * Mirrors the legacy REPL's `persistAgentState()` helper, but takes its inputs
 * as a typed argument bag so `<App>` can call it without depending on
 * `src/repl.ts`. Phase D will delete the duplicate in `src/repl.ts` when the
 * legacy REPL is removed; until then the two copies do not interact because
 * the Ink path is not user-mounted.
 *
 * Failures are swallowed and logged — a save error must never crash the REPL
 * mid-turn (the legacy helper has the same contract).
 */
export function persistAgentState(args: {
  agent: Agent;
  historyStore: HistoryStore;
  provenanceHistoryStore: ProvenanceHistoryStore;
  turnContextStore?: TurnContextStore;
}): void {
  const { agent, historyStore, provenanceHistoryStore, turnContextStore } = args;
  try {
    historyStore.save(agent.getHistory());
  } catch (err) {
    console.error('Failed to save conversation history:', err);
  }
  try {
    provenanceHistoryStore.save(agent.getTurnProvenance());
  } catch (err) {
    console.error('Failed to save provenance history:', err);
  }
  try {
    turnContextStore?.save(agent.getTurnContext());
  } catch (err) {
    console.error('Failed to save turn context history:', err);
  }
  // Dispatch-context records are deliberately NOT saved here. This runs in
  // every turn's `finally`, on the Ink render path, and `PerTurnStore.save`
  // pretty-prints and rewrites the whole array — 0.65 ms and 354 KB at the
  // record bound, per turn, for a diagnostics record nothing reads until the
  // session ends. `index.ts`'s cleanup flushes it once (#512).
}
