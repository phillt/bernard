import { tool } from 'ai';
import { z } from 'zod';
import { attachMeta } from '../framework/tools/adapter.js';
import type { ProvenanceStore } from '../provenance.js';

/**
 * Creates the `cite` tool. Lets the agent inspect the per-turn ProvenanceStore
 * — either list the registered sources (`action: 'list'`) or fetch full
 * details for a specific id (`action: 'get'`). The agent uses this when it
 * needs to verify a citation before attaching a `[^Sn]` marker. Issue #173.
 */
export function createCiteTool(provenance: ProvenanceStore) {
  return attachMeta(
    tool({
      description:
        'Inspect the citation sources collected during this turn. action="list" returns every registered source (id, kind, label, preview); action="get" with an id returns the full details including the rawRef (URL, file path, memory key). Use this before attaching a [^Sn] citation marker if you want to verify the source matches the claim.',
      parameters: z.object({
        action: z.enum(['list', 'get']).describe('list — enumerate sources; get — fetch one'),
        id: z.string().optional().describe('Source id (e.g. "S1") — required when action is "get"'),
      }),
      execute: async ({ action, id }): Promise<string> => {
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
