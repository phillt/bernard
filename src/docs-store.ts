import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedDocs } from './docs-generated.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Bernard's own documentation, as something an agent can find and read.
 *
 * Before this, everything an agent knew about building an applet was prompt
 * text — the `applet` tool's parameter descriptions and `applet-styler`'s
 * system prompt. There was nothing to look up: `README.md` and
 * `docs/manual.html` mention applets zero times, `CLAUDE.md` is 310 KB of
 * engineering record, and `docs/` is not published at all.
 *
 * ## The shape is Agent Skills' three levels, with a tool call for `Read`
 *
 * Level 1 is the INDEX — `id`, `title`, `description` — small enough to hand
 * over whole, and the only thing a model sees before deciding a doc is
 * relevant. Level 2 is the document, fetched by id. There is no level 3: the
 * guidance is explicit that references more than one hop deep get partially
 * read, because a model previews a nested file rather than reading it.
 *
 * `description` is therefore load-bearing rather than decorative — it is the
 * entire basis on which a doc is chosen. It must say what the doc is AND when
 * to reach for it, in the third person. A test enforces the shape; "Helps with
 * documents" is the documented anti-example.
 *
 * ## The size bound IS the verbatim guarantee
 *
 * Nothing in Bernard shortens a built-in tool's result on the step it returns —
 * `capSubagentResult` is for sub-agent output, `shapeMCPResult` for MCP, the
 * rest are log-only. The one unconditional cut is `truncateToolResults` at
 * {@link MAX_TOOL_RESULT_CHARS}, applied when the turn's messages enter
 * history, and therefore on every continuation re-seed — the step-limit
 * ladder, a `finishReason: 'length'` continuation, the empty-answer retry, and
 * ReAct plan enforcement.
 *
 * So "return it verbatim" needs no new mechanism, only a budget: a document
 * under that cap survives byte-identical for the life of the conversation, and
 * one over it is silently truncated from the next turn onward. `docs.test.ts`
 * asserts every shipped document fits, against the imported constant rather
 * than a copy of the number.
 */

/** Parsed front matter plus body. */
export interface DocEntry {
  id: string;
  title: string;
  /** What it is and when to read it. The only thing seen before fetching. */
  description: string;
  /** The document, exactly as authored. */
  body: string;
}

/** One row of the index — everything except the body. */
export type DocSummary = Omit<DocEntry, 'body'>;

/**
 * The content budget for one document.
 *
 * Below `context.ts`'s `MAX_TOOL_RESULT_CHARS` by the size of the wrapper, so
 * a document that passes still fits once framed. The margin is deliberate
 * slack — a document nowhere near the edge cannot be pushed over it by a
 * formatting change here.
 *
 * A literal rather than `MAX_TOOL_RESULT_CHARS - 1000`, because importing it
 * would give this leaf an edge to `context.ts` — measured at **65 ms** of
 * module graph, paid by every worker dispatch that builds the tool, for one
 * number. That is the edge `token-estimate.ts` was extracted to refuse.
 * `docs-store.test.ts` imports the real constant and asserts this stays under
 * it, which is the binding without the cost.
 */
export const MAX_DOC_CHARS = 9_000;

/**
 * Locates the bundled `docs` directory beside the loaded module.
 *
 * The `findBuiltinSpecialistsDir` idiom exactly — `dist/docs` in a build,
 * `src/docs` under `tsx`. Returns `null` where the bundle was not deployed,
 * which the tool renders as "no documentation is installed" rather than
 * throwing.
 */
export function findDocsDir(): string | null {
  const candidate = path.join(__dirname, 'docs');
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Reads front matter without a YAML parser.
 *
 * Three known keys, one line each, no nesting — the same argument
 * `page-validate.ts` makes for not growing an HTML parser. A dependency here
 * would be carried by every worker dispatch to read three strings.
 */
export function parseDoc(id: string, source: string): DocEntry | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line.trim());
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  const title = fields.title;
  const description = fields.description;
  if (!title || !description) return null;
  // The body starts after the closing fence, untouched — no trim, no reflow.
  // Whatever a test asserts round-trips must be what a model receives.
  return { id, title, description, body: source.slice(match[0].length) };
}

let cached: DocEntry[] | undefined;

/**
 * Every document, authored and derived, assembled once per process.
 *
 * Derived documents are merged here rather than written to `src/docs/` by a
 * build step: a generated file checked in beside its source is a copy with an
 * alarm on it, where a function is no copy at all. See `docs-generated.ts`.
 */
export function allDocs(): DocEntry[] {
  if (cached) return cached;
  const out: DocEntry[] = [...generatedDocs()];
  const dir = findDocsDir();
  if (dir) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      try {
        const parsed = parseDoc(
          file.replace(/\.md$/, ''),
          fs.readFileSync(path.join(dir, file), 'utf-8'),
        );
        if (parsed) out.push(parsed);
      } catch {
        // A malformed doc is skipped, never fatal: documentation failing to
        // load must not take a turn down with it.
      }
    }
  }
  // One stable order, so the index reads the same on every platform.
  return (cached = out.sort((a, b) => a.id.localeCompare(b.id)));
}

/** The index — level 1. */
export function docIndex(): DocSummary[] {
  return allDocs().map(({ id, title, description }) => ({ id, title, description }));
}

/** One document by id, or `undefined`. */
export function findDoc(id: string): DocEntry | undefined {
  return allDocs().find((d) => d.id === id);
}

/**
 * Frames a document for the model.
 *
 * Two conventions, both from Anthropic's own long-context guidance and both
 * doing work here.
 *
 * `<document>` / `<source>` because a delimited document with its origin
 * attached is followed more reliably than bare text — and because the id is
 * what a citation refers back to.
 *
 * The directive comes AFTER the content, which is the part that runs against
 * intuition. The guidance is documents-first, instruction-last: long input
 * above, the query below it, worth up to 30% on multi-document tasks. A tool
 * result arrives after the instruction that triggered it, so this restores the
 * ordering inside the one message we control. It is also the mitigation for
 * the failure this whole tool exists to prevent — a study of 576,000 generated
 * samples found 19.7% of suggested packages did not exist, so "use these exact
 * names" is a measured need, not politeness.
 */
export function renderDoc(doc: DocEntry): string {
  return [
    '<document>',
    `<source>${doc.id}</source>`,
    '<document_content>',
    doc.body.trimEnd(),
    '</document_content>',
    '</document>',
    '',
    'Use the exact names, paths and signatures above. Do not paraphrase them, and do not',
    'invent options that do not appear here — if something you need is missing, say so',
    'rather than guessing at it.',
  ].join('\n');
}

/** Renders the index. */
export function renderIndex(docs: DocSummary[]): string {
  if (docs.length === 0) return 'No documentation is installed.';
  return [
    'Bernard documentation. Read one with `docs` and `{"action":"read","id":"<id>"}`.',
    '',
    ...docs.map((d) => `- **${d.id}** — ${d.title}. ${d.description}`),
  ].join('\n');
}
