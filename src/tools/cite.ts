import { tool } from 'ai';
import { z } from 'zod';
import { attachMeta } from '../framework/tools/adapter.js';
import type { ProvenanceStore } from '../provenance.js';
import { locateQuote, sourceBody } from '../claim-verifier.js';

/**
 * Creates the `cite` tool. Lets the agent inspect the per-turn ProvenanceStore
 * — either list the registered sources (`action: 'list'`) or fetch full
 * details for a specific id (`action: 'get'`). The agent uses this when it
 * needs to verify a citation before attaching a `[^Sn]` marker. Issue #173.
 */
/**
 * `locate` — where a quoted span sits, and the passage around it.
 *
 * Extracted from `execute` rather than left inline: it is longer than the other
 * two actions combined and has its own shape (candidate narrowing, two failure
 * envelopes, a context window), so `execute` reads as three dispatches instead
 * of one branch and a function.
 */
function citeLocate(provenance: ProvenanceStore, quote?: string, id?: string): string {
  if (!quote) return JSON.stringify({ error: 'quote is required when action is "locate".' });
  // Narrowed to one source when asked, otherwise every registered one — first
  // match wins, which is stable and needs no rule about which source is
  // "better".
  const one = id ? provenance.get(id) : undefined;
  const candidates = one ? [one] : id ? [] : provenance.list();
  if (candidates.length === 0) {
    return JSON.stringify({
      found: false,
      reason: id ? `No source registered with id "${id}".` : 'No sources registered yet.',
    });
  }
  const hit = locateQuote(quote, candidates);
  if (!hit) {
    return JSON.stringify({
      found: false,
      searched: candidates.map((s) => s.id),
      // The distinction that matters: only two of the seven producers retain
      // the full text, so for the rest "not found" can mean "not found in the
      // first 2,000 characters".
      partial: candidates.filter((s) => s.verifyText === undefined).map((s) => s.id),
    });
  }
  // Already in hand — the predecessor re-fetched it from the store behind a
  // non-null assertion.
  const source = candidates.find((s) => s.id === hit.sourceId)!;
  // `sourceBody` rather than a fourth copy of `verifyText ?? contentPreview`:
  // the offsets below were computed against whatever THAT returns, so a second
  // spelling would slice a different string than the one they index.
  const body = sourceBody(source);
  const from = Math.max(0, hit.start - LOCATE_CONTEXT_CHARS);
  const to = Math.min(body.length, hit.end + LOCATE_CONTEXT_CHARS);
  return JSON.stringify({
    found: true,
    sourceId: hit.sourceId,
    rawRef: source.rawRef,
    start: hit.start,
    end: hit.end,
    matchedText: hit.matchedText,
    fromPreview: hit.fromPreview,
    // A bounded window, never the whole retained text: withholding that is the
    // entire point of the field, and `get` strips it for the same reason. The
    // model already saw this text when the tool ran.
    context: `${from > 0 ? '…' : ''}${body.slice(from, to)}${to < body.length ? '…' : ''}`,
  });
}

/** Characters either side of a located span. Enough to read, far under the cap. */
const LOCATE_CONTEXT_CHARS = 400;

export function createCiteTool(provenance: ProvenanceStore) {
  return attachMeta(
    tool({
      description:
        'Inspect the citation sources collected during this turn. action="list" returns every registered source (id, kind, label, preview); action="get" with an id returns the full details including the rawRef (URL, file path, memory key); action="locate" with a quote finds exactly where that text sits in a source and returns the surrounding passage. Use this before attaching a [^Sn] citation marker if you want to verify the source actually says what you are about to claim.',
      parameters: z.object({
        action: z
          .enum(['list', 'get', 'locate'])
          .describe(
            'list — enumerate sources; get — fetch one; locate — find a quoted span in a source',
          ),
        id: z.string().optional().describe('Source id (e.g. "S1") — required when action is "get"'),
        quote: z
          .string()
          .optional()
          .describe(
            'Exact text to locate, copied from the source. Required when action is "locate".',
          ),
      }),
      execute: async ({ action, id, quote }): Promise<string> => {
        if (action === 'list') {
          const items = provenance.list();
          if (items.length === 0) {
            return JSON.stringify({ sources: [], note: 'No sources have been registered yet.' });
          }
          return JSON.stringify({
            sources: items.map((s) => ({
              id: s.id,
              kind: s.kind,
              label: s.label,
              preview: s.contentPreview,
            })),
          });
        }
        if (action === 'locate') {
          return citeLocate(provenance, quote, id);
        }

        if (!id) {
          return JSON.stringify({ error: 'id is required when action is "get".' });
        }
        const item = provenance.get(id);
        if (!item) {
          return JSON.stringify({ error: `No source registered with id "${id}".` });
        }
        // `verifyText` is deliberately withheld. It exists so a quote can be
        // checked against the full page WITHOUT paying to put that page in the
        // model's context; returning it here would defeat exactly that. The
        // model already saw this text when the tool ran.
        const { verifyText: _verifyText, ...source } = item;
        return JSON.stringify({ source });
      },
    }),
    {
      name: 'cite',
      kind: 'read',
      deterministic: true,
      sideEffect: 'none',
      cacheable: false,
    },
  );
}
