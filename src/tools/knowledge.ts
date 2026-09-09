import { tool } from 'ai';
import { z } from 'zod';
import { attachMeta } from '../framework/tools/adapter.js';
import { getEmbeddingProvider } from '../embeddings.js';
import type { KnowledgeCorpus } from '../knowledge/corpus.js';
import { searchCorpus } from '../knowledge/search.js';
import { readSource } from '../knowledge/manage.js';

/**
 * `knowledge` — read the user's ingested document libraries (#516).
 *
 * ## Three read actions, and deliberately no `add`
 *
 * `app-cli.ts`'s rule applied: there is a half of this a model may not do.
 * Ingestion reads arbitrary local paths and arbitrary URLs and writes durable
 * state that later searches return — so an agent-callable ingest is an
 * arbitrary-file-read primitive laundered through a store: read a file the
 * write-scope gate would have refused, then "search" for it. Ingestion is a
 * user act, at the CLI. A gated agent-side ingest is a reasonable follow-up
 * once someone has decided what write scope it runs under; leaving it out is a
 * decision rather than an oversight, which is why the description says so.
 *
 * ## Not `deterministic`, unlike `docs`
 *
 * Result-cache eligibility is `deterministic && sideEffect === 'none'`, with a
 * five-minute TTL. The `docs` corpus is immutable for the life of the process,
 * so its `true` is honest; a knowledge search changes the moment someone runs
 * `bernard knowledge add` in another terminal, and `true` here would serve a
 * stale answer for five minutes after an ingest with nothing reporting it.
 *
 * `directInvocable` is absent rather than false — absence is what marks a tool
 * ineligible, and a `bernard script` action must not become a corpus reader.
 */

const ACTIONS = ['list', 'search', 'read'] as const;

const PARAMETERS = z.object({
  action: z
    .enum(ACTIONS)
    .describe(
      '`list` names the libraries and their sizes; `search` retrieves passages; ' +
        '`read` returns a run of one document in order.',
    ),
  query: z.string().optional().describe('Required for `search`.'),
  library: z.string().optional().describe('Restrict to one library id, from `list`.'),
  uri: z.string().optional().describe('Document uri, from a `search` hit. Required for `read`.'),
  from: z.number().int().optional().describe('First chunk for `read` (default 0).'),
  to: z.number().int().optional().describe('Last chunk for `read` (default from + 4).'),
  limit: z.number().int().min(1).max(20).optional().describe('Maximum `search` results.'),
});

const DESCRIPTION =
  "Read the user's ingested document libraries — books, documentation, codebases and pages they " +
  'have added with `bernard knowledge add`. Call `list` to see what exists, `search` to find ' +
  'passages, and `read` to follow a hit into the surrounding document in order. This is the ' +
  "user's own corpus, distinct from Bernard's conversational memory and from Bernard's own docs. " +
  'Adding to a library is a user action at the CLI and cannot be done from here.';

export function createKnowledgeTool(corpus: KnowledgeCorpus) {
  return attachMeta(
    tool({
      description: DESCRIPTION,
      parameters: PARAMETERS,
      execute: async ({ action, query, library, uri, from, to, limit }): Promise<string> => {
        // The fence arrives with the corpus and is applied inside it, so no
        // path here can widen it — `library` narrows on top at most.
        if (action === 'list') {
          const libraries = corpus.list();
          if (libraries.length === 0) {
            return JSON.stringify({
              libraries: [],
              note: 'No knowledge libraries. The user adds one with `bernard knowledge create <id>` and `bernard knowledge add <id> <path>`.',
            });
          }
          return JSON.stringify({
            libraries: libraries.map((l) => ({
              id: l.id,
              title: l.title,
              sources: l.sources,
              chunks: l.chunks,
            })),
          });
        }

        const provider = await getEmbeddingProvider();
        if (!provider) return 'Error: the embedding model is unavailable, so nothing can be read.';

        if (action === 'search') {
          if (!query) return 'Error: `query` is required when action is "search".';
          const result = await searchCorpus(corpus, provider, query, {
            ...(library ? { libraries: [library] } : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
          return JSON.stringify({
            hits: result.hits.map((h) => ({
              library: h.library,
              uri: h.uri,
              ...(h.heading ? { heading: h.heading } : {}),
              chunks: h.ordinals,
              text: h.text,
            })),
            searched: result.searched,
            // Surfaced so "nothing matched" and "that library could not be read"
            // are distinguishable to the model, not just to a human.
            ...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
            ...(result.truncated ? { truncated: true } : {}),
          });
        }

        if (!library || !uri) {
          return 'Error: `library` and `uri` are required when action is "read".';
        }
        // Shared with the CLI rather than reimplemented. The default window
        // size and the clamping rule lived in two files, so changing the CLI's
        // left the tool silently on the old one — which is exactly what the
        // returns-rather-than-prints layer exists to prevent.
        const read = readSource(corpus, library, uri, {
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
        });
        // Out of scope and absent answer the same way, so a fenced dispatch
        // cannot enumerate the catalogue it was fenced from.
        if (!read.ok) return `Error: ${read.error}`;
        return JSON.stringify({
          uri: read.uri,
          ...(read.title ? { title: read.title } : {}),
          chunks: [read.from, read.to],
          total: read.total,
          text: read.text,
        });
      },
    }),
    {
      name: 'knowledge',
      kind: 'read',
      // Not deterministic: an ingest in another terminal changes the answer,
      // and the result cache would serve the stale one for five minutes.
      deterministic: false,
      sideEffect: 'none',
      cacheable: false,
    },
  );
}
