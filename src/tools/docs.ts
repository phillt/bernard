import { z } from 'zod';
import { tool } from 'ai';
import { allDocs, docIndex, findDoc, renderDoc, renderIndex } from '../docs-store.js';
import { attachActionMeta } from '../framework/tools/adapter.js';

/**
 * `docs` — Bernard's own documentation, findable by the agent that needs it.
 *
 * ## Two actions, not one tool per document
 *
 * Tool-selection accuracy degrades past roughly 30-50 tools, and these are
 * content, not capability — a per-document tool would spend that budget on
 * things that all do the same thing. `list` returns the index (id, title, and
 * the description that says when to read it); `read` returns one document
 * whole.
 *
 * That is Agent Skills' progressive disclosure with a tool call standing in for
 * `Read`: metadata cheap and always reachable, body on demand. There is no
 * third level, deliberately — the guidance is explicit that references more
 * than one hop deep get previewed rather than read.
 *
 * ## Search is deferred, on purpose
 *
 * At this size the index IS the search: six rows, ~700 characters, cheaper to
 * hand over whole than to query. The crossover where retrieval beats
 * navigation is in the hundreds of documents. When it arrives it should be
 * LEXICAL — over headings and symbol names — not embeddings: exact-identifier
 * lookup is embeddings' documented weak spot, and Anthropic's own tool search
 * uses regex/BM25 over names and descriptions for the same reason. Bernard's
 * `RAGStore` is separately unsuitable, since a 90-day TTL would make
 * documentation evaporate and 0.92 dedup would drop similar paragraphs.
 *
 * ## Verbatim needs no new mechanism
 *
 * The instinct is a flag forcing the result to survive unaltered. Nothing
 * shortens a built-in tool's result on the step it returns, so what is
 * actually needed is a size budget — see `docs-store.ts`. The one thing worth
 * doing at this layer is ORDERING: the document comes first and the directive
 * last, which is Anthropic's documents-then-instruction guidance restored
 * inside the one message we control.
 */

const ACTIONS = ['list', 'read'] as const;

/** Both actions only look. */
const READ_ACTIONS: ReadonlySet<string> = new Set(ACTIONS);

const PARAMETERS = z.object({
  action: z
    .enum(ACTIONS)
    .describe(
      '`list` returns every document with a one-line summary of when to read it. ' +
        '`read` returns one whole document, unaltered.',
    ),
  id: z.string().optional().describe('The document id, from `list`. Required for `read`.'),
});

/**
 * The description is the only thing that makes the corpus discoverable without
 * paying for it every turn, so it names the topics and their trigger words
 * rather than describing itself abstractly. Deliberately does NOT enumerate
 * the documents: that would put the index in the cached prefix, which is the
 * cost progressive disclosure exists to avoid.
 */
const DESCRIPTION =
  "Read Bernard's own documentation. Covers building applets (the page contract, styling " +
  'and colour variables, actions and dispatch, the UI runtime, the design brief) and ' +
  "Bernard's own features and slash commands. Call `list` first to see what exists, then " +
  '`read` the one you need. Use it before writing an applet page or manifest, and when the ' +
  'user asks what Bernard can do — it is more reliable than reconstructing an answer.';

export function createDocsTool() {
  const t = tool({
    description: DESCRIPTION,
    parameters: PARAMETERS,
    execute: async (args) => {
      if (args.action === 'list') return renderIndex(docIndex());

      const id = args.id?.trim();
      if (!id) return 'Error: `read` requires an `id`. Call `list` to see what is available.';

      const doc = findDoc(id);
      if (!doc) {
        // Names what does exist rather than only what does not: a model given
        // a bare refusal guesses another plausible id and spends a second
        // turn on it.
        const known = allDocs().map((d) => d.id);
        return `Error: no document "${id}". Available: ${known.join(', ')}.`;
      }
      return renderDoc(doc);
    },
  });

  // `attachActionMeta` classifies an action a write unless it is named here,
  // and the read-only block gate then refuses it — the trap `applet`'s
  // `interview` action hit, where a constant-string getter was treated as a
  // mutation. Both actions read.
  return attachActionMeta(t, {
    name: 'docs',
    kind: 'read',
    sideEffect: 'none',
    readActions: READ_ACTIONS,
    // The corpus is fixed for the life of the process — three documents are
    // built from module constants and the rest are read from disk once — so a
    // repeat read is free and byte-identical. Session-lifetime rather than a
    // TTL for that reason. The cache sits after every permission gate, so this
    // cannot be used to skip one.
    deterministic: true,
    cacheable: true,
    cacheTtlMs: 0,
  });
}
