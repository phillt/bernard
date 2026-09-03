import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveAttachments, MAX_DISPATCH_ATTACHMENTS } from './attachment-args.js';
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

  it('returns undefined for no paths, so nothing changes shape', () => {
    expect(resolveAttachments(undefined)).toEqual({ ok: true, attachments: undefined });
    expect(resolveAttachments([])).toEqual({ ok: true, attachments: undefined });
  });

  it('loads a real file into bytes the dispatch can carry', () => {
    const res = resolveAttachments([img]);
    expect(res.ok).toBe(true);
    if (res.ok && res.attachments) {
      expect(res.attachments).toHaveLength(1);
      expect(res.attachments[0].mimeType).toBe('image/png');
      expect(res.attachments[0].data.equals(PNG)).toBe(true);
    }
  });

  // A bad path is a model mistake: request-shaped, fixable, and it must cost
  // nothing — no slot, no dispatch.
  it('reports a missing file as an error rather than throwing', () => {
    const res = resolveAttachments([path.join(dir, 'nope.png')]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeTruthy();
  });

  it('caps the count', () => {
    const res = resolveAttachments(new Array(MAX_DISPATCH_ATTACHMENTS + 1).fill(img));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('At most');
  });

  // The end-to-end shape: a resolved attachment becomes a real image part on
  // the seed message a dispatched agent receives.
  it('reaches the dispatched agent as an image part', () => {
    const res = resolveAttachments([img]);
    if (!res.ok) throw new Error('setup');
    const msg = buildTaskUserMessage({ task: 'describe it', attachments: res.attachments });
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
