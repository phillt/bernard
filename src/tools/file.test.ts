import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import {
  hashContent,
  isBinaryContent,
  sortEditsDescending,
  detectConflicts,
  generateDiffSummary,
  createFileTools,
} from './file.js';

// ── Helpers ──────────────────────────────────────────────────────────

describe('hashContent', () => {
  it('returns a 16-char hex string', () => {
    const h = hashContent('hello world');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns different hashes for different content', () => {
    expect(hashContent('aaa')).not.toBe(hashContent('bbb'));
  });

  it('returns same hash for same content', () => {
    expect(hashContent('same')).toBe(hashContent('same'));
  });
});

describe('isBinaryContent', () => {
  it('returns false for plain text', () => {
    expect(isBinaryContent(Buffer.from('hello world'))).toBe(false);
  });

  it('returns true when null byte present', () => {
    expect(isBinaryContent(Buffer.from([72, 101, 0, 108]))).toBe(true);
  });

  it('returns false for empty buffer', () => {
    expect(isBinaryContent(Buffer.alloc(0))).toBe(false);
  });
});

describe('sortEditsDescending', () => {
  it('sorts by line number descending', () => {
    const sorted = sortEditsDescending([
      { action: 'replace', line: 2, content: 'x' },
      { action: 'replace', line: 10, content: 'y' },
      { action: 'replace', line: 5, content: 'z' },
    ]);
    expect(sorted.map((s) => s.affectedLine)).toEqual([10, 5, 2]);
  });

  it('puts append edits last', () => {
    const sorted = sortEditsDescending([
      { action: 'append', content: 'end' },
      { action: 'replace', line: 1, content: 'start' },
    ]);
    expect(sorted[0].action).toBe('replace');
    expect(sorted[1].action).toBe('append');
  });

  it('preserves original order among multiple appends', () => {
    const sorted = sortEditsDescending([
      { action: 'append', content: 'first' },
      { action: 'append', content: 'second' },
      { action: 'append', content: 'third' },
    ]);
    expect(sorted.map((s) => s.original.content)).toEqual(['first', 'second', 'third']);
  });
});

describe('detectConflicts', () => {
  it('returns empty for non-conflicting edits', () => {
    expect(
      detectConflicts([
        { action: 'replace', line: 1 },
        { action: 'replace', line: 2 },
      ]),
    ).toEqual([]);
  });

  it('flags same line targeted by replace and delete', () => {
    const errs = detectConflicts([
      { action: 'replace', line: 5 },
      { action: 'delete', lines: [5, 6] },
    ]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('Line 5');
  });

  it('flags duplicate replace on same line', () => {
    const errs = detectConflicts([
      { action: 'replace', line: 3 },
      { action: 'replace', line: 3 },
    ]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('Line 3');
  });
});

describe('generateDiffSummary', () => {
  it('summarizes replace', () => {
    const s = generateDiffSummary(['old'], [{ action: 'replace', line: 1, content: 'new' }]);
    expect(s).toContain('"old" → "new"');
  });

  it('summarizes delete', () => {
    const s = generateDiffSummary(['a', 'b'], [{ action: 'delete', lines: [2] }]);
    expect(s).toContain('line 2: deleted');
  });

  it('summarizes insert', () => {
    const s = generateDiffSummary(['a', 'b'], [{ action: 'insert', before: 2, content: 'x\ny' }]);
    expect(s).toContain('inserted 2 lines');
  });

  it('summarizes append', () => {
    const s = generateDiffSummary([], [{ action: 'append', content: 'z' }]);
    expect(s).toContain('appended 1 line at end');
  });

  it('says "at beginning of file" when inserting before line 1', () => {
    const s = generateDiffSummary(['a', 'b'], [{ action: 'insert', before: 1, content: 'x' }]);
    expect(s).toContain('at beginning of file');
    expect(s).not.toContain('after line 0');
  });
});

// ── file_read_lines tool ────────────────────────────────────────────

describe('file_read_lines', () => {
  let tools: ReturnType<typeof createFileTools>;
  let tmpDir: string;

  beforeEach(async () => {
    tools = createFileTools();
    const os = await import('node:os');
    const fs = await import('node:fs');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-file-test-'));
  });

  afterEach(async () => {
    const fs = await import('node:fs');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a small file with all lines numbered', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'line1\nline2\nline3\n');

    const result = await tools.file_read_lines.execute!(
      { path: path.join(tmpDir, 'test.txt') },
      {} as any,
    );

    expect(result).not.toHaveProperty('error');
    const r = result as any;
    expect(r.total_lines).toBe(3);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toEqual({ num: 1, content: 'line1' });
    expect(r.lines[2]).toEqual({ num: 3, content: 'line3' });
    expect(r.truncated).toBe(false);
  });

  it('respects offset and limit, sets truncated=true', async () => {
    const fs = await import('node:fs');
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    fs.writeFileSync(path.join(tmpDir, 'big.txt'), lines);

    const result = (await tools.file_read_lines.execute!(
      { path: path.join(tmpDir, 'big.txt'), offset: 5, limit: 3 },
      {} as any,
    )) as any;

    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toEqual({ num: 5, content: 'line5' });
    expect(result.lines[2]).toEqual({ num: 7, content: 'line7' });
    expect(result.truncated).toBe(true);
    expect(result.total_lines).toBe(20);
  });

  it('returns error for nonexistent file', async () => {
    const result = await tools.file_read_lines.execute!(
      { path: path.join(tmpDir, 'nope.txt') },
      {} as any,
    );
    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('not found');
  });

  it('returns error for directory', async () => {
    const result = await tools.file_read_lines.execute!({ path: tmpDir }, {} as any);
    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('directory');
  });

  it('returns error for binary file', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(tmpDir, 'bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x47]));

    const result = await tools.file_read_lines.execute!(
      { path: path.join(tmpDir, 'bin.dat') },
      {} as any,
    );
    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('binary');
  });

  it('handles empty file', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(tmpDir, 'empty.txt'), '');

    const result = (await tools.file_read_lines.execute!(
      { path: path.join(tmpDir, 'empty.txt') },
      {} as any,
    )) as any;

    expect(result.total_lines).toBe(0);
    expect(result.lines).toEqual([]);
  });

  it('handles single line without trailing newline', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(tmpDir, 'one.txt'), 'only line');

    const result = (await tools.file_read_lines.execute!(
      { path: path.join(tmpDir, 'one.txt') },
      {} as any,
    )) as any;

    expect(result.total_lines).toBe(1);
    expect(result.lines).toEqual([{ num: 1, content: 'only line' }]);
  });

  it('returns empty lines array for offset beyond EOF', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(tmpDir, 'short.txt'), 'a\nb\n');

    const result = (await tools.file_read_lines.execute!(
      { path: path.join(tmpDir, 'short.txt'), offset: 100 },
      {} as any,
    )) as any;

    expect(result.total_lines).toBe(2);
    expect(result.lines).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

// ── file_edit_lines tool ────────────────────────────────────────────

describe('file_edit_lines', () => {
  let tools: ReturnType<typeof createFileTools>;
  let tmpDir: string;

  beforeEach(async () => {
    tools = createFileTools();
    const os = await import('node:os');
    const fs = await import('node:fs');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-file-test-'));
  });

  afterEach(async () => {
    const fs = await import('node:fs');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function writeTestFile(name: string, content: string) {
    const fsMod = await import('node:fs');
    const filePath = path.join(tmpDir, name);
    fsMod.writeFileSync(filePath, content);
    return filePath;
  }

  async function readTestFile(name: string): Promise<string> {
    const fsMod = await import('node:fs');
    return fsMod.readFileSync(path.join(tmpDir, name), 'utf-8');
  }

  it('replaces a line', async () => {
    const fp = await writeTestFile('r.txt', 'aaa\nbbb\nccc\n');

    const result = (await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'replace', line: 2, content: 'BBB' }] },
      {} as any,
    )) as any;

    expect(result).not.toHaveProperty('error');
    expect(result.edits_applied).toBe(1);
    expect(await readTestFile('r.txt')).toBe('aaa\nBBB\nccc\n');
    expect(result.old_hash).not.toBe(result.new_hash);
  });

  it('inserts before a line', async () => {
    const fp = await writeTestFile('i.txt', 'aaa\nbbb\nccc\n');

    const result = (await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'insert', before: 2, content: 'NEW' }] },
      {} as any,
    )) as any;

    expect(result).not.toHaveProperty('error');
    expect(await readTestFile('i.txt')).toBe('aaa\nNEW\nbbb\nccc\n');
    expect(result.total_lines).toBe(4);
  });

  it('deletes specific lines', async () => {
    const fp = await writeTestFile('d.txt', 'aaa\nbbb\nccc\nddd\n');

    const result = (await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'delete', lines: [2, 4] }] },
      {} as any,
    )) as any;

    expect(result).not.toHaveProperty('error');
    expect(await readTestFile('d.txt')).toBe('aaa\nccc\n');
    expect(result.total_lines).toBe(2);
  });

  it('appends to end of file', async () => {
    const fp = await writeTestFile('a.txt', 'aaa\nbbb\n');

    const result = (await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'append', content: 'ccc' }] },
      {} as any,
    )) as any;

    expect(result).not.toHaveProperty('error');
    expect(await readTestFile('a.txt')).toBe('aaa\nbbb\nccc\n');
    expect(result.total_lines).toBe(3);
  });

  it('handles multi-line insert', async () => {
    const fp = await writeTestFile('mi.txt', 'aaa\nbbb\n');

    await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'insert', before: 2, content: 'x\ny\nz' }] },
      {} as any,
    );

    expect(await readTestFile('mi.txt')).toBe('aaa\nx\ny\nz\nbbb\n');
  });

  it('handles multi-line append', async () => {
    const fp = await writeTestFile('ma.txt', 'aaa\n');

    await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'append', content: 'b\nc' }] },
      {} as any,
    );

    expect(await readTestFile('ma.txt')).toBe('aaa\nb\nc\n');
  });

  it('applies multiple mixed edits bottom-to-top correctly', async () => {
    const fp = await writeTestFile('mix.txt', 'line1\nline2\nline3\nline4\nline5\n');

    const result = (await tools.file_edit_lines.execute!(
      {
        path: fp,
        edits: [
          { action: 'replace', line: 2, content: 'REPLACED' },
          { action: 'delete', lines: [4] },
          { action: 'append', content: 'END' },
        ],
      },
      {} as any,
    )) as any;

    expect(result).not.toHaveProperty('error');
    expect(result.edits_applied).toBe(3);
    expect(await readTestFile('mix.txt')).toBe('line1\nREPLACED\nline3\nline5\nEND\n');
  });

  it('detects conflicting edits and returns error', async () => {
    const fp = await writeTestFile('conflict.txt', 'aaa\nbbb\nccc\n');

    const result = await tools.file_edit_lines.execute!(
      {
        path: fp,
        edits: [
          { action: 'replace', line: 2, content: 'X' },
          { action: 'delete', lines: [2] },
        ],
      },
      {} as any,
    );

    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('Line 2');
    // File should be unmodified
    expect(await readTestFile('conflict.txt')).toBe('aaa\nbbb\nccc\n');
  });

  it('rejects replace without content', async () => {
    const fp = await writeTestFile('val.txt', 'aaa\n');

    const result = await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'replace', line: 1 }] },
      {} as any,
    );

    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('"content" is required');
  });

  it('rejects out-of-bounds line number', async () => {
    const fp = await writeTestFile('oob.txt', 'aaa\nbbb\n');

    const result = await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'replace', line: 99, content: 'X' }] },
      {} as any,
    );

    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('out of bounds');
  });

  it('returns error for nonexistent file', async () => {
    const result = await tools.file_edit_lines.execute!(
      {
        path: path.join(tmpDir, 'nope.txt'),
        edits: [{ action: 'append', content: 'x' }],
      },
      {} as any,
    );
    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('not found');
  });

  it('hashes differ after edit', async () => {
    const fp = await writeTestFile('hash.txt', 'aaa\n');

    const result = (await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'replace', line: 1, content: 'bbb' }] },
      {} as any,
    )) as any;

    expect(result.old_hash).not.toBe(result.new_hash);
  });

  it('preserves CRLF line endings', async () => {
    const fp = await writeTestFile('crlf.txt', 'aaa\r\nbbb\r\nccc\r\n');

    await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'replace', line: 2, content: 'BBB' }] },
      {} as any,
    );

    expect(await readTestFile('crlf.txt')).toBe('aaa\r\nBBB\r\nccc\r\n');
  });

  it('cleans up temp file after successful write', async () => {
    const fs = await import('node:fs');
    const fp = await writeTestFile('clean.txt', 'aaa\n');

    await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'replace', line: 1, content: 'bbb' }] },
      {} as any,
    );

    // Temp files now use unique names (pid + random suffix), so just verify
    // no .tmp files remain in the directory
    const tmpFiles = fs.readdirSync(tmpDir).filter((f: string) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('handles multi-line replace content correctly', async () => {
    const fp = await writeTestFile('mlr.txt', 'aaa\nbbb\nccc\n');

    const result = (await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'replace', line: 2, content: 'x\ny\nz' }] },
      {} as any,
    )) as any;

    expect(result).not.toHaveProperty('error');
    expect(await readTestFile('mlr.txt')).toBe('aaa\nx\ny\nz\nccc\n');
    expect(result.total_lines).toBe(5);
  });

  it('preserves absence of trailing newline after edit', async () => {
    const fp = await writeTestFile('notrail.txt', 'aaa\nbbb\nccc');

    await tools.file_edit_lines.execute!(
      { path: fp, edits: [{ action: 'replace', line: 2, content: 'BBB' }] },
      {} as any,
    );

    const content = await readTestFile('notrail.txt');
    expect(content).toBe('aaa\nBBB\nccc');
    expect(content.endsWith('\n')).toBe(false);
  });

  it('applies multiple appends in original order', async () => {
    const fp = await writeTestFile('multi-append.txt', 'aaa\n');

    const result = (await tools.file_edit_lines.execute!(
      {
        path: fp,
        edits: [
          { action: 'append', content: 'first' },
          { action: 'append', content: 'second' },
        ],
      },
      {} as any,
    )) as any;

    expect(result).not.toHaveProperty('error');
    expect(await readTestFile('multi-append.txt')).toBe('aaa\nfirst\nsecond\n');
  });
});
