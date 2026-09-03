import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveAttachments } from './attachment-args.js';
import { buildTaskUserMessage } from '../framework/agents/user-message.js';

// A 1x1 PNG. `loadImage` sniffs the extension, so the bytes only have to exist.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('resolveAttachments', () => {
  let dir: string;
  let img: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-attach-'));
    img = path.join(dir, 'shot.png');
    fs.writeFileSync(img, PNG);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('yields an empty list for no paths, so nothing changes shape', () => {
    const a = resolveAttachments(undefined);
    const b = resolveAttachments([]);
    expect(a.ok && a.read()).toEqual([]);
    expect(b.ok && b.read()).toEqual([]);
  });

  it('loads a real file into bytes the dispatch can carry', () => {
    const res = resolveAttachments([img]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const loaded = res.read();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].mimeType).toBe('image/png');
      expect(loaded[0].data.equals(PNG)).toBe(true);
    }
  });

  /**
   * Two-phase, and this is the property that matters: a bad path is rejected
   * for microseconds, while up to 40 MB of synchronous reading waits until the
   * caller has cleared its own refusals and taken a pool slot.
   */
  it('validates without reading, so a refused dispatch pays no I/O', () => {
    const res = resolveAttachments([img]);
    expect(res.ok).toBe(true);
    // Deleting the file after validation but before `read()` proves the bytes
    // had not been touched yet.
    fs.rmSync(img);
    if (res.ok) expect(() => res.read()).toThrow();
  });

  // A bad path is a model mistake: request-shaped, fixable, and it must cost
  // nothing — no slot, no dispatch.
  it('reports a missing file as an error rather than throwing', () => {
    const res = resolveAttachments([path.join(dir, 'nope.png')]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeTruthy();
  });

  // The cap is enforced in one place rather than also as a schema `.max()` on
  // four tools, so the message can name the count it actually got. The number
  // is restated here rather than imported, so lowering it silently would fail.
  it('caps the count at four', () => {
    expect(resolveAttachments(new Array(4).fill(img)).ok).toBe(true);
    const res = resolveAttachments(new Array(5).fill(img));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('At most');
  });

  // The end-to-end shape: a resolved attachment becomes a real image part on
  // the seed message a dispatched agent receives.
  it('reaches the dispatched agent as an image part', () => {
    const res = resolveAttachments([img]);
    if (!res.ok) throw new Error('setup');
    const msg = buildTaskUserMessage({ task: 'describe it', attachments: res.read() });
    expect(Array.isArray(msg.content)).toBe(true);
    const parts = msg.content as { type: string }[];
    expect(parts[0].type).toBe('text');
    expect(parts[1].type).toBe('image');
  });

  // The zero-attachment path must stay a plain string — that is what keeps
  // every existing `toEqual({role:'user', content:'Task: …'})` true.
  it('leaves an attachment-free message a plain string', () => {
    expect(buildTaskUserMessage({ task: 'plain' })).toEqual({
      role: 'user',
      content: 'Task: plain',
    });
  });
});
