import { describe, it, expect } from 'vitest';
import {
  sanitizeNoticeText,
  sanitizeSourceLabel,
  isMessageFile,
  isInboxMessage,
  isSessionRecord,
  MAX_NOTICE_BYTES,
  MAX_NOTICE_LINES,
  INBOX_POLL_MS,
  DEFAULT_DELIVERY_TIMEOUT_MS,
} from './types.js';

/**
 * The sanitizer is the security-critical part of #462: this is the first path
 * putting text from another process into Ink, which may own the alternate
 * screen buffer.
 */
describe('sanitizeNoticeText', () => {
  it('strips the escape character, and therefore every escape sequence', () => {
    // A CSI clear-screen and an OSC window-title set. Neither can be expressed
    // without ESC, so removing ESC removes the whole class.
    const csi = `before\x1b[2Jafter`;
    const osc = `x\x1b]0;pwned\x07y`;
    expect(sanitizeNoticeText(csi).text).toBe('before[2Jafter');
    expect(sanitizeNoticeText(csi).text).not.toContain('\x1b');
    expect(sanitizeNoticeText(osc).text).not.toContain('\x1b');
    expect(sanitizeNoticeText(osc).text).not.toContain('\x07');
  });

  it('strips carriage returns, tabs and DEL but keeps newlines', () => {
    // A lone \r would let a writer overwrite the line it just printed.
    expect(sanitizeNoticeText('a\rb').text).toBe('ab');
    expect(sanitizeNoticeText('a\tb').text).toBe('ab');
    expect(sanitizeNoticeText('a\x7fb').text).toBe('ab');
    expect(sanitizeNoticeText('one\ntwo').text).toBe('one\ntwo');
  });

  it('keeps ordinary Unicode, which is not a control character', () => {
    expect(sanitizeNoticeText('héllo — 世界 ✉').text).toBe('héllo — 世界 ✉');
  });

  it('caps the line count and reports it', () => {
    const many = Array.from({ length: MAX_NOTICE_LINES + 10 }, (_, i) => `line ${i}`).join('\n');
    const out = sanitizeNoticeText(many);
    expect(out.text.split('\n')).toHaveLength(MAX_NOTICE_LINES);
    expect(out.truncated).toBe(true);
  });

  it('caps the byte length and reports it', () => {
    const out = sanitizeNoticeText('x'.repeat(MAX_NOTICE_BYTES + 100));
    expect(Buffer.byteLength(out.text, 'utf-8')).toBeLessThanOrEqual(MAX_NOTICE_BYTES);
    expect(out.truncated).toBe(true);
  });

  it('reports nothing truncated for an ordinary message', () => {
    expect(sanitizeNoticeText('a short notice')).toEqual({
      text: 'a short notice',
      truncated: false,
    });
  });
});

describe('sanitizeSourceLabel', () => {
  it('flattens to one line and caps the length', () => {
    expect(sanitizeSourceLabel('applet:news\nheadlines')).toBe('applet:news headlines');
    expect(sanitizeSourceLabel('x'.repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it('never yields an empty label', () => {
    expect(sanitizeSourceLabel('')).toBe('unknown');
    expect(sanitizeSourceLabel('\x1b\x07')).toBe('unknown');
  });
});

describe('isMessageFile', () => {
  it('accepts a message and rejects the temp file of an atomic write', () => {
    // `atomicWriteFileSync` writes `<name>.tmp` IN the watched directory, so a
    // looser predicate reads half-written files.
    expect(isMessageFile('1700000000000-abc.json')).toBe(true);
    expect(isMessageFile('1700000000000-abc.json.tmp')).toBe(false);
    expect(isMessageFile('.hidden')).toBe(false);
  });
});

describe('the wire guards', () => {
  const MSG = {
    schemaVersion: 1,
    kind: 'notice',
    sourceKind: 'cli',
    sourceLabel: 'cli',
    text: 'hi',
    sentAt: 1,
  };

  it('accepts a well-formed message and rejects every malformed shape', () => {
    expect(isInboxMessage(MSG)).toBe(true);
    expect(isInboxMessage({ ...MSG, schemaVersion: 2 })).toBe(false);
    expect(isInboxMessage({ ...MSG, kind: 'prompt' })).toBe(false);
    expect(isInboxMessage({ ...MSG, sourceKind: 'made-up' })).toBe(false);
    expect(isInboxMessage({ ...MSG, text: 42 })).toBe(false);
    expect(isInboxMessage(null)).toBe(false);
    expect(isInboxMessage('a string')).toBe(false);
  });

  it('rejects a kind an older binary would not understand', () => {
    // The reason `kind` exists: a later "start a turn" mode must fail here
    // rather than be delivered as a notice.
    expect(isInboxMessage({ ...MSG, kind: 'run' })).toBe(false);
  });

  it('validates a session record', () => {
    const rec = {
      schemaVersion: 1,
      sessionId: 's1',
      pid: 1,
      startedAt: 1,
      cwd: '/x',
      inboxDir: '/x/inbox',
      capabilities: ['notice'],
    };
    expect(isSessionRecord(rec)).toBe(true);
    expect(isSessionRecord({ ...rec, schemaVersion: 9 })).toBe(false);
    expect(isSessionRecord({ ...rec, capabilities: 'notice' })).toBe(false);
  });
});

describe('the timing constants', () => {
  it('gives the sender longer than the watcher sweep', () => {
    // Otherwise a healthy session caught between sweeps is reported as
    // unresponsive.
    expect(DEFAULT_DELIVERY_TIMEOUT_MS).toBeGreaterThan(INBOX_POLL_MS);
  });
});
