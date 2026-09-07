import { debugLog } from '../../logger.js';
import type { AgentContext } from '../context.js';
import type { AgentDefinition } from './types.js';
import type { RAGSearchResult } from '../../rag.js';

/**
 * One retrieval path for every dispatch (#510).
 *
 * "What knowledge does this task need?" had six answers in six files, three of
 * them byte-near-identical copies of the same try/catch around
 * `ctx.rag.search(input.task)` — in `sub.ts`, `task.ts` and `specialist.ts`.
 * The fourth, `pac-actor.ts`, still logged its errors under **`'subagent:rag'`**,
 * which is the copy-paste showing through: the label was never changed.
 *
 * This is the refactor `resolveToolSurface` already performed for tools, and
 * `run.ts:146-153` states the reason in a form that transfers unchanged — a
 * cross-cutting entitlement re-decided per definition defaults to the permissive
 * answer and fails silently. Retrieval's version of that failure is quieter
 * still: a definition that simply forgot to search does not error, it answers
 * worse.
 *
 * ## What it does NOT do, and why
 *
 * **It does not enrich with `buildRAGQuery`.** That function's inputs are the
 * last two *user turns* and recent tool context, which a dispatch does not have:
 * `buildRAGQuery(task, [], {})` returns the task string. So the interactive
 * path's enrichment is a no-op here, and claiming a dispatch now gets "the
 * enriched query the REPL gets" would be false. What a dispatch DOES have and
 * was throwing away is `input.context` — the string the caller wrote precisely
 * to say what this task is about. That is the real gain, and it is strictly more
 * than the task alone.
 *
 * **It does not touch `main` or `cron`.** Both already supply `ragResults`
 * through `contextInputs`, and `getContextMessages` prefers what the definition
 * supplied. `main` retrieves in the `Agent` class, with `applyStickiness`,
 * `provenance.add` and `previousRAGFacts` — all main-only, and all invisible to
 * a runner-side search. `cron` retrieves in `headless.ts`, which deliberately
 * starts the search *before* `mcpManager.connect()` so the cold embedding load
 * overlaps a measured ~1.1-1.6 s connect; moving it here would serialise the two
 * for no gain.
 *
 * ## Once per dispatch, not once per iterate
 *
 * `contextInputs` is called inside `innerIterate` — once per LLM call — so a
 * multi-step dispatch re-searched on every step, saved only by
 * `RAGStore.turnSearchCache`, which no headless path ever clears. Resolving here,
 * beside `resolveToolSurface`, makes it once per dispatch. That is a real
 * behaviour change rather than a move, and it is the intended one.
 */

/** The shape a definition's input must have for its query to be built. */
export interface RetrievalInput {
  task?: string;
  context?: string;
}

/**
 * The query a dispatch retrieves for: its task, plus the context the caller
 * wrote alongside it.
 *
 * Exported so a definition declares `retrievalQuery: retrievalQueryFor` rather
 * than four copies of the same two-line join — the duplication this module
 * exists to end, reintroduced one level up.
 */
export function retrievalQueryFor(input: RetrievalInput): string | null {
  const task = input.task?.trim();
  if (!task) return null;
  const context = input.context?.trim();
  return context ? `${task}\n\n${context}` : task;
}

/**
 * Runs the dispatch's retrieval, or returns `undefined` when there is none.
 *
 * Fails soft, exactly as the four copies did: a RAG failure must not abort a
 * turn, and `undefined` renders no `<recalled_context>` rather than an empty
 * one.
 */
export async function resolveRetrieval<TInput>(
  ctx: AgentContext,
  def: Pick<AgentDefinition<TInput, unknown>, 'id' | 'retrievalQuery'>,
  input: TInput,
): Promise<RAGSearchResult[] | undefined> {
  if (!ctx.rag || !def.retrievalQuery) return undefined;
  const query = def.retrievalQuery(input);
  if (!query) return undefined;
  try {
    const results = await ctx.rag.search(query);
    if (results.length > 0) {
      debugLog('dispatch:rag', {
        definition: def.id,
        query: query.slice(0, 100),
        results: results.length,
      });
    }
    return results;
  } catch (err) {
    debugLog('dispatch:rag:error', {
      definition: def.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
