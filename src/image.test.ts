import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreMessage } from 'ai';
import {
  detectMimeType,
  loadImage,
  tryLoadImage,
  extractImagePaths,
  isVisionCapableModel,
  stripImagesFromHistory,
  estimateContentPartTokens,
  IMAGE_TOKEN_ESTIMATE,
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

/* ---------- tryLoadImage ---------- */
describe('tryLoadImage', () => {
  it('returns null for non-existent file', () => {
    expect(tryLoadImage('/tmp/definitely-not-a-real-file.png')).toBeNull();
  });

  it('returns null for unsupported extension', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-try-'));
    const txtPath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(txtPath, 'hello');

    expect(tryLoadImage(txtPath)).toBeNull();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ImageAttachment for valid file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-try-'));
    const imgPath = path.join(tmpDir, 'ok.png');
    fs.writeFileSync(imgPath, Buffer.from('data'));

    const result = tryLoadImage(imgPath);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe('image/png');

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
