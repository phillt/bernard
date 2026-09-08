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

/**
 * A dispatch's retrieval query is bounded, and the bound is stated here.
 *
 * The interactive path bounds its query at `DEFAULT_MAX_QUERY_CHARS` inside
 * `buildRAGQuery`; the dispatch paths never did — `sub.ts` called
 * `ctx.rag.search(input.task)` raw, and `RAGStore.embedQuery` applies no bound
 * of its own. So this is not a bound being discarded, it is one that was never
 * there, and appending `input.context` is the change that makes its absence
 * matter: `subagent.ts` declares `context: z.string().optional()` with no
 * `.max()`, so a caller can hand over an arbitrarily long string.
 *
 * The literal is local rather than imported. `rag-query.ts` reaches `context.ts`
 * — the edge `token-estimate.ts` exists to refuse — so the repo's own answer is
 * a local constant pinned by a test against the real one, exactly as
 * `docs-store.ts`'s `MAX_DOC_CHARS` is pinned.
 */
export const MAX_RETRIEVAL_QUERY_CHARS = 1000;

/**
 * The query a dispatch retrieves for: its task, plus the context the caller
 * wrote alongside it.
 *
 * **Task first, and it is never the part that gets cut.** The embedder
 * truncates at 256 word pieces regardless of what is sent, so the priority
 * order decides what survives — the same reason `buildRAGQuery` puts current
 * input last for a model that attends to later tokens, applied to a truncation
 * boundary instead. Context is supporting detail; a task cut in half retrieves
 * for a different question.
 *
 * Not `renderTaskText` (`user-message.ts`), which joins the same two fields as
 * `Task: …\n\nContext: …`. Those labels are prompt scaffolding and would be
 * embedded as content here; this also trims and returns `null` for an empty
 * task. Recorded because a future consolidation onto the shared renderer is the
 * obvious-looking move and would silently put prompt labels into every
 * dispatch's embedding query.
 *
 * Exported so a definition declares `retrievalQuery: retrievalQueryFor` rather
 * than four copies of the same join. It is a function rather than a `retrieves:
 * true` flag so the input shape stays checked per definition — a flag would
 * move `task`/`context` knowledge into the runner and silently start retrieval
 * for `tool-wrapper`, `pac-planner`, `pac-critic` and `mcp-delegate`, whose
 * inputs all match that shape. `pac-critic`'s opt-out would be defeated by the
 * mechanism meant to unify.
 */
export function retrievalQueryFor(input: { task?: string; context?: string }): string | null {
  const task = input.task?.trim();
  if (!task) return null;
  const head = task.slice(0, MAX_RETRIEVAL_QUERY_CHARS);
  const context = input.context?.trim();
  const room = MAX_RETRIEVAL_QUERY_CHARS - head.length - 2;
  if (!context || room <= 0) return head;
  return `${head}\n\n${context.slice(0, room)}`;
}

/**
 * What one dispatch retrieved, and what it retrieved FOR.
 *
 * Both, from the one function that owns the decision (#512). The recorder used
 * to call `def.retrievalQuery(input)` a second time to capture the string —
 * running a definition-supplied thunk twice per dispatch, outside this
 * function's guards, so the record claimed a `retrievalQuery` for dispatches
 * that retrieved nothing (no `ctx.rag`, or a search that threw). A re-derived
 * measure drifting from the real one is exactly the class `recall-filter` was
 * just fixed for, and it does not belong in the module whose whole job is to be
 * a trustworthy record of what happened.
 */
export interface Retrieval {
  /** The query, present only when a search actually ran. */
  query?: string;
  results?: RAGSearchResult[];
}

/**
 * Runs the dispatch's retrieval, or returns an empty result when there is none.
 *
 * Fails soft, exactly as the four copies did: a RAG failure must not abort a
 * turn, and `undefined` renders no `<recalled_context>` rather than an empty
 * one.
 */
export async function resolveRetrieval<TInput>(
  ctx: AgentContext,
  def: Pick<AgentDefinition<TInput, unknown>, 'id' | 'retrievalQuery'>,
  input: TInput,
): Promise<Retrieval> {
  if (!ctx.rag || !def.retrievalQuery) return {};
  const query = def.retrievalQuery(input);
  if (!query) return {};
  try {
    const results = await ctx.rag.search(query);
    if (results.length > 0) {
      debugLog('dispatch:rag', {
        definition: def.id,
        query: query.slice(0, 100),
        results: results.length,
      });
    }
    return { query, results };
  } catch (err) {
    debugLog('dispatch:rag:error', {
      definition: def.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}
