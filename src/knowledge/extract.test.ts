import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractFile,
  isFailure,
  isIngestable,
  modeFor,
  resolvePdfReader,
  walkIngestable,
  PDF_MISSING_MESSAGE,
  SKIP_DIRECTORIES,
} from './extract.js';

let root: string;
const write = (rel: string, body: string): string => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
  return full;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-extract-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('classification', () => {
  it.each(['a.md', 'a.txt', 'a.rst'])('reads %s as prose', (f) => {
    expect(isIngestable(f)).toBe(true);
    expect(modeFor(f)).toBe('prose');
  });

  it.each(['a.ts', 'a.py', 'a.rs', 'a.sh'])('reads %s as code', (f) => {
    expect(modeFor(f)).toBe('code');
  });

  it.each(['a.json', 'a.yaml', 'a.toml'])('reads %s as code too', (f) => {
    // Not code, but it shares the property that decides the mode: no sentences,
    // and a line is a meaningful unit.
    expect(modeFor(f)).toBe('code');
  });

  it.each(['a.png', 'a.zip', 'a.so', 'noextension'])('refuses %s', (f) => {
    expect(isIngestable(f)).toBe(false);
  });
});

describe('extractFile', () => {
  it('reads markdown and records the mtime as publishedAt', () => {
    const p = write('doc.md', '# Title\n\nBody text.\n');
    const out = extractFile(p);
    expect(isFailure(out)).toBe(false);
    if (isFailure(out)) return;
    expect(out.text).toContain('Body text.');
    expect(out.mode).toBe('prose');
    expect(out.kind).toBe('file');
    // The file's own mtime, never invented — a guessed date is worse than none.
    expect(Date.parse(out.publishedAt!)).toBeGreaterThan(0);
  });

  it('normalises CRLF so offsets and the hash agree with the chunker', () => {
    const p = write('crlf.md', 'alpha\r\n\r\nbeta\r\n');
    const out = extractFile(p);
    if (isFailure(out)) throw new Error(out.reason);
    expect(out.text).not.toContain('\r');
  });

  it('converts HTML through the same pipeline web_read uses', () => {
    const p = write(
      'page.html',
      '<html><head><title>T</title></head><body><nav>skip</nav><p>Kept.</p></body></html>',
    );
    const out = extractFile(p);
    if (isFailure(out)) throw new Error(out.reason);
    expect(out.title).toBe('T');
    expect(out.text).toContain('Kept.');
    // The strip list is shared rather than copied, so chrome is dropped here
    // for the same reason it is dropped in web_read.
    expect(out.text).not.toContain('skip');
  });

  it('reports a missing file rather than throwing', () => {
    // A directory ingest meets unreadable files routinely, and one of them must
    // not abort the other 199.
    const out = extractFile(path.join(root, 'nope.md'));
    expect(isFailure(out)).toBe(true);
  });

  it('refuses a file with no reader, naming the extension', () => {
    const out = extractFile(write('image.png', 'not really a png'));
    expect(isFailure(out) && out.reason).toContain('.png');
  });

  it('refuses a file over the size limit rather than reading it', () => {
    const out = extractFile(write('big.md', 'x'.repeat(500)), { maxBytes: 100 });
    expect(isFailure(out) && out.reason).toContain('exceeds');
  });

  it('refuses a directory handed to it as a file', () => {
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    expect(isFailure(extractFile(path.join(root, 'sub')))).toBe(true);
  });
});

describe('PDF', () => {
  it('resolves pdftotext when it is on PATH', () => {
    expect(resolvePdfReader(() => true)).toBe('pdftotext');
  });

  it('says what to install when it is not', () => {
    // The probe is injected for the reason voice-service.ts injects its own: a
    // test that shells out to `which` measures the machine it runs on, so this
    // path would be untestable anywhere Poppler happens to be installed.
    expect(resolvePdfReader(() => false)).toBeNull();
    const out = extractFile(write('doc.pdf', '%PDF-1.4'), { pdfProbe: () => false });
    expect(isFailure(out) && out.reason).toBe(PDF_MISSING_MESSAGE);
    expect(PDF_MISSING_MESSAGE).toContain('poppler');
  });
});

describe('walkIngestable', () => {
  it('finds ingestable files and skips the rest', () => {
    write('a.md', 'a');
    write('b.ts', 'b');
    write('c.png', 'c');
    expect(walkIngestable(root).map((f) => path.basename(f))).toEqual(['a.md', 'b.ts']);
  });

  it('descends into subdirectories', () => {
    write('deep/nested/x.md', 'x');
    expect(walkIngestable(root)).toHaveLength(1);
  });

  it('skips node_modules and friends', () => {
    // node_modules is routinely two orders of magnitude larger than the project
    // it sits in, so without this `bernard knowledge add ./` reads as a hang.
    for (const dir of SKIP_DIRECTORIES) write(`${dir}/x.md`, 'x');
    write('keep.md', 'k');
    expect(walkIngestable(root).map((f) => path.basename(f))).toEqual(['keep.md']);
  });

  it('skips dotfile directories', () => {
    write('.hidden/x.md', 'x');
    expect(walkIngestable(root)).toEqual([]);
  });

  it('does not follow symlinks', () => {
    // Following one can leave the root the user named, and a cycle turns the
    // walk into a hang.
    write('real/x.md', 'x');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir');
    expect(walkIngestable(root)).toHaveLength(1);
  });

  it('stops at the limit rather than reading a whole disk', () => {
    for (let i = 0; i < 20; i++) write(`f${i}.md`, 'x');
    expect(walkIngestable(root, 5)).toHaveLength(5);
  });

  it('returns nothing for a directory that is not there', () => {
    expect(walkIngestable(path.join(root, 'missing'))).toEqual([]);
  });
});
