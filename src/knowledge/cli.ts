import { printError, printInfo } from '../output.js';
import { plural } from '../text.js';
import { formatBytes } from '../output.js';
import { openCorpus } from './corpus.js';
import {
  addSources,
  createLibrary,
  libraryStats,
  listLibraries,
  readSource,
  removeLibrary,
  removeSource,
  searchLibraries,
} from './manage.js';

/**
 * `bernard knowledge` — a printer over `manage.ts` (#516/#517).
 *
 * Every decision lives next door and is returned rather than printed; this file
 * only formats and sets `process.exitCode`. That split is what lets the same
 * operations back an Ink surface later without writing into the alternate
 * screen buffer, and what makes them testable without a terminal.
 */

const fail = (message: string): void => {
  printError(message);
  process.exitCode = 1;
};

export function knowledgeList(): void {
  const libraries = listLibraries();
  if (libraries.length === 0) {
    printInfo('No knowledge libraries yet. Create one with `bernard knowledge create <id>`.');
    return;
  }
  for (const lib of libraries) {
    const label = lib.title === lib.id ? lib.id : `${lib.id} — ${lib.title}`;
    printInfo(
      `${label}\n  ${lib.sources} ${plural(lib.sources, 'source', 'sources')}, ` +
        `${lib.chunks} ${plural(lib.chunks, 'chunk', 'chunks')}, ${formatBytes(lib.bytes)}`,
    );
  }
}

export function knowledgeCreate(id: string, title?: string): void {
  const out = createLibrary(id, title);
  if (!out.ok) return fail(out.error);
  printInfo(`Created library "${out.id}" at ${out.path}`);
}

export function knowledgeRemove(id: string, uri?: string): void {
  const out = uri ? removeSource(id, uri) : removeLibrary(id);
  if (!out.ok) return fail(out.error);
  printInfo(uri ? `Removed ${uri} from "${id}".` : `Removed library "${id}".`);
}

export function knowledgeStats(id: string): void {
  const out = libraryStats(id);
  if (!out.ok) return fail(out.error);
  printInfo(
    `${out.summary.id} — ${out.summary.title}\n` +
      `  embedded with ${out.summary.stamp?.model ?? 'unknown'} at ` +
      `${out.summary.stamp?.dimensions ?? '?'} dimensions\n` +
      `  ${out.summary.sources} sources, ${out.summary.chunks} chunks, ` +
      `${formatBytes(out.summary.bytes)}`,
  );
  for (const s of out.sources) {
    printInfo(`  ${s.uri}  (${s.chunkCount} chunks, ingested ${s.ingestedAt.slice(0, 10)})`);
  }
}

export async function knowledgeAdd(
  id: string,
  targets: string[],
  opts: { force?: boolean } = {},
): Promise<void> {
  // A `\r` progress bar in a piped log is garbage, so a non-TTY gets one line
  // per source instead. Same rule `headless.ts` states about its own sink.
  const tty = process.stdout.isTTY === true;
  let lastLine = 0;

  const out = await addSources(id, targets, {
    ...(opts.force ? { force: true } : {}),
    onProgress: (p) => {
      if (!tty) {
        if (p.status !== 'unchanged') printInfo(`${p.status}: ${p.uri} (${p.chunks} chunks)`);
        return;
      }
      const line = `  [${p.done}/${p.total}] ${p.status}: ${p.uri}`;
      process.stdout.write(`\r${line.padEnd(lastLine)}`);
      lastLine = line.length;
    },
  });
  if (tty && lastLine > 0) process.stdout.write(`\r${' '.repeat(lastLine)}\r`);
  if (!out.ok) return fail(out.error);

  const parts = [`${out.ingested} ingested`, `${out.chunks} chunks`];
  if (out.unchanged > 0) parts.push(`${out.unchanged} unchanged`);
  if (out.removed.length > 0) parts.push(`${out.removed.length} removed`);
  printInfo(`Library "${out.library}": ${parts.join(', ')}.`);

  // Said out loud rather than logged: this is the number that means part of a
  // document is not retrievable.
  if (out.overBudget > 0) {
    printError(
      `${out.overBudget} chunk(s) exceeded the embedder's word-piece limit and were truncated. ` +
        'Their tails are not searchable.',
    );
  }
  if (!out.verified) {
    printInfo(
      'Note: chunk sizes were estimated from characters rather than counted, ' +
        'so some chunks may have been truncated by the embedder.',
    );
  }
  for (const f of out.failed) printError(`  ${f.uri}: ${f.reason}`);
}

export async function knowledgeSearch(
  query: string,
  opts: { library?: string; limit?: number; neighbours?: number } = {},
): Promise<void> {
  const out = await searchLibraries(query, {
    ...(opts.library ? { libraries: [opts.library] } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.neighbours !== undefined ? { neighbours: opts.neighbours } : {}),
  });
  if (!out.ok) return fail(out.error);

  for (const s of out.skipped) printError(`Skipped ${s.library}: ${s.reason}`);
  if (out.hits.length === 0) {
    printInfo(
      out.searched.length === 0
        ? 'No libraries to search.'
        : `Nothing in ${out.searched.join(', ')} matched.`,
    );
    return;
  }
  for (const hit of out.hits) {
    const where = hit.heading ? `${hit.uri} — ${hit.heading}` : hit.uri;
    printInfo(
      `[${hit.library}] ${where}  (chunks ${hit.ordinals[0]}-${hit.ordinals[1]}, ` +
        `cosine ${hit.cosine.toFixed(3)}, ${hit.channels.join('+')})\n${hit.text}\n`,
    );
  }
  if (out.truncated) printInfo('… more matched than fits in the output budget.');
}

export function knowledgeRead(
  id: string,
  uri: string,
  opts: { from?: number; to?: number } = {},
): void {
  const out = readSource(openCorpus(), id, uri, opts);
  if (!out.ok) return fail(out.error);
  printInfo(
    `${out.title ?? out.uri}  (chunks ${out.from}-${out.to} of ${out.total})\n\n${out.text}`,
  );
}
