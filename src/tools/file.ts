import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/** SHA-256 of content, first 16 hex chars. */
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
    if (e.action === 'replace' && e.line != null) {
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

/** Detect line ending style from content. */
function detectLineEnding(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/** Creates file_read_lines and file_edit_lines tools. */
export function createFileTools() {
  return {
    file_read_lines: tool({
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

          return {
            path: absPath,
            total_lines: totalLines,
            offset,
            limit,
            lines,
            truncated: endIdx < totalLines,
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: msg };
        }
      },
    }),

    file_edit_lines: tool({
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
              lines: z.array(z.number().int().min(1)).optional().describe('Line numbers to delete'),
              content: z
                .string()
                .optional()
                .describe('New content for replace/insert/append (may contain \\n for multi-line)'),
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
                if (e.line == null) validationErrors.push(`${prefix}: "line" is required`);
                else if (e.line > totalLines)
                  validationErrors.push(
                    `${prefix}: line ${e.line} out of bounds (file has ${totalLines} lines)`,
                  );
                if (e.content == null) validationErrors.push(`${prefix}: "content" is required`);
                break;
              case 'insert':
                if (e.before == null) validationErrors.push(`${prefix}: "before" is required`);
                else if (e.before > totalLines + 1)
                  validationErrors.push(
                    `${prefix}: before ${e.before} out of bounds (file has ${totalLines} lines, max ${totalLines + 1})`,
                  );
                if (e.content == null) validationErrors.push(`${prefix}: "content" is required`);
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
                if (e.content == null) validationErrors.push(`${prefix}: "content" is required`);
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
              case 'replace':
                lines[e.line! - 1] = e.content!;
                break;
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

          // Write atomically: temp file → rename original to .bak → rename temp → remove .bak
          const newContent = lines.length > 0 ? lines.join(lineEnding) + lineEnding : '';
          const tmpPath = absPath + '.tmp';
          const bakPath = absPath + '.bak';

          try {
            fs.writeFileSync(tmpPath, newContent, 'utf-8');
            fs.renameSync(absPath, bakPath);
            fs.renameSync(tmpPath, absPath);
            try {
              fs.unlinkSync(bakPath);
            } catch {
              // Best-effort cleanup
            }
          } catch (writeErr: unknown) {
            // Try to restore from backup if rename failed
            try {
              if (fs.existsSync(bakPath) && !fs.existsSync(absPath)) {
                fs.renameSync(bakPath, absPath);
              }
            } catch {
              // Last resort — nothing more we can do
            }
            const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
            return { error: `Write failed: ${msg}` };
          }

          const newHash = hashContent(newContent);
          const diff = generateDiffSummary(oldLines, lines, edits);

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
  };
}
