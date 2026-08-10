import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendJsonl, readJsonlTail, rotateJsonlByCount, listFilesByMtime } from './jsonl.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-jsonl-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('appendJsonl', () => {
  it('creates the parent dir and appends one JSONL line per call', () => {
    const file = path.join(dir, 'nested', 'log.jsonl');
    appendJsonl(file, { a: 1 });
    appendJsonl(file, { a: 2 });
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ a: 1 });
    expect(JSON.parse(lines[1])).toEqual({ a: 2 });
  });

  it('never throws when the write fails (parent is a file)', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    // mkdir of `blocker/sub` throws ENOTDIR → swallowed.
    expect(() => appendJsonl(path.join(blocker, 'sub', 'x.jsonl'), { a: 1 })).not.toThrow();
  });
});

describe('readJsonlTail', () => {
  it('returns [] for a missing file', () => {
    expect(readJsonlTail(path.join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('parses all records, tails to `limit`, and skips blank/malformed lines', () => {
    const file = path.join(dir, 'log.jsonl');
    fs.writeFileSync(file, '\n{"i":0}\nnot json{{\n{"i":1}\n\n{"i":2}\n');
    expect(readJsonlTail<{ i: number }>(file).map((r) => r.i)).toEqual([0, 1, 2]);
    expect(readJsonlTail<{ i: number }>(file, 2).map((r) => r.i)).toEqual([1, 2]);
  });
});

describe('rotateJsonlByCount', () => {
  it('trims to the last `keep` lines, no-ops within budget, ignores missing file', () => {
    const file = path.join(dir, 'log.jsonl');
    fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => `{"i":${i}}`).join('\n') + '\n');

    rotateJsonlByCount(file, 3);
    expect(readJsonlTail<{ i: number }>(file).map((r) => r.i)).toEqual([7, 8, 9]);

    // Within budget → unchanged.
    rotateJsonlByCount(file, 10);
    expect(readJsonlTail(file)).toHaveLength(3);

    expect(() => rotateJsonlByCount(path.join(dir, 'nope.jsonl'), 5)).not.toThrow();
  });
});

describe('listFilesByMtime', () => {
  it('lists matching files newest-first, filters by extension, and returns [] for a missing dir', () => {
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    fs.writeFileSync(a, '');
    fs.writeFileSync(b, '');
    fs.writeFileSync(path.join(dir, 'note.txt'), '');
    // Make `b` newer than `a`.
    fs.utimesSync(a, new Date(1000), new Date(1000));
    fs.utimesSync(b, new Date(2000), new Date(2000));

    const listed = listFilesByMtime(dir, '.jsonl');
    expect(listed.map((f) => f.name)).toEqual(['b.jsonl', 'a.jsonl']);
    expect(listed[0].path).toBe(b);

    expect(listFilesByMtime(path.join(dir, 'missing'))).toEqual([]);
  });
});
