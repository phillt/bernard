import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultHasBin } from '../voice-service.js';
import { htmlToMarkdown } from '../html-text.js';
import { normalizeSource } from './chunk.js';

/**
 * A source → plain text, for corpus ingestion (#517).
 *
 * Four readers, and **only one of them costs anything**:
 *
 * | kind | reader | new dependency |
 * | --- | --- | --- |
 * | prose (`.md`, `.txt`, …) | read it | none |
 * | code (`.ts`, `.py`, …) | read it, chunk in code mode | none |
 * | web page | the strip-selectors + Turndown pipeline `web_read` uses | none |
 * | PDF | `pdftotext`, probed on PATH | none installed |
 *
 * **PDF takes the shape `voice-service.ts` uses for TTS backends** — probe for a
 * binary with the probe injected so it is testable, and say plainly what to
 * install when it is absent — rather than adding a PDF parser to
 * `dependencies`. A parser is a large, security-sensitive surface that would
 * then need keeping current for a format most corpora are not in, and Poppler
 * is present or one package away almost everywhere.
 */

/** How a source should be chunked. Decided by extension, not by sniffing. */
export type ExtractMode = 'prose' | 'code';

export interface Extracted {
  /** Absolute path or URL — the source's identity in the store. */
  uri: string;
  kind: 'file' | 'url' | 'text';
  title?: string;
  /** Already normalised: offsets and the content hash are taken against this. */
  text: string;
  mode: ExtractMode;
  bytes: number;
  /** mtime for a file. Never invented for a URL — a guessed date is worse than none. */
  publishedAt?: string;
}

/** A source that could not be read. Reported per source; an ingest continues. */
export interface ExtractFailure {
  uri: string;
  reason: string;
}

export type ExtractResult = Extracted | ExtractFailure;

export function isFailure(r: ExtractResult): r is ExtractFailure {
  return 'reason' in r;
}

/**
 * Read no more than this from one file.
 *
 * Mirrors `web_read`'s 20,000-char output cap in spirit but is far larger,
 * because a corpus source is *meant* to be a whole document — `CLAUDE.md` alone
 * is 418,698 characters. The cap exists so a stray binary or a log file cannot
 * pull hundreds of megabytes through the chunker, not to bound documents.
 */
export const MAX_SOURCE_BYTES = 8_000_000;

/** Extensions chunked as prose. */
const PROSE_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.text',
  '.rst',
  '.org',
  '.adoc',
]);

/**
 * Extensions chunked as code — split on lines rather than sentences.
 *
 * Structured-data formats (`.json`, `.yaml`, `.toml`) are here too. They are
 * not code, but they share the property that decides the mode: no sentences,
 * and a line is a meaningful unit.
 */
const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.rb',
  '.java',
  '.kt',
  '.scala',
  '.swift',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.css',
  '.scss',
  '.less',
  '.vue',
  '.svelte',
  '.lua',
  '.ex',
  '.exs',
  '.erl',
  '.clj',
  '.hs',
  '.ml',
  '.zig',
  '.dart',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.xml',
]);

const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml']);

/** Whether this path is a source ingestion knows how to read at all. */
export function isIngestable(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return (
    PROSE_EXTENSIONS.has(ext) ||
    CODE_EXTENSIONS.has(ext) ||
    HTML_EXTENSIONS.has(ext) ||
    ext === '.pdf'
  );
}

export function modeFor(filePath: string): ExtractMode {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? 'code' : 'prose';
}

/**
 * The PDF text extractor to use, or `null`.
 *
 * `probe` is injected for the reason `resolveBackend` injects its own: a test
 * that shells out to `which` measures the machine it runs on, so the
 * absent-binary path — the one with a user-facing message — would be untestable
 * anywhere Poppler happens to be installed.
 *
 * The default probe is SHARED with `voice-service.ts` rather than mirrored.
 * Copying `resolveBackend`'s SHAPE is right — injected probe, platform as a
 * parameter — but its six-line body is not a shape, and `which` is absent on
 * Windows, so two copies fail identically in two files and fixing one leaves
 * the other.
 */
export function resolvePdfReader(probe: (bin: string) => boolean = defaultHasBin): string | null {
  return probe('pdftotext') ? 'pdftotext' : null;
}

/** What to tell a user who pointed at a PDF with no reader installed. */
export const PDF_MISSING_MESSAGE =
  'PDF support needs the `pdftotext` command (part of Poppler). ' +
  'Install it — `apt install poppler-utils`, `brew install poppler`, ' +
  '`dnf install poppler-utils` — and re-run, or convert the file to text first.';

export interface ExtractOptions {
  /** Injected so the absent-binary path is testable. */
  pdfProbe?: (bin: string) => boolean;
  maxBytes?: number;
}

/**
 * Read one file.
 *
 * Failures are RETURNED rather than thrown: a directory ingest meets unreadable
 * files routinely — a broken symlink, a permission, a PDF with no reader — and
 * one of them must not abort the other 199. The caller reports them together.
 */
export function extractFile(absPath: string, opts: ExtractOptions = {}): ExtractResult {
  const maxBytes = opts.maxBytes ?? MAX_SOURCE_BYTES;
  const ext = path.extname(absPath).toLowerCase();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    return { uri: absPath, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!stat.isFile()) return { uri: absPath, reason: 'not a regular file' };
  if (stat.size > maxBytes) {
    return {
      uri: absPath,
      reason: `${stat.size} bytes exceeds the ${maxBytes}-byte source limit`,
    };
  }
  if (!isIngestable(absPath)) {
    return { uri: absPath, reason: `no reader for ${ext || 'a file with no extension'}` };
  }

  const publishedAt = stat.mtime.toISOString();
  const base: Pick<Extracted, 'uri' | 'kind' | 'publishedAt'> = {
    uri: absPath,
    kind: 'file',
    publishedAt,
  };

  if (ext === '.pdf') {
    const reader = resolvePdfReader(opts.pdfProbe);
    if (!reader) return { uri: absPath, reason: PDF_MISSING_MESSAGE };
    try {
      // `-` writes to stdout; `-layout` preserves column structure, which is
      // what keeps a two-column page from interleaving its columns line by line
      // into text no chunker can rescue.
      const raw = execFileSync(reader, ['-layout', '-enc', 'UTF-8', absPath, '-'], {
        encoding: 'utf-8',
        maxBuffer: maxBytes,
      });
      const text = normalizeSource(raw);
      return { ...base, title: path.basename(absPath), text, mode: 'prose', bytes: text.length };
    } catch (err) {
      return {
        uri: absPath,
        reason: `pdftotext failed: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    return { uri: absPath, reason: err instanceof Error ? err.message : String(err) };
  }

  if (HTML_EXTENSIONS.has(ext)) {
    const { title, markdown } = htmlToMarkdown(raw);
    const text = normalizeSource(markdown);
    return {
      ...base,
      ...(title ? { title } : {}),
      text,
      mode: 'prose',
      bytes: text.length,
    };
  }

  const text = normalizeSource(raw);
  return {
    ...base,
    title: path.basename(absPath),
    text,
    mode: modeFor(absPath),
    bytes: text.length,
  };
}

/**
 * Walk a directory for ingestable files.
 *
 * Skips the directories nobody means to ingest. `node_modules` is the one that
 * matters: it is routinely larger than the project by two orders of magnitude,
 * so without this a `bernard knowledge add ./` reads as a hang.
 */
export const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '__pycache__',
  'vendor',
  'target',
]);

export function walkIngestable(root: string, limit = 5_000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) stack.push(full);
        continue;
      }
      // A symlink is neither followed nor read: following one can leave the
      // root the user named, and a cycle turns the walk into a hang.
      if (entry.isFile() && isIngestable(full)) {
        out.push(full);
        // Checked here, not only in the `while` above. One directory holding
        // more than `limit` files pushes every one of them before the outer
        // condition is re-evaluated, so the cap reads as enforced and is not.
        if (out.length >= limit) return out.sort();
      }
    }
  }
  return out.sort();
}
