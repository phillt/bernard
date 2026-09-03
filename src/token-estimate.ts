import type { CoreMessage } from 'ai';
import { estimateContentPartTokens } from './image.js';
import { findModelMetaByName, normalizeModelId } from './providers/catalog.js';

/**
 * Token estimation and context-window resolution, as a leaf.
 *
 * Split out of `src/context.ts` (#451) so `src/framework/agents/run.ts` can ask
 * how large a model's window is without importing that module — which reaches
 * `generateText`, `config`, `model-policy`, `rag`, `domains` and `image` for a
 * question whose only real dependency is the model catalog. The same edge
 * `tool-bytes.ts` and `mcp-names.ts` exist to refuse.
 *
 * `context.ts` re-exports everything here, so every existing importer is
 * unaffected and there is still one name for each of these.
 */

/**
 * Context windows where the upstream catalog is WRONG, verified against the
 * provider's own console. Consulted BEFORE the catalog — unlike
 * {@link MODEL_CONTEXT_WINDOWS}, which is a fallback for models the catalog
 * simply lacks.
 *
 * Keep this near-empty and justify every row, because a stale override is worse
 * than no override. An entry earns its place only when the catalog's value is
 * wrong in the UNSAFE direction (too large): over-estimating the window makes
 * compaction fire past the real ceiling, so instead of degrading gracefully the
 * turn dies on a provider context-length error.
 *
 * That invariant is ENFORCED, not just documented: an override applies only when
 * it is smaller than the catalog's value. The sibling table below records how a
 * hand-maintained copy goes stale (`refresh-catalog` does not touch it), and this
 * one is worse in that respect because it outranks the catalog. Clamping to the
 * lower value means a stale row can only ever be conservative, and the moment
 * upstream publishes the correct window the row becomes a harmless no-op instead
 * of pinning a wrong number forever.
 */
export const MODEL_CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
  // Keys are pre-normalized (see {@link normalizeModelId}: dots folded to
  // dashes) so the lookup is a plain O(1) index rather than a scan.
  //
  // The Vercel AI Gateway reports 2M for the grok-4.20 family; the SpaceXAI
  // console reports 1M for every one of them (checked 2026-08-22). Trusting the
  // gateway's 2M puts the compression threshold at 1.5M and `emergencyTruncate`
  // at 1.8M, both above the real limit.
  'grok-4-20-reasoning': 1_000_000,
  'grok-4-20-non-reasoning': 1_000_000,
  'grok-4-20-multi-agent': 1_000_000,
  'grok-4-20-reasoning-beta': 1_000_000,
  'grok-4-20-non-reasoning-beta': 1_000_000,
  'grok-4-20-multi-agent-beta': 1_000_000,
};

/**
 * Context windows for models the model catalog does NOT carry — retired gateway
 * ids that still appear in saved lineups and configs.
 *
 * Deliberately tiny. {@link getContextWindow} consults the catalog first, and
 * the catalog always resolves to at least the vendored snapshot
 * (`src/data/model-catalog-fallback.json`), which ships offline with every
 * build. So an entry here for anything the snapshot already covers is
 * unreachable — and worse, it is a hand-maintained copy that `npm run
 * refresh-catalog` does not update, which is how `claude-sonnet-4-5` came to be
 * listed at 200k while the catalog said 1M. Add a row ONLY for a model the
 * gateway has dropped.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5.2-chat-latest': 128_000,
  'grok-4-fast-reasoning': 2_000_000,
  'grok-4-fast-non-reasoning': 2_000_000,
  'grok-4-0709': 256_000,
  'grok-code-fast-1': 256_000,
  'grok-3': 131_072,
  'grok-3-mini': 131_072,
};

/** Fallback context window size (in tokens) for models not listed in MODEL_CONTEXT_WINDOWS. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Fraction of the context window at which history compression is triggered. */
export const COMPRESSION_THRESHOLD = 0.75;
/** Number of recent user/assistant exchanges preserved verbatim during compression. */
export const RECENT_TURNS_TO_KEEP = 4;
/**
 * Minimum estimated tokens in the compressible region for a compaction to be
 * worth its two LLM calls (#310). Below this the summary that replaces the
 * region is a meaningful fraction of the region itself, so the run costs money
 * and latency to recover approximately nothing.
 */
export const MIN_COMPRESSION_RECLAIM_TOKENS = 2_000;

/**
 * Look up a model's context window. Resolution order, most to least trusted:
 * explicit user override -> {@link MODEL_CONTEXT_WINDOW_OVERRIDES} (catalog is
 * known-wrong) -> the model catalog -> {@link MODEL_CONTEXT_WINDOWS} (catalog
 * lacks the model) -> {@link DEFAULT_CONTEXT_WINDOW}. Every id-based step
 * matches through {@link normalizeModelId}, so dotted/dashed/dated spellings of
 * the same model resolve alike.
 */
export function getContextWindow(model: string, override?: number): number {
  if (override && override > 0) return override;
  const key = normalizeModelId(model);
  const corrected = MODEL_CONTEXT_WINDOW_OVERRIDES[key];
  const meta = findModelMetaByName(model);
  const catalogWindow = meta && meta.contextWindow > 0 ? meta.contextWindow : undefined;
  // Corrections only ever shrink: see MODEL_CONTEXT_WINDOW_OVERRIDES.
  if (corrected !== undefined) {
    return catalogWindow !== undefined ? Math.min(corrected, catalogWindow) : corrected;
  }
  if (catalogWindow !== undefined) return catalogWindow;
  // Match the table through the same normalization the catalog lookup uses, so
  // a dotted/dated id doesn't miss both sources over punctuation alone.
  const fallback = Object.entries(MODEL_CONTEXT_WINDOWS).find(
    ([id]) => normalizeModelId(id) === key,
  );
  return fallback?.[1] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Rough token count for one message.
 *
 * 3.6 chars/token, deliberately NOT the 4 that `estimatePrefixTokens` uses —
 * that asymmetry predates this split and moving either number would shift
 * every truncation threshold at once.
 *
 * Lifted out of `context.ts`'s private scope (#451) so the dispatch-side seed
 * check and the main agent's history check are the same arithmetic rather than
 * two implementations that agree today.
 */
export function estimateMessageTokens(msg: CoreMessage): number {
  if (typeof msg.content === 'string') {
    return Math.ceil(msg.content.length / 3.6);
  }
  if (Array.isArray(msg.content)) {
    let tokens = 0;
    for (const part of msg.content) {
      tokens += estimateContentPartTokens(part);
    }
    return tokens;
  }
  return Math.ceil(JSON.stringify(msg.content).length / 3.6);
}

/** Sum of {@link estimateMessageTokens} over a message list. */
export function estimateMessagesTokens(messages: CoreMessage[]): number {
  let tokens = 0;
  for (const msg of messages) tokens += estimateMessageTokens(msg);
  return tokens;
}
