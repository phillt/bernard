import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreMessage } from 'ai';
import {
  IMAGE_TOKEN_ESTIMATE,
  MAX_PATH_WORDS,
  detectMimeType,
  estimateContentPartTokens,
  extractImagePathGroups,
  extractImagePaths,
  isVisionCapableModel,
  loadImage,
  loadImageResult,
  stripImagePaths,
  stripImagesFromHistory,
} from './image.js';

/* ---------- detectMimeType ---------- */
describe('detectMimeType', () => {
  it.each([
    ['/path/to/file.png', 'image/png'],
    ['/path/to/file.PNG', 'image/png'],
    ['/path/to/file.jpg', 'image/jpeg'],
    ['/path/to/file.jpeg', 'image/jpeg'],
    ['/path/to/file.gif', 'image/gif'],
    ['/path/to/file.webp', 'image/webp'],
  ])('returns correct MIME for %s', (filePath, expected) => {
    expect(detectMimeType(filePath)).toBe(expected);
  });

  it.each(['/path/to/file.bmp', '/path/to/file.pdf', '/path/to/file.ts', '/path/to/file.txt'])(
    'returns null for unsupported %s',
    (filePath) => {
      expect(detectMimeType(filePath)).toBeNull();
    },
  );
});

/* ---------- loadImage ---------- */
describe('loadImage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-image-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid PNG file', () => {
    const imgPath = path.join(tmpDir, 'test.png');
    const content = Buffer.from('fake-png-content');
    fs.writeFileSync(imgPath, content);

    const result = loadImage(imgPath);
    expect(result.path).toBe(imgPath);
    expect(result.mimeType).toBe('image/png');
    expect(result.data).toEqual(content);
  });

  it('loads a valid JPEG file', () => {
    const imgPath = path.join(tmpDir, 'photo.jpg');
    const content = Buffer.from('fake-jpeg-content');
    fs.writeFileSync(imgPath, content);

    const result = loadImage(imgPath);
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('throws for non-existent file', () => {
    expect(() => loadImage('/tmp/definitely-not-a-real-file.png')).toThrow('Image file not found');
  });

  it('throws for a directory', () => {
    expect(() => loadImage(tmpDir)).toThrow('Path is a directory');
  });

  it('throws for unsupported extension', () => {
    const txtPath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(txtPath, 'hello');

    expect(() => loadImage(txtPath)).toThrow('Unsupported image format');
  });

  it('throws for oversized file', () => {
    const imgPath = path.join(tmpDir, 'big.png');
    // Create a file just over 10MB by writing a sparse-ish buffer
    const bigBuffer = Buffer.alloc(10 * 1024 * 1024 + 1);
    fs.writeFileSync(imgPath, bigBuffer);

    expect(() => loadImage(imgPath)).toThrow('too large');
  });

  it('expands ~ in paths', () => {
    // We can't easily test ~ expansion with a real file, but we can verify
    // the error message shows the expanded path (not ~)
    expect(() => loadImage('~/definitely-not-real.png')).toThrow(os.homedir());
  });
});

/* ---------- loadImageResult ---------- */
describe('loadImageResult', () => {
  // Replaces `tryLoadImage`, whose empty catch discarded the reason. A user who
  // pasted a path and got nothing had no way to tell a missing file from an
  // unsupported format — and the reason already existed, composed by
  // `validateImagePath` one frame down.
  it('reports why a missing file could not load', () => {
    const res = loadImageResult('/tmp/definitely-not-a-real-file.png');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // The path is in the reason itself — `validateImagePath` composes it — so
    // a separate field had no reader and is gone.
    expect(res.failure.reason).toMatch(/not found/i);
    expect(res.failure.reason).toContain('definitely-not-a-real-file.png');
  });

  it('reports an unsupported extension as such, not as missing', () => {
    // The distinction that makes the message worth showing at all.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-try-'));
    const txtPath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(txtPath, 'hello');

    const res = loadImageResult(txtPath);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.reason).toMatch(/unsupported/i);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the attachment for a valid file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-try-'));
    const imgPath = path.join(tmpDir, 'ok.png');
    fs.writeFileSync(imgPath, Buffer.from('data'));

    const res = loadImageResult(imgPath);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.image.mimeType).toBe('image/png');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

/* ---------- extractImagePaths ---------- */
describe('extractImagePaths', () => {
  it('finds absolute paths', () => {
    const result = extractImagePaths('look at /tmp/screenshot.png please');
    expect(result).toEqual(['/tmp/screenshot.png']);
  });

  it('finds home-dir paths and expands ~', () => {
    const result = extractImagePaths('describe ~/photos/cat.jpg');
    expect(result).toEqual([path.join(os.homedir(), 'photos', 'cat.jpg')]);
    expect(result[0]).not.toBe('/photos/cat.jpg');
  });

  it('finds relative paths', () => {
    const result = extractImagePaths('check ./images/logo.webp');
    expect(result).toEqual(['./images/logo.webp']);
  });

  it('finds multiple images', () => {
    const result = extractImagePaths('compare /tmp/a.png and /tmp/b.jpeg');
    expect(result).toEqual(['/tmp/a.png', '/tmp/b.jpeg']);
  });

  it('handles double-quoted paths', () => {
    const result = extractImagePaths('look at "/tmp/my file.png" please');
    expect(result).toEqual(['/tmp/my file.png']);
  });

  it('handles single-quoted paths', () => {
    const result = extractImagePaths("check '/tmp/my file.jpg' now");
    expect(result).toEqual(['/tmp/my file.jpg']);
  });

  it('returns empty array when no images found', () => {
    expect(extractImagePaths('just a normal message')).toEqual([]);
  });

  it('ignores non-image extensions', () => {
    expect(extractImagePaths('edit /tmp/code.ts and /tmp/data.json')).toEqual([]);
  });

  it('handles case-insensitive extensions', () => {
    const result = extractImagePaths('look at /tmp/photo.PNG');
    expect(result).toEqual(['/tmp/photo.PNG']);
  });
});

/* ---------- stripImagePaths ---------- */
describe('stripImagePaths', () => {
  it('removes absolute image paths and collapses whitespace', () => {
    expect(stripImagePaths('here is the screenshot /home/user/pics/a.png please look')).toBe(
      'here is the screenshot please look',
    );
  });

  it('removes quoted image paths', () => {
    expect(stripImagePaths('check "/tmp/my file.jpg" now')).toBe('check now');
  });

  it('removes multiple image paths in one message', () => {
    expect(stripImagePaths('compare /tmp/a.png and /tmp/b.jpeg side by side')).toBe(
      'compare and side by side',
    );
  });

  it('leaves non-image text unchanged (aside from whitespace trim)', () => {
    expect(stripImagePaths('just a normal message')).toBe('just a normal message');
  });

  it('does not touch non-image file extensions', () => {
    expect(stripImagePaths('edit /tmp/code.ts and /tmp/data.json')).toBe(
      'edit /tmp/code.ts and /tmp/data.json',
    );
  });

  it('returns empty string when input is only an image path', () => {
    expect(stripImagePaths('/tmp/screenshot.png')).toBe('');
  });
});

/* ---------- isVisionCapableModel ---------- */
describe('isVisionCapableModel', () => {
  it('returns true for all Anthropic models', () => {
    expect(isVisionCapableModel('anthropic', 'claude-sonnet-4-5-20250929')).toBe(true);
    expect(isVisionCapableModel('anthropic', 'claude-haiku-4-5-20251001')).toBe(true);
  });

  it('returns true for OpenAI vision models', () => {
    expect(isVisionCapableModel('openai', 'gpt-4o')).toBe(true);
    expect(isVisionCapableModel('openai', 'gpt-4o-mini')).toBe(true);
    expect(isVisionCapableModel('openai', 'gpt-4.1')).toBe(true);
    expect(isVisionCapableModel('openai', 'gpt-4.1-mini')).toBe(true);
    expect(isVisionCapableModel('openai', 'gpt-5.2')).toBe(true);
    expect(isVisionCapableModel('openai', 'o3')).toBe(true);
    expect(isVisionCapableModel('openai', 'o4-mini')).toBe(true);
  });

  it('returns false for OpenAI text-only models', () => {
    expect(isVisionCapableModel('openai', 'gpt-3.5-turbo')).toBe(false);
  });

  it('returns true for xAI vision models', () => {
    expect(isVisionCapableModel('xai', 'grok-2-vision-1212')).toBe(true);
    expect(isVisionCapableModel('xai', 'grok-2-vision-latest')).toBe(true);
    expect(isVisionCapableModel('xai', 'grok-4-fast-non-reasoning')).toBe(true);
  });

  it('returns false for xAI text-only models', () => {
    expect(isVisionCapableModel('xai', 'grok-3')).toBe(false);
    expect(isVisionCapableModel('xai', 'grok-3-mini')).toBe(false);
  });

  it('returns true for unknown providers (optimistic)', () => {
    expect(isVisionCapableModel('custom', 'some-model')).toBe(true);
  });
});

/* ---------- estimateContentPartTokens ---------- */
describe('estimateContentPartTokens', () => {
  it('returns IMAGE_TOKEN_ESTIMATE for image parts', () => {
    const part = { type: 'image', image: Buffer.from('data'), mimeType: 'image/png' };
    expect(estimateContentPartTokens(part)).toBe(IMAGE_TOKEN_ESTIMATE);
  });

  it('returns text-based estimate for text parts', () => {
    const part = { type: 'text', text: 'hello world' };
    const tokens = estimateContentPartTokens(part);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(Math.ceil('hello world'.length / 3.6));
  });

  it('returns same estimate regardless of image size', () => {
    const small = { type: 'image', image: Buffer.alloc(100), mimeType: 'image/png' };
    const large = { type: 'image', image: Buffer.alloc(5_000_000), mimeType: 'image/png' };
    expect(estimateContentPartTokens(small)).toBe(estimateContentPartTokens(large));
  });

  it('returns flat estimate for file parts', () => {
    const part = { type: 'file', data: Buffer.alloc(2_000_000), mimeType: 'application/pdf' };
    expect(estimateContentPartTokens(part)).toBe(IMAGE_TOKEN_ESTIMATE);
  });
});

/* ---------- stripImagesFromHistory ---------- */
describe('stripImagesFromHistory', () => {
  it('replaces ImagePart entries with text placeholders', () => {
    const history: CoreMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image', image: Buffer.from('png-data'), mimeType: 'image/png' },
        ],
      },
    ];

    const stripped = stripImagesFromHistory(history);
    expect(stripped[0].content).toEqual([
      { type: 'text', text: 'Describe this' },
      { type: 'text', text: '[Image attached]' },
    ]);
  });

  it('leaves string content unchanged', () => {
    const history: CoreMessage[] = [{ role: 'user', content: 'hello' }];
    const stripped = stripImagesFromHistory(history);
    expect(stripped[0].content).toBe('hello');
  });

  it('leaves non-user messages unchanged', () => {
    const history: CoreMessage[] = [{ role: 'assistant', content: 'response' }];
    const stripped = stripImagesFromHistory(history);
    expect(stripped[0]).toBe(history[0]);
  });

  it('does not mutate the original array', () => {
    const original: CoreMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'test' },
          { type: 'image', image: Buffer.from('data'), mimeType: 'image/png' },
        ],
      },
    ];

    const originalContent = original[0].content;
    stripImagesFromHistory(original);
    expect(original[0].content).toBe(originalContent);
  });

  it('preserves messages with no image parts', () => {
    const history: CoreMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'just text' },
          { type: 'text', text: 'more text' },
        ],
      },
    ];

    const stripped = stripImagesFromHistory(history);
    expect(stripped[0]).toBe(history[0]); // same reference — no change needed
  });
});

describe('an unquoted path containing a space', () => {
  // The reported failure: two scans pasted as
  // `/home/me/Documents/photos/business cards/Scan_1.jpg` attached nothing.
  // `IMAGE_PATH_RE`'s unquoted branch has no space in its character class, so
  // it matched only `cards/Scan_1.jpg` — a relative path that does not exist —
  // and the load failed silently. Existing coverage tested spaces ONLY inside
  // quotes, so the paste-a-path case, which is how this is actually used, was
  // untested.
  it('offers the whole path as a candidate', () => {
    const got = extractImagePaths('rename /home/me/photos/business cards/Scan_1.jpg please');
    expect(got).toContain('/home/me/photos/business cards/Scan_1.jpg');
  });

  it('offers it for each of several paths on one line', () => {
    const got = extractImagePaths(
      'files /a/b c/one.jpg and /a/b c/two.jpg (same card, front and back)',
    );
    expect(got).toContain('/a/b c/one.jpg');
    expect(got).toContain('/a/b c/two.jpg');
  });

  it('does not widen a match that is already a whole path', () => {
    // Widening an anchored match can only produce candidates that cannot
    // resolve — `look at /tmp/a.png` is not a file. Restricting it to
    // unanchored matches is what keeps the output clean for the common case.
    expect(extractImagePaths('look at /tmp/screenshot.png')).toEqual(['/tmp/screenshot.png']);
    expect(extractImagePaths('see ./images/logo.webp')).toEqual(['./images/logo.webp']);
  });

  it('offers nothing that resolves for ordinary prose', () => {
    // The reason this over-offers instead of widening the regex: no pattern can
    // tell a directory name from a preceding word, but the filesystem can. Every
    // candidate here is a guess, and every one of them fails to exist.
    const got = extractImagePaths('read /etc/hosts and check foo.png');
    expect(got.some((p) => fs.existsSync(p))).toBe(false);
  });

  it('stops widening at a newline', () => {
    // A path does not span lines. `lastIndexOf(' ')` walked straight through
    // one, which is why the scan is hand-rolled.
    expect(extractImagePaths('first line\nsecond cards/x.png')).toEqual([
      'cards/x.png',
      'second cards/x.png',
    ]);
  });

  it('bounds how far back it walks', () => {
    // Without a bound, a sentence ending in `.png` offers one candidate per
    // word. The previous assertion here was `length <= 7` against an input that
    // stops at a newline after ONE word — it passed for any bound, so it tested
    // nothing. This input has eight preceding words and actually reaches it.
    const got = extractImagePaths('one two three four five six seven eight cards/x.png');
    expect(got).toHaveLength(1 + MAX_PATH_WORDS);
  });

  it('never offers the same candidate twice', () => {
    const got = extractImagePaths('a/b.png and a/b.png');
    expect(new Set(got).size).toBe(got.length);
  });
});

describe('candidate groups', () => {
  it('groups each match, narrowest first, so a caller can pick one per path', () => {
    // A flat list cannot express "one attachment per path": a caller iterating
    // it attaches every candidate that happens to exist, and the narrowest is a
    // bare tail resolved against the cwd.
    const groups = extractImagePathGroups('files /a/b c/one.jpg and /a/b c/two.jpg');
    expect(groups).toHaveLength(2);
    expect(groups[0][0]).toBe('c/one.jpg');
    expect(groups[0]).toContain('/a/b c/one.jpg');
    expect(groups[1]).toContain('/a/b c/two.jpg');
  });

  it('flattens to what extractImagePaths returns', () => {
    const text = 'see /tmp/a.png and cards/b.jpg';
    expect(extractImagePathGroups(text).flat()).toEqual(extractImagePaths(text));
  });
});

describe('stripImagePaths keeps step with the extractor', () => {
  it('removes a widened path whole, leaving no dangling fragment', () => {
    // They were a matched pair keyed on one regex. Widening only the extractor
    // left "rename /home/me/photos/business cards/S.jpg" stripping to
    // "rename /home/me/photos/business" — a half-path handed to the reference
    // resolver, which is what this function exists to prevent.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-strip-'));
    const sub = path.join(dir, 'business cards');
    fs.mkdirSync(sub);
    const img = path.join(sub, 'S.jpg');
    fs.writeFileSync(img, Buffer.from('x'));

    expect(stripImagePaths(`rename ${img} please`)).toBe('rename please');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not eat prose around a path that does not exist', () => {
    // Only candidates that EXIST are removed, matching the attach decision.
    // The widest candidate deliberately includes preceding words, so stripping
    // it unconditionally turned "rename … please" into "please".
    expect(stripImagePaths('rename /nope/business cards/S.jpg please')).toContain('rename');
  });
});
