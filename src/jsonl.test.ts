import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendJsonl,
  readJsonlTail,
  rotateJsonlByCount,
  listFilesByMtime,
  pruneFilesByMtime,
  pruneFileGroupsByMtime,
} from './jsonl.js';

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

describe('pruneFilesByMtime', () => {
  it('deletes all but the `keep` newest matching files, leaves others, never throws', () => {
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, `s${i}.jsonl`);
      fs.writeFileSync(f, '');
      fs.utimesSync(f, new Date(1000 * (i + 1)), new Date(1000 * (i + 1))); // s4 newest
    }
    const other = path.join(dir, 'keep.txt');
    fs.writeFileSync(other, ''); // non-matching extension → untouched

    pruneFilesByMtime(dir, 2, '.jsonl');

    // Only the 2 newest .jsonl survive; the .txt is left alone.
    expect(
      listFilesByMtime(dir, '.jsonl')
        .map((f) => f.name)
        .sort(),
    ).toEqual(['s3.jsonl', 's4.jsonl']);
    expect(fs.existsSync(other)).toBe(true);

    expect(() => pruneFilesByMtime(path.join(dir, 'missing'), 2, '.jsonl')).not.toThrow();
  });
});

describe('pruneFileGroupsByMtime', () => {
  // A session writes `<id>.jsonl` plus a sidecar per subsystem that needed a
  // descriptor. Ranking those files individually spends several retention
  // slots on one run and orphans sidecars whose transcript was pruned.
  const groupOf = (name: string) => name.match(/^(s\d+)/)?.[1] ?? null;

  function writeAt(name: string, t: number): string {
    const f = path.join(dir, name);
    fs.writeFileSync(f, '');
    fs.utimesSync(f, new Date(1000 * t), new Date(1000 * t));
    return f;
  }

  it('keeps whole groups, ranked by their newest member', () => {
    for (let i = 0; i < 4; i++) {
      writeAt(`s${i}.jsonl`, i + 1);
      writeAt(`s${i}-mcp-stderr.log`, i + 1);
    }
    // s0 has the oldest .jsonl but its sidecar was just appended to. A group
    // ranks by its NEWEST member, so s0 is retained whole — including a
    // transcript that a per-file pass would have pruned out from under it.
    fs.utimesSync(path.join(dir, 's0-mcp-stderr.log'), new Date(99_000), new Date(99_000));

    pruneFileGroupsByMtime(dir, 2, groupOf);

    expect(
      listFilesByMtime(dir)
        .map((f) => f.name)
        .sort(),
    ).toEqual(['s0-mcp-stderr.log', 's0.jsonl', 's3-mcp-stderr.log', 's3.jsonl']);
  });

  it('leaves ungrouped files alone and never throws on a missing dir', () => {
    writeAt('s0.jsonl', 1);
    writeAt('s1.jsonl', 2);
    const foreign = writeAt('not-a-session.txt', 3);

    pruneFileGroupsByMtime(dir, 1, groupOf);

    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(path.join(dir, 's0.jsonl'))).toBe(false);
    expect(() => pruneFileGroupsByMtime(path.join(dir, 'missing'), 1, groupOf)).not.toThrow();
  });
});
