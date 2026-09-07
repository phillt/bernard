import * as fs from 'node:fs';
import * as path from 'node:path';
import { MEMORY_DIR } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';

/** @internal */
export function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * One persistent memory, with the metadata it carries (#513).
 *
 * Before this a memory was a file with text in it and nothing else — not a
 * timestamp, not an author, not a schema version. The only derivable fact was
 * filesystem `mtime`, and nothing read it. So "the newer one wins" could not be
 * stated, supersession could only be expressed by destroying a record, and
 * #373's write-time contradiction check had nothing to compare recency against.
 */
export interface MemoryRecord {
  /**
   * The key as it was WRITTEN, before {@link sanitizeKey}.
   *
   * Recorded because the sanitizer **deletes** rather than replaces, so
   * `"foo bar"`, `"foobar"` and `"foo/bar"` all address `foobar.md` — and
   * `writeMemory` used to overwrite unconditionally. Keeping the raw key is
   * what makes a collision detectable without touching the sanitizer, which is
   * not ours alone to change: `CronNotesStore.sanitizeJobId` imports it, so a
   * fix there silently renames cron notes files too.
   *
   * Falls back to the sanitized filename for a legacy record, which never
   * recorded one.
   */
  key: string;
  /** The body. Front matter is stripped; nothing else is touched. */
  content: string;
  /** ISO 8601. Backfilled from `mtime` for a legacy record — see {@link readRecord}. */
  writtenAt?: string;
  /** The key that replaced this one. Set means "do not render me"; see {@link MemoryStore.listMemory}. */
  supersededBy?: string;
}

/**
 * Front matter, without a YAML parser.
 *
 * Copied from `docs-store.parseDoc`, whose own rationale applies unchanged:
 * three known keys, one line each, no nesting, and a dependency would be
 * carried by every worker dispatch to read three strings. There is no YAML
 * parser in `package.json` and this is the house answer to that.
 *
 * **One hardening over the original.** `parseDoc` returns `null` when its two
 * required fields are missing, and its callers drop the doc. Dropping is not
 * available here — the file is the user's memory — so a fence that yields no
 * recognised key is treated as *body*. Without that, a memory whose content
 * legitimately opens with a markdown rule would be silently decapitated, and
 * these files are written by a model.
 */
interface ParsedMemoryFile {
  /** Present only when the file actually recorded one. Absent for every legacy file. */
  recordedKey?: string;
  writtenAt?: string;
  supersededBy?: string;
  body: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FIELD = /^([a-zA-Z]+):\s*(.*)$/;
const KNOWN_FIELDS = new Set(['key', 'writtenAt', 'supersededBy']);

/** @internal — exported for tests; not part of the store's contract. */
export function parseMemoryFile(source: string): ParsedMemoryFile {
  const match = FRONT_MATTER.exec(source);
  if (!match) return { body: source };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = FIELD.exec(line.trim());
    if (kv && KNOWN_FIELDS.has(kv[1])) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  // A fence carrying nothing we recognise is prose, not metadata.
  if (Object.keys(fields).length === 0) return { body: source };
  return {
    ...(fields.key ? { recordedKey: fields.key } : {}),
    ...(fields.writtenAt ? { writtenAt: fields.writtenAt } : {}),
    ...(fields.supersededBy ? { supersededBy: fields.supersededBy } : {}),
    // The body starts after the closing fence, untouched — no trim, no reflow,
    // for the reason `docs-store` gives: what a test asserts round-trips must
    // be what a model receives.
    body: source.slice(match[0].length),
  };
}

/**
 * Collapses a front-matter value onto one line.
 *
 * A raw key is arbitrary text — the model derives them from URLs and file
 * paths — so a newline in one would close the fence early and turn the rest of
 * the key into body. Applied on write AND to the incoming key during the
 * collision check, so the two always compare like with like.
 */
function oneLine(value: string): string {
  return value.replace(/[^\S ]+|\p{Cc}+/gu, ' ').trim();
}

function serializeMemory(rec: MemoryRecord): string {
  const lines = ['---', `key: ${oneLine(rec.key)}`];
  if (rec.writtenAt) lines.push(`writtenAt: ${rec.writtenAt}`);
  if (rec.supersededBy) lines.push(`supersededBy: ${oneLine(rec.supersededBy)}`);
  lines.push('---');
  return lines.join('\n') + '\n' + rec.content;
}

/** Thrown when a write would land on a file another key already owns. */
export class MemoryKeyCollisionError extends Error {
  constructor(
    readonly requestedKey: string,
    readonly existingKey: string,
  ) {
    super(
      `Memory key "${requestedKey}" resolves to the same file as the existing memory ` +
        `"${existingKey}". Writing it would overwrite that memory. Pick a distinct key, ` +
        `or delete "${existingKey}" first if it is genuinely the same note.`,
    );
    this.name = 'MemoryKeyCollisionError';
  }
}

/**
 * A missing file, as opposed to any other read failure.
 *
 * Narrowed rather than `catch (err: any)`, because the distinction is the whole
 * point: a missing memory is `null`, and a permissions problem must propagate.
 * Swallowing both would report a locked directory as an empty memory store.
 */
function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

interface CacheEntry {
  mtimeMs: number;
  parsed: ParsedMemoryFile;
}

/**
 * Dual-layer store providing disk-backed persistent memory and ephemeral in-memory scratch notes.
 *
 * Persistent memory is stored as individual Markdown files in the data directory.
 * Scratch notes live only for the current session and are discarded on exit.
 */
export class MemoryStore {
  private scratch: Map<string, string> = new Map();

  /**
   * Parsed files, keyed by filename and validated against `mtimeMs`.
   *
   * `getAllMemoryContents` is a `readdir` plus a `readFileSync` per entry with
   * no cache, and `getContextMessages` is awaited **inside `innerIterate`** —
   * so one turn was that whole sweep *per LLM call*, plus a full read each in
   * `recall-filter` and `reference-resolver`. `recall-filter.ts:138-140`
   * documents the hazard and fixes it only within its own pass.
   *
   * Validated by `stat` rather than invalidated by our own writes, because at
   * least four `new MemoryStore()` sites point at the same directory
   * (`index.ts`, `framework/context.ts`, `apps/tool-dispatch.ts`,
   * `apps/direct-tool.ts`) — a sibling's write must be seen. `stat` instead of
   * `read` + parse is the entire saving.
   */
  private cache: Map<string, CacheEntry> = new Map();

  constructor() {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }

  // --- Persistent Memory (disk-backed) ---

  private filePath(key: string): string {
    return path.join(MEMORY_DIR, `${sanitizeKey(key)}.md`);
  }

  /**
   * Reads and parses one file, through the cache.
   *
   * Returns `null` for a missing file. Any other read error propagates — a
   * permissions problem is not an empty memory.
   */
  private load(key: string): { parsed: ParsedMemoryFile; mtimeMs: number } | null {
    const filePath = this.filePath(key);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      if (isMissingFile(err)) {
        this.cache.delete(filePath);
        return null;
      }
      throw err;
    }
    const hit = this.cache.get(filePath);
    if (hit?.mtimeMs === stat.mtimeMs) return { parsed: hit.parsed, mtimeMs: stat.mtimeMs };
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      // The file existed a moment ago; losing the race is still "not there".
      if (isMissingFile(err)) {
        this.cache.delete(filePath);
        return null;
      }
      throw err;
    }
    const parsed = parseMemoryFile(source);
    this.cache.set(filePath, { mtimeMs: stat.mtimeMs, parsed });
    return { parsed, mtimeMs: stat.mtimeMs };
  }

  /** Every key on disk, including superseded ones. */
  listAllMemory(): string[] {
    const files = fs.readdirSync(MEMORY_DIR);
    return files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  }

  /**
   * The keys worth showing — every entry on disk minus the superseded ones.
   *
   * Suppression lives here rather than in the renderer for the reason
   * `ToolProfileStore.list()` gives: superseded is a property of the record, not
   * of one reader, and filtering in only one reader means the others disagree.
   *
   * **The direction is the opposite of that precedent, deliberately.**
   * `ToolProfile.supersedes` sits on the NEW record and names its ancestor,
   * which suits a key rename — the successor is created and declares what it
   * replaced. Here the retiring record carries `supersededBy`, because a memory
   * is frequently retired in favour of one that ALREADY EXISTS (three files
   * encoding one standing rule, keep the best), so there is no new record to
   * hang the pointer on. It also means opening the file tells you it was retired
   * and where to look, which is what makes an archive better than a delete.
   */
  listMemory(): string[] {
    return this.listAllMemory().filter((key) => !this.load(key)?.parsed.supersededBy);
  }

  /** Reads a persistent memory's BODY by key, returning `null` if it does not exist. */
  readMemory(key: string): string | null {
    return this.load(key)?.parsed.body ?? null;
  }

  /**
   * Reads a persistent memory with its metadata, or `null` if it does not exist.
   *
   * A legacy file records nothing, so `key` falls back to the sanitized
   * filename and `writtenAt` is backfilled from `mtime`. That backfill is
   * best-effort by nature — it is when the file was last touched, not when the
   * fact became true — but it is real information and strictly better than
   * `undefined`, and on a real install the spread is intact and plausible
   * (March through August, nothing rewritten in bulk).
   */
  readRecord(key: string): MemoryRecord | null {
    const loaded = this.load(key);
    if (!loaded) return null;
    const { parsed, mtimeMs } = loaded;
    return {
      key: parsed.recordedKey ?? sanitizeKey(key),
      content: parsed.body,
      writtenAt: parsed.writtenAt ?? new Date(mtimeMs).toISOString(),
      ...(parsed.supersededBy ? { supersededBy: parsed.supersededBy } : {}),
    };
  }

  /**
   * Creates or overwrites a persistent memory entry on disk.
   *
   * Stamps `writtenAt`, carries any existing `supersededBy` through, and writes
   * atomically — this was the one store in the repo still using a bare
   * `writeFileSync`, with `saveRewriterHint` doing a read-modify-write on top
   * of it.
   *
   * @throws {MemoryKeyCollisionError} when the target file records a DIFFERENT
   *   raw key. This is `AppletBriefStore`'s stated policy — *"a repaired id
   *   addresses a different store than the caller named"* — reached without
   *   touching the shared sanitizer.
   *
   *   **Its limit, stated rather than discovered:** a legacy file recorded no
   *   raw key, so its collision is undetectable. The hole closes per key on the
   *   first write, never retroactively.
   */
  writeMemory(key: string, content: string): void {
    const existing = this.load(key)?.parsed;
    const incoming = oneLine(key);
    if (existing?.recordedKey && existing.recordedKey !== incoming) {
      throw new MemoryKeyCollisionError(incoming, existing.recordedKey);
    }
    const filePath = this.filePath(key);
    atomicWriteFileSync(
      filePath,
      serializeMemory({
        key: incoming,
        content,
        writtenAt: new Date().toISOString(),
        // Carried through, so re-writing a retired memory does not quietly
        // un-retire it. Un-retiring is `supersede`'s business, or one deleted
        // front-matter line.
        ...(existing?.supersededBy ? { supersededBy: existing.supersededBy } : {}),
      }),
    );
    this.cache.delete(filePath);
  }

  /**
   * Records that `key` has been replaced by `replacement`.
   *
   * Archive, not delete (#373's argument): a wrong supersession would destroy
   * user-curated content, so the file stays exactly where it is and one
   * front-matter line undoes this. It stops being listed, which is what stops it
   * being rendered — and a superseded record costs zero context, so there is no
   * token pressure to go further and unlink it.
   *
   * Returns `false` when `key` does not exist. Throws when the replacement is
   * missing, is the record itself, or would close a cycle — every one of which
   * would produce a memory that is retired in favour of nothing readable.
   */
  supersede(key: string, replacement: string): boolean {
    const record = this.readRecord(key);
    if (!record) return false;
    if (sanitizeKey(key) === sanitizeKey(replacement)) {
      throw new Error(`Memory "${key}" cannot supersede itself.`);
    }
    if (!this.load(replacement)) {
      throw new Error(
        `Cannot supersede "${key}" with "${replacement}": no memory with that key exists.`,
      );
    }
    // Walk the replacement's own chain. Without this, superseding A with B and
    // then B with A leaves both retired and neither reachable — every entry
    // filtered out of `listMemory` with nothing pointing anywhere real.
    const seen = new Set([sanitizeKey(key)]);
    let cursor: string | undefined = replacement;
    while (cursor) {
      const id = sanitizeKey(cursor);
      if (seen.has(id)) {
        throw new Error(
          `Cannot supersede "${key}" with "${replacement}": that would form a supersession cycle.`,
        );
      }
      seen.add(id);
      cursor = this.load(cursor)?.parsed.supersededBy;
    }
    const filePath = this.filePath(key);
    atomicWriteFileSync(
      filePath,
      serializeMemory({ ...record, supersededBy: oneLine(replacement) }),
    );
    this.cache.delete(filePath);
    return true;
  }

  /** Deletes a persistent memory entry. Returns `true` if the entry existed and was removed. */
  deleteMemory(key: string): boolean {
    const filePath = this.filePath(key);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    this.cache.delete(filePath);
    return true;
  }

  /**
   * Every non-superseded memory as a key→body map.
   *
   * Signature unchanged on purpose: this is what `renderPersistentMemory`,
   * `recall-filter` and `reference-resolver` read, and what
   * `context-message.test.ts`'s two-method fake implements. Metadata-aware
   * callers use {@link getAllMemoryRecords}.
   */
  getAllMemoryContents(): Map<string, string> {
    const result = new Map<string, string>();
    for (const key of this.listMemory()) {
      const content = this.readMemory(key);
      if (content !== null) {
        result.set(key, content);
      }
    }
    return result;
  }

  /** Every non-superseded memory with its metadata. */
  getAllMemoryRecords(): Map<string, MemoryRecord> {
    const result = new Map<string, MemoryRecord>();
    for (const key of this.listMemory()) {
      const record = this.readRecord(key);
      if (record !== null) {
        result.set(key, record);
      }
    }
    return result;
  }

  // --- Scratch Notes (in-memory, session only) ---

  /** Returns the keys of all scratch notes in the current session. */
  listScratch(): string[] {
    return Array.from(this.scratch.keys());
  }

  /** Reads a scratch note by key, returning `null` if it does not exist. */
  readScratch(key: string): string | null {
    return this.scratch.get(key) ?? null;
  }

  /** Creates or overwrites a scratch note for the current session. */
  writeScratch(key: string, content: string): void {
    this.scratch.set(key, content);
  }

  /** Deletes a scratch note. Returns `true` if the note existed and was removed. */
  deleteScratch(key: string): boolean {
    return this.scratch.delete(key);
  }

  /** Returns a shallow copy of all scratch notes as a key-content map. */
  getAllScratchContents(): Map<string, string> {
    return new Map(this.scratch);
  }

  /** Removes all scratch notes from the current session. */
  clearScratch(): void {
    this.scratch.clear();
  }
}

export const REWRITER_HINTS_KEY = 'rewriter-hints';
const REWRITER_HINTS_HEADER = '# Rewriter Hints';
const HINT_LINE_PATTERN = /^\s*-\s*"([^"]+)"\s*(?:→|->|=>)\s*([A-Za-z0-9_-]+)\s*$/;

/**
 * Loads persisted reference-resolution hints from the `rewriter-hints` memory file.
 *
 * Format is a markdown list of `- "phrase" → sourceKey` entries. Tolerant to `->` and `=>` arrows.
 */
export function loadRewriterHints(store: MemoryStore): Map<string, string> {
  const hints = new Map<string, string>();
  const raw = store.readMemory(REWRITER_HINTS_KEY);
  if (!raw) return hints;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(HINT_LINE_PATTERN);
    if (match) hints.set(match[1], match[2]);
  }
  return hints;
}

/**
 * Appends or updates a single reference-resolution hint mapping in the `rewriter-hints` memory file.
 *
 * Overwrites the existing entry for the same phrase. Preserves other entries and the header.
 */
export function saveRewriterHint(store: MemoryStore, phrase: string, sourceKey: string): void {
  const existing = loadRewriterHints(store);
  existing.set(phrase, sourceKey);
  const lines: string[] = [REWRITER_HINTS_HEADER, ''];
  for (const [p, k] of existing.entries()) {
    lines.push(`- "${p}" → ${k}`);
  }
  store.writeMemory(REWRITER_HINTS_KEY, lines.join('\n') + '\n');
}
