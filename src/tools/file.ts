import { tool } from 'ai';
import { z } from 'zod';
import { MAX_VERIFY_TEXT } from '../provenance.js';
import { attachMeta } from '../framework/tools/adapter.js';
import type { VerifyOutcome } from '../framework/tools/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { ProvenanceStore } from '../provenance.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/** SHA-256 of content, first 16 hex chars. */
/**
 * Joins line contents with newlines, stopping once `max` characters are
 * reached.
 *
 * Accumulating with an early stop rather than `join('\n').slice(0, max)`:
 * `MAX_FILE_SIZE` is 50 MB, so the join-then-slice form builds the entire file
 * as one transient string in order to keep the first 20 KB of it.
 */
function joinUpTo(lines: { content: string }[], max: number): string {
  const parts: string[] = [];
  let len = 0;
  for (const l of lines) {
    parts.push(l.content);
    len += l.content.length + 1;
    if (len >= max) break;
  }
  return parts.join('\n').slice(0, max);
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** Check for null bytes in first 8KB — indicates binary file. */
export function isBinaryContent(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

interface NormalizedEdit {
  action: 'replace' | 'insert' | 'delete' | 'append';
  affectedLine: number; // line number used for sorting (Infinity for append)
  original: {
    action: string;
    line?: number;
    before?: number;
    lines?: number[];
    content?: string;
  };
}

/** Sort edits by affected line descending so high-line edits are applied first. */
export function sortEditsDescending(
  edits: Array<{
    action: 'replace' | 'insert' | 'delete' | 'append';
    line?: number;
    before?: number;
    lines?: number[];
    content?: string;
  }>,
): NormalizedEdit[] {
  const normalized: NormalizedEdit[] = edits.map((e) => {
    let affectedLine: number;
    switch (e.action) {
      case 'replace':
        affectedLine = e.line!;
        break;
      case 'insert':
        affectedLine = e.before!;
        break;
      case 'delete':
        affectedLine = Math.max(...(e.lines ?? [0]));
        break;
      case 'append':
        affectedLine = Infinity;
        break;
    }
    return { action: e.action, affectedLine, original: e };
  });

  return normalized.sort((a, b) => {
    // Appends go last (applied after all positional edits), preserve original order among appends
    if (a.action === 'append' && b.action === 'append') return 0;
    if (a.action === 'append' && b.action !== 'append') return 1;
    if (b.action === 'append' && a.action !== 'append') return -1;
    return b.affectedLine - a.affectedLine;
  });
}

/** Detect conflicting edits — same line targeted by multiple replace/delete operations. */
export function detectConflicts(
  edits: Array<{
    action: 'replace' | 'insert' | 'delete' | 'append';
    line?: number;
    lines?: number[];
  }>,
): string[] {
  const errors: string[] = [];
  const targeted = new Map<number, string[]>();

  for (const e of edits) {
    if (e.action === 'replace' && e.line !== undefined) {
      const existing = targeted.get(e.line) ?? [];
      existing.push('replace');
      targeted.set(e.line, existing);
    }
    if (e.action === 'delete' && e.lines) {
      for (const ln of e.lines) {
        const existing = targeted.get(ln) ?? [];
        existing.push('delete');
        targeted.set(ln, existing);
      }
    }
  }

  for (const [line, actions] of targeted) {
    if (actions.length > 1) {
      errors.push(`Line ${line} targeted by multiple operations: ${actions.join(', ')}`);
    }
  }

  return errors;
}

/** Generate an LLM-friendly diff summary. */
export function generateDiffSummary(
  oldLines: string[],
  edits: Array<{
    action: 'replace' | 'insert' | 'delete' | 'append';
    line?: number;
    before?: number;
    lines?: number[];
    content?: string;
  }>,
): string {
  const parts: string[] = [];

  for (const e of edits) {
    switch (e.action) {
      case 'replace': {
        const old = oldLines[e.line! - 1] ?? '';
        parts.push(`line ${e.line}: "${old}" → "${e.content}"`);
        break;
      }
      case 'insert': {
        const count = (e.content ?? '').split('\n').length;
        const position = e.before === 1 ? 'at beginning of file' : `after line ${e.before! - 1}`;
        parts.push(`${position}: inserted ${count} line${count === 1 ? '' : 's'}`);
        break;
      }
      case 'delete': {
        for (const ln of e.lines ?? []) {
          parts.push(`line ${ln}: deleted`);
        }
        break;
      }
      case 'append': {
        const count = (e.content ?? '').split('\n').length;
        parts.push(`appended ${count} line${count === 1 ? '' : 's'} at end`);
        break;
      }
    }
  }

  return parts.join('\n');
}

/** Split file content into lines, handling trailing newline and CRLF correctly. */
function splitLines(content: string): string[] {
  if (content === '') return [];
  // Normalize CRLF to LF before splitting so lines don't contain trailing \r
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  // If file ends with \n, don't count the empty trailing element
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Writes `content` to `absPath` via a uniquely-named temp file and a rename,
 * so a crash mid-write never leaves a half-written file where a whole one was.
 *
 * Returns an error message, or `null` on success.
 *
 * Not `fs-utils.ts`' `atomicWriteFileSync`: that uses a fixed `.tmp` suffix
 * (two concurrent writers to one path would collide) and leaves the temp file
 * behind when the rename fails.
 */
function atomicWrite(absPath: string, content: string): string | null {
  const tmpPath = `${absPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, absPath);
    return null;
  } catch (err: unknown) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup
    }
    return `Write failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Post-write rubric check (#145) shared by both write tools: re-read the file
 * the result names and confirm its hash matches what the tool declared.
 *
 * Shared rather than copied because the copy drifted on first use — it returned
 * `detail`, which `VerifyOutcome` does not declare, so `augment.ts` read
 * `outcome.evidence` and every warn/fail surfaced with no explanation.
 */
function verifyDeclaredHash(result: unknown): VerifyOutcome | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const p = typeof r.path === 'string' ? r.path : null;
  const expected = typeof r.new_hash === 'string' ? r.new_hash : null;
  if (!p || !expected) return null;
  try {
    const actual = hashContent(fs.readFileSync(p, 'utf-8'));
    return actual === expected
      ? { status: 'pass', evidence: `hash matches (${actual.slice(0, 8)})` }
      : {
          status: 'warn',
          evidence: `hash drift: declared ${expected.slice(0, 8)}, actual ${actual.slice(0, 8)}`,
        };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      status: 'fail',
      evidence:
        code === 'ENOENT'
          ? `file missing after write: ${p}`
          : `cannot re-read after write: ${p} (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/** Detect line ending style from content. */
function detectLineEnding(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/** Creates the `file_read_lines`, `file_write` and `file_edit_lines` tools. */
export function createFileTools(provenance?: ProvenanceStore) {
  return {
    file_read_lines: attachMeta(
      tool({
        description:
          'Read a file with line numbers. Returns structured line-numbered content for precise referencing. Use offset/limit to paginate large files.',
        parameters: z.object({
          path: z.string().describe('File path to read (relative or absolute)'),
          offset: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Start line number (1-based, default 1)'),
          limit: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Maximum lines to return (default 1000)'),
        }),
        execute: async ({
          path: filePath,
          offset = 1,
          limit = 1000,
        }): Promise<
          | {
              path: string;
              total_lines: number;
              offset: number;
              limit: number;
              lines: Array<{ num: number; content: string }>;
              truncated: boolean;
              source_id?: string;
            }
          | { error: string }
        > => {
          try {
            const absPath = path.resolve(filePath);

            // Validate file exists
            let stat: fs.Stats;
            try {
              stat = fs.statSync(absPath);
            } catch (err: unknown) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'ENOENT') return { error: `File not found: ${absPath}` };
              return { error: `Cannot access ${absPath}: ${(err as Error).message}` };
            }

            if (stat.isDirectory()) {
              return { error: `Path is a directory, not a file: ${absPath}` };
            }

            if (stat.size > MAX_FILE_SIZE) {
              return {
                error: `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE}): ${absPath}`,
              };
            }

            // Read once — use buffer for binary check, then decode
            const rawBuffer = fs.readFileSync(absPath);
            if (isBinaryContent(rawBuffer)) {
              return { error: `File appears to be binary: ${absPath}` };
            }
            const content = rawBuffer.toString('utf-8');
            const allLines = splitLines(content);
            const totalLines = allLines.length;

            const startIdx = offset - 1;
            const endIdx = Math.min(startIdx + limit, totalLines);
            const sliced = startIdx < totalLines ? allLines.slice(startIdx, endIdx) : [];

            const lines = sliced.map((line, i) => ({
              num: startIdx + i + 1,
              content: line,
            }));

            // Register the read range as a citeable source. Dedup keys
            // off the path+range so re-reads of the same span share an id.
            let sourceId: string | undefined;
            if (provenance && lines.length > 0) {
              const startLine = lines[0].num;
              const endLine = lines[lines.length - 1].num;
              // Keep a wider slice so the Sources viewer's content panel shows
              // a meaningful excerpt; ProvenanceStore caps it at MAX_PREVIEW.
              const preview = lines
                .slice(0, 40)
                .map((l) => l.content)
                .join('\n');
              // A file's mtime is the closest thing it has to a publication
              // date. Reuses the `stat` this function already took for the
              // exists/size checks rather than issuing a second syscall on the
              // same path — and since that one succeeded, there is no failure
              // left here to guard against.
              sourceId = provenance.add({
                kind: 'file',
                label: `${absPath}:${startLine}-${endLine}`,
                contentPreview: preview,
                rawRef: `${absPath}:${startLine}-${endLine}`,
                publishedAt: stat.mtime.toISOString(),
                // The whole read span, not the 40-line preview — a quote from
                // line 300 of a 400-line read has to be checkable. Accumulated
                // with an early stop rather than joining first and slicing
                // after: `MAX_FILE_SIZE` is 50 MB, so a minified bundle would
                // otherwise build a 50 MB transient to keep 20 KB of it.
                verifyText: joinUpTo(lines, MAX_VERIFY_TEXT),
              });
            }

            return {
              path: absPath,
              total_lines: totalLines,
              offset,
              limit,
              lines,
              truncated: endIdx < totalLines,
              ...(sourceId ? { source_id: sourceId } : {}),
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { error: msg };
          }
        },
      }),
      {
        name: 'file_read_lines',
        kind: 'read',
        // Every parameter is structured — a path and line numbers (#445).
        directInvocable: true,
        deterministic: false,
        sideEffect: 'local',
        cacheable: false,
      },
    ),

    // Deliberately NOT in `DEFAULT_SHIM_ROUTING` (`wrap-with-specialist.ts`),
    // unlike `file_edit_lines`. Routing a write through `file-wrapper` would
    // pass the entire payload through a second model on its way to disk — the
    // extra hop costs a dispatch per write and re-introduces exactly the
    // truncation this tool exists to avoid. Reads and edits are small and
    // benefit from the wrapper's OS-aware examples; whole-file authoring does
    // not. (`formatWrappedResult` still maps its error shape, for a specialist
    // that names `file_write` in its own `targetTools`.)
    file_write: attachMeta(
      tool({
        description:
          'Write a complete file in one call, creating it if needed and replacing it if it exists. Use this to author scripts, reports, JSON payloads, or any file content — instead of embedding the payload in a shell heredoc, which is fragile and can be truncated. Use file_edit_lines to modify an existing file in place.',
        parameters: z.object({
          // MUST be named `path`: the permission engine routes FILE_TOOLS
          // through `matchPathSpecifier(rule.specifier, args.path)`, so any
          // other name silently loses path-scoped grants and the breadth
          // ladder (exact file -> dir/** -> parent/**).
          path: z.string().describe('File path to write (relative or absolute)'),
          content: z.string().describe('Complete file content. Replaces the file if it exists.'),
          create_dirs: z
            .boolean()
            .optional()
            .describe('Create missing parent directories (default: false)'),
        }),
        execute: async ({
          path: filePath,
          content,
          create_dirs = false,
        }): Promise<
          | { path: string; bytes: number; new_hash: string; created: boolean; total_lines: number }
          | { error: string }
        > => {
          try {
            const absPath = path.resolve(filePath);

            // `throwIfNoEntry: false` gives "does it exist?" and "what is it?"
            // in one syscall — a missing file is the expected case here, not an
            // error, unlike the read/edit tools.
            const stat = fs.statSync(absPath, { throwIfNoEntry: false });
            if (stat?.isDirectory()) {
              return { error: `Path is a directory, not a file: ${absPath}` };
            }
            const created = stat === undefined;

            const bytes = Buffer.byteLength(content, 'utf-8');
            if (bytes > MAX_FILE_SIZE) {
              return { error: `Content too large (${bytes} bytes, max ${MAX_FILE_SIZE})` };
            }

            // Only worth checking when the target is new — if `statSync` found
            // the file, its parent exists by construction.
            const parent = path.dirname(absPath);
            if (created && !fs.existsSync(parent)) {
              if (!create_dirs) {
                return {
                  error: `Parent directory does not exist: ${parent} (pass create_dirs: true to create it)`,
                };
              }
              fs.mkdirSync(parent, { recursive: true });
            }

            const writeError = atomicWrite(absPath, content);
            if (writeError) return { error: writeError };

            return {
              path: absPath,
              bytes,
              new_hash: hashContent(content),
              created,
              total_lines: splitLines(content).length,
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { error: msg };
          }
        },
      }),
      {
        name: 'file_write',
        kind: 'write',
        // A path and the bytes to put at it (#445). `content` is free-form,
        // and that is fine: it is written, never interpreted. WHERE it may
        // be written is the write-scope gate's answer, not this flag's.
        directInvocable: true,
        deterministic: false,
        sideEffect: 'local',
        cacheable: false,
        verifyOutput: (_args, result) => verifyDeclaredHash(result),
      },
    ),

    file_edit_lines: attachMeta(
      tool({
        description:
          'Edit a file with precise line-based operations. Supports replace, insert, delete, and append actions. Multiple edits are applied atomically (all or nothing). Always read the file first with file_read_lines to get current line numbers.',
        parameters: z.object({
          path: z.string().describe('File path to edit (relative or absolute)'),
          edits: z
            .array(
              z.object({
                action: z
                  .enum(['replace', 'insert', 'delete', 'append'])
                  .describe(
                    'replace: replace content at a line number; insert: insert before a line; delete: remove specific lines; append: add to end of file',
                  ),
                line: z.number().int().min(1).optional().describe('Line number for replace action'),
                before: z.number().int().min(1).optional().describe('Line number to insert before'),
                lines: z
                  .array(z.number().int().min(1))
                  .optional()
                  .describe('Line numbers to delete'),
                content: z
                  .string()
                  .optional()
                  .describe(
                    'New content for replace/insert/append (may contain \\n for multi-line)',
                  ),
              }),
            )
            .min(1)
            .describe('Array of edit operations to apply'),
        }),
        execute: async ({
          path: filePath,
          edits,
        }): Promise<
          | {
              path: string;
              old_hash: string;
              new_hash: string;
              edits_applied: number;
              total_lines: number;
              diff: string;
            }
          | { error: string }
        > => {
          try {
            const absPath = path.resolve(filePath);

            // Validate file exists
            let stat: fs.Stats;
            try {
              stat = fs.statSync(absPath);
            } catch (err: unknown) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'ENOENT') return { error: `File not found: ${absPath}` };
              return { error: `Cannot access ${absPath}: ${(err as Error).message}` };
            }

            if (stat.isDirectory()) {
              return { error: `Path is a directory, not a file: ${absPath}` };
            }

            if (stat.size > MAX_FILE_SIZE) {
              return {
                error: `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE}): ${absPath}`,
              };
            }

            // Read once — use buffer for binary check, then decode
            const rawBuffer = fs.readFileSync(absPath);
            if (isBinaryContent(rawBuffer)) {
              return { error: `File appears to be binary: ${absPath}` };
            }
            const rawContent = rawBuffer.toString('utf-8');
            const lineEnding = detectLineEnding(rawContent);
            const hadTrailingNewline =
              rawContent.length > 0 && (rawContent.endsWith('\n') || rawContent.endsWith('\r\n'));
            const oldLines = splitLines(rawContent);
            const totalLines = oldLines.length;
            const oldHash = hashContent(rawContent);

            // Validate all edits upfront
            const validationErrors: string[] = [];

            for (let i = 0; i < edits.length; i++) {
              const e = edits[i];
              const prefix = `Edit ${i + 1} (${e.action})`;

              switch (e.action) {
                case 'replace':
                  if (e.line === undefined) validationErrors.push(`${prefix}: "line" is required`);
                  else if (e.line > totalLines)
                    validationErrors.push(
                      `${prefix}: line ${e.line} out of bounds (file has ${totalLines} lines)`,
                    );
                  if (e.content === undefined)
                    validationErrors.push(`${prefix}: "content" is required`);
                  break;
                case 'insert':
                  if (e.before === undefined)
                    validationErrors.push(`${prefix}: "before" is required`);
                  else if (e.before > totalLines + 1)
                    validationErrors.push(
                      `${prefix}: before ${e.before} out of bounds (file has ${totalLines} lines, max ${totalLines + 1})`,
                    );
                  if (e.content === undefined)
                    validationErrors.push(`${prefix}: "content" is required`);
                  break;
                case 'delete':
                  if (!e.lines || e.lines.length === 0)
                    validationErrors.push(
                      `${prefix}: "lines" array is required and must not be empty`,
                    );
                  else {
                    for (const ln of e.lines) {
                      if (ln > totalLines)
                        validationErrors.push(
                          `${prefix}: line ${ln} out of bounds (file has ${totalLines} lines)`,
                        );
                    }
                  }
                  break;
                case 'append':
                  if (e.content === undefined)
                    validationErrors.push(`${prefix}: "content" is required`);
                  break;
              }
            }

            // Check for conflicts
            const conflicts = detectConflicts(edits);
            validationErrors.push(...conflicts);

            if (validationErrors.length > 0) {
              return { error: validationErrors.join('; ') };
            }

            // Sort edits descending so high-line edits are applied first
            const sorted = sortEditsDescending(edits);

            // Apply edits to in-memory lines
            const lines = [...oldLines];

            for (const { original: e } of sorted) {
              switch (e.action) {
                case 'replace': {
                  const newLines = e.content!.split('\n');
                  lines.splice(e.line! - 1, 1, ...newLines);
                  break;
                }
                case 'insert':
                  lines.splice(e.before! - 1, 0, ...e.content!.split('\n'));
                  break;
                case 'delete': {
                  // Sort delete line numbers descending within this edit
                  const delLines = [...e.lines!].sort((a, b) => b - a);
                  for (const ln of delLines) {
                    lines.splice(ln - 1, 1);
                  }
                  break;
                }
                case 'append':
                  lines.push(...e.content!.split('\n'));
                  break;
              }
            }

            // Write atomically: write to temp file, then rename (POSIX rename atomically replaces target)
            const newContent =
              lines.length > 0
                ? lines.join(lineEnding) + (hadTrailingNewline ? lineEnding : '')
                : '';
            const tmpPath = `${absPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

            try {
              fs.writeFileSync(tmpPath, newContent, 'utf-8');
              fs.renameSync(tmpPath, absPath);
            } catch (writeErr: unknown) {
              try {
                fs.unlinkSync(tmpPath);
              } catch {
                // Best-effort cleanup
              }
              const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
              return { error: `Write failed: ${msg}` };
            }

            const newHash = hashContent(newContent);
            const diff = generateDiffSummary(oldLines, edits);

            return {
              path: absPath,
              old_hash: oldHash,
              new_hash: newHash,
              edits_applied: edits.length,
              total_lines: lines.length,
              diff,
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { error: msg };
          }
        },
      }),
      {
        name: 'file_edit_lines',
        kind: 'write',
        deterministic: false,
        sideEffect: 'local',
        cacheable: false,
        // Post-write check (issue #145): re-stat the file and confirm its
        // hash matches the new_hash the tool just declared. Pass on match,
        // warn on mismatch (someone else wrote it under us), fail if the
        // file disappeared. Skips when the result shape isn't recognized.
        verifyOutput: (_args, result) => {
          if (!result || typeof result !== 'object') return null;
          const r = result as Record<string, unknown>;
          const p = typeof r.path === 'string' ? r.path : null;
          const expected = typeof r.new_hash === 'string' ? r.new_hash : null;
          if (!p || !expected) return null;
          try {
            const onDisk = fs.readFileSync(p, 'utf-8');
            const actual = hashContent(onDisk);
            if (actual === expected) {
              return { status: 'pass', evidence: `hash matches (${actual.slice(0, 8)})` };
            }
            return {
              status: 'warn',
              evidence: `hash drift: declared ${expected.slice(0, 8)}, actual ${actual.slice(0, 8)}`,
            };
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === 'ENOENT') return { status: 'fail', evidence: 'file missing post-write' };
            return null;
          }
        },
      },
    ),
  };
}
