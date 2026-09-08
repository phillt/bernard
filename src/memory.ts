import * as fs from 'node:fs';
import * as path from 'node:path';
import { MEMORY_DIR } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';
import { splitFrontMatter, normalizeFrontMatterValue } from './front-matter.js';

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
  /**
   * ISO 8601. Set means this was retired in favour of **nothing** — see
   * {@link MemoryStore.retire}.
   *
   * A separate field from {@link supersededBy}, not a `supersededBy: null`,
   * because they are different facts. "X replaced this" points somewhere and
   * tells a reader where to look; "this was never worth keeping" points
   * nowhere. `supersede()` requires an existing replacement and throws without
   * one, deliberately, so a one-off record — a log of a specific email sent in
   * May, "that's an image I uploaded, that can be ignored" — has no way to be
   * expressed through it.
   *
   * Both are filtered by `listMemory()` on the same terms and undone the same
   * way: delete one front-matter line.
   */
  retiredAt?: string;
}

/**
 * A memory file's own record of itself.
 *
 * `Partial<MemoryRecord>` rather than a second field list: the distinction this
 * shape exists for — "was the key RECORDED, or derived from the filename?" —
 * *is* the optionality, and it does not need renamed twins. An earlier cut had
 * `recordedKey`/`body` here against `key`/`content` on the record, which meant
 * the wire format was spelled three times (serializer, parser, `KNOWN_FIELDS`)
 * with nothing in the types saying so.
 */
type ParsedMemoryFile = Partial<MemoryRecord> & { content: string };

/**
 * The fields a memory file records. Anything else in the fence is ignored.
 *
 * `writtenAt`, `supersededBy` and `retiredAt` are the DISCRIMINATORS: a fence
 * is treated as metadata only when it carries at least one of them. `key` alone is not
 * enough, because `key:` is a perfectly ordinary line in prose about YAML — and
 * these files are model-written, so a memory documenting a config format would
 * otherwise be silently decapitated. Both discriminators are written by
 * `serializeMemory` and by nothing else, so no hand-authored fence carries one
 * by accident.
 */
const KNOWN_FIELDS = ['key', 'writtenAt', 'supersededBy', 'retiredAt'] as const;
const DISCRIMINATORS: ReadonlyArray<(typeof KNOWN_FIELDS)[number]> = [
  'writtenAt',
  'supersededBy',
  'retiredAt',
];

/**
 * Parses one memory file.
 *
 * Private, and tested through `MemoryStore` rather than directly: the disk
 * tests already drive every branch through the public API, which is the better
 * test anyway.
 */
function parseMemoryFile(source: string): ParsedMemoryFile {
  const fm = splitFrontMatter(source);
  if (!fm) return { content: source };
  const fields: Partial<Record<(typeof KNOWN_FIELDS)[number], string>> = {};
  for (const name of KNOWN_FIELDS) {
    if (fm.fields[name]) fields[name] = fm.fields[name];
  }
  // A fence with no discriminator is prose, not metadata. Dropping it — which
  // is what `docs-store.parseDoc` does with an unrecognised doc — is not
  // available here: the file is the user's memory.
  if (!DISCRIMINATORS.some((d) => fields[d])) return { content: source };
  return { ...fields, content: fm.body };
}

/**
 * Collapses a front-matter value onto one line.
 *
 * Named `toSingleLine`, not `oneLine`: `reference-resolver.ts` already exports
 * an `oneLine(value, max)` that also TRUNCATES, and two functions sharing a
 * name while behaving differently is a trap for anyone grepping. Importing
 * across that boundary would be the wrong edge, so the fix is the name.
 *
 * A raw key is arbitrary text — the model derives them from URLs and file
 * paths — so a newline in one would close the fence early and turn the rest of
 * the key into body. Applied on write AND to the incoming key during the
 * collision check, so the two always compare like with like.
 */
/**
 * Whether a record has been taken out of circulation, however that happened.
 *
 * One predicate rather than two `&&` terms at the filter, because a third
 * retirement state added later would fail **open**: forgetting the new term
 * means the record silently renders, which is the failure mode this repo tracks
 * everywhere else. `supersededBy` and `retiredAt` differ only in whether they
 * point anywhere; for "should this be shown" they are the same answer.
 */
function isRetired(parsed: ParsedMemoryFile): boolean {
  return parsed.supersededBy !== undefined || parsed.retiredAt !== undefined;
}

function toSingleLine(value: string): string {
  // Normalized the way the READER normalizes, not merely flattened. Writing a
  // value the parser would hand back differently is what made a quoted key
  // un-rewritable: it collided with itself on every subsequent write.
  return normalizeFrontMatterValue(value.replace(/[^\S ]+|\p{Cc}+/gu, ' '));
}

function serializeMemory(rec: MemoryRecord): string {
  const lines = ['---', `key: ${toSingleLine(rec.key)}`];
  if (rec.writtenAt) lines.push(`writtenAt: ${rec.writtenAt}`);
  if (rec.supersededBy) lines.push(`supersededBy: ${toSingleLine(rec.supersededBy)}`);
  if (rec.retiredAt) lines.push(`retiredAt: ${toSingleLine(rec.retiredAt)}`);
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
  /**
   * Compared alongside `mtimeMs`, following `apps/app-csp-grants.ts`'s
   * `readCached`, which validates the same way for the same reason and says
   * why: mtime granularity can miss a same-millisecond external write. That is
   * precisely the case this cache exists to catch — a cron daemon or applet
   * host writing memory while the REPL is open — so validating on mtime alone
   * would leave the one scenario it was built for reachable.
   */
  size: number;
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
    try {
      const stat = fs.statSync(filePath);
      const hit = this.cache.get(filePath);
      if (hit?.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        return { parsed: hit.parsed, mtimeMs: stat.mtimeMs };
      }
      const parsed = parseMemoryFile(fs.readFileSync(filePath, 'utf-8'));
      this.cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
      return { parsed, mtimeMs: stat.mtimeMs };
    } catch (err) {
      // One catch for both syscalls: nothing between them can throw, and the
      // recovery is identical. Two blocks meant two copies to keep in step.
      if (!isMissingFile(err)) throw err;
      this.cache.delete(filePath);
      return null;
    }
  }

  /**
   * Every memory that is still current, loaded ONCE each.
   *
   * The single pass is not tidiness — it is the difference between this cache
   * paying for itself and costing. `listMemory()` has to `load()` each key to
   * read `supersededBy`, and the old `getAll*` bodies then called
   * `readMemory`/`readRecord`, which loaded again: the cache made the second
   * READ free but not the second `stat`. Measured on a real 30-file store,
   * `getAllMemoryContents` ran 0.146 ms against 0.137 ms for the uncached code
   * it replaced — a small REGRESSION, on a path that runs inside `innerIterate`
   * and so once per LLM call. One pass takes it to 0.077 ms, and 300 files from
   * 1.58 ms to 0.87 ms.
   */
  private liveEntries(): Array<{ key: string; parsed: ParsedMemoryFile; mtimeMs: number }> {
    const out: Array<{ key: string; parsed: ParsedMemoryFile; mtimeMs: number }> = [];
    for (const key of this.listAllMemory()) {
      const loaded = this.load(key);
      if (loaded && !isRetired(loaded.parsed)) out.push({ key, ...loaded });
    }
    return out;
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
    return this.liveEntries().map((e) => e.key);
  }

  /** Reads a persistent memory's BODY by key, returning `null` if it does not exist. */
  readMemory(key: string): string | null {
    return this.load(key)?.parsed.content ?? null;
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
      key: parsed.key ?? sanitizeKey(key),
      content: parsed.content,
      writtenAt: parsed.writtenAt ?? new Date(mtimeMs).toISOString(),
      ...(parsed.supersededBy ? { supersededBy: parsed.supersededBy } : {}),
      ...(parsed.retiredAt ? { retiredAt: parsed.retiredAt } : {}),
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
    const incoming = toSingleLine(key);
    if (existing?.key && existing.key !== incoming) {
      throw new MemoryKeyCollisionError(incoming, existing.key);
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
        ...(existing?.retiredAt ? { retiredAt: existing.retiredAt } : {}),
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
    // The cycle walk below already rejects this — `seen` is seeded with `key`
    // and the cursor starts at `replacement` — so this guard buys only a
    // clearer message. Kept for that, and said so rather than left reading as
    // load-bearing.
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
      serializeMemory({ ...record, supersededBy: toSingleLine(replacement) }),
    );
    this.cache.delete(filePath);
    return true;
  }

  /**
   * Records that `key` is no longer worth keeping, in favour of nothing.
   *
   * The counterpart to {@link supersede}, and a separate method for the reason
   * {@link MemoryRecord.retiredAt} is a separate field: `supersede` requires an
   * existing replacement and throws without one, so a one-off record has no way
   * to be expressed through it. Measured on a real store, that is the category
   * that matters — logs of specific emails sent in May, "that's an image I
   * uploaded, that can be ignored" — 29% of the bytes against 0.9% for genuine
   * duplicates.
   *
   * Archive, not delete, on #373's argument and on the same terms as
   * `supersede`: the file stays exactly where it is, stops being listed, and
   * one deleted front-matter line undoes it. A retired record costs zero
   * context because it is not rendered, so there is no pressure to unlink — and
   * deletion is irreversible on content the user wrote.
   *
   * Returns `false` when `key` does not exist. Re-retiring keeps the ORIGINAL
   * timestamp: when it stopped being shown is the fact worth having, and a
   * second call should not quietly restate it as today.
   */
  retire(key: string): boolean {
    const record = this.readRecord(key);
    if (!record) return false;
    const filePath = this.filePath(key);
    atomicWriteFileSync(
      filePath,
      serializeMemory({ ...record, retiredAt: record.retiredAt ?? new Date().toISOString() }),
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
   * `context-message.test.ts`'s two-method fake implements. A metadata-aware
   * bulk reader is deliberately absent until something reads it — the
   * consolidation pass is the first candidate.
   */
  getAllMemoryContents(): Map<string, string> {
    return new Map(this.liveEntries().map((e) => [e.key, e.parsed.content]));
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
