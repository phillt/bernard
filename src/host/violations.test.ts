import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';
import { blockedFromReport, MAX_BLOCKS_PER_APP } from './violations.js';

async function load() {
  vi.resetModules();
  return await import('./violations.js');
}

describe('blockedFromReport', () => {
  it('reduces a report to the grant that would fix it', () => {
    expect(
      blockedFromReport({
        directive: 'img-src',
        blockedURL: 'https://cdn.example.com/a/b.png?x=1',
      }),
    ).toEqual({ directive: 'imgSrc', origin: 'https://cdn.example.com' });
  });

  it('keeps a non-default port, which is part of the origin', () => {
    expect(
      blockedFromReport({ directive: 'connect-src', blockedURL: 'http://127.0.0.1:11434/api' }),
    ).toEqual({ directive: 'connectSrc', origin: 'http://127.0.0.1:11434' });
  });

  it('drops anything a grant could not fix', () => {
    // The surface this feeds offers a one-keystroke grant, so an entry that
    // cannot be granted would be an offer that does nothing.
    expect(
      blockedFromReport({ directive: 'script-src', blockedURL: 'https://a.example' }),
    ).toBeNull();
    expect(
      blockedFromReport({ directive: 'default-src', blockedURL: 'https://a.example' }),
    ).toBeNull();
    expect(
      blockedFromReport({ directive: 'img-src', blockedURL: 'data:image/png;base64,AAA' }),
    ).toBeNull();
    expect(blockedFromReport({ directive: 'img-src', blockedURL: 'not a url' })).toBeNull();
    expect(blockedFromReport(null)).toBeNull();
    expect(blockedFromReport({ directive: 'img-src' })).toBeNull();
  });
});

describe('the blocked-request record', () => {
  useTempHome('bernard-violations');

  it('counts repeats rather than appending them', async () => {
    // The page controls how often it reports; a log would grow without bound
    // and "14 times, last 2 minutes ago" is the useful form anyway.
    const m = await load();
    for (let i = 0; i < 14; i++) {
      m.recordBlocked('news', {
        directive: 'img-src',
        blockedURL: 'https://cdn.example.com/x.png',
      });
    }
    const rows = m.loadBlocked('news');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      directive: 'imgSrc',
      origin: 'https://cdn.example.com',
      count: 14,
    });
  });

  it('ignores a report it could never grant', async () => {
    const m = await load();
    m.recordBlocked('news', { directive: 'script-src', blockedURL: 'https://evil.example' });
    m.recordBlocked('news', { directive: 'img-src', blockedURL: 'javascript:alert(1)' });
    expect(m.loadBlocked('news')).toEqual([]);
  });

  it('caps what one applet can accumulate', async () => {
    // The applet chooses what to report, so the bound has to be ours.
    const m = await load();
    for (let i = 0; i < MAX_BLOCKS_PER_APP + 10; i++) {
      m.recordBlocked('news', { directive: 'img-src', blockedURL: `https://h${i}.example/x.png` });
    }
    expect(m.loadBlocked('news').length).toBeLessThanOrEqual(MAX_BLOCKS_PER_APP);
  });

  it('keeps applets separate and forgets on request', async () => {
    const m = await load();
    m.recordBlocked('news', { directive: 'img-src', blockedURL: 'https://a.example/x.png' });
    m.recordBlocked('other', { directive: 'img-src', blockedURL: 'https://b.example/x.png' });
    expect(m.loadBlocked('other')).toHaveLength(1);
    m.clearBlocked('news');
    expect(m.loadBlocked('news')).toEqual([]);
    expect(m.loadBlocked('other')).toHaveLength(1);
  });

  it('reads nothing rather than throwing on a corrupt file', async () => {
    const m = await load();
    const fs = await import('node:fs');
    const { APPLET_BLOCKS_FILE } = await import('../paths.js');
    fs.mkdirSync(APPLET_BLOCKS_FILE.replace(/\/[^/]+$/, ''), { recursive: true });
    fs.writeFileSync(APPLET_BLOCKS_FILE, '{ not json');
    expect(m.loadBlocked('news')).toEqual([]);
    // And still records afterwards rather than staying broken.
    m.recordBlocked('news', { directive: 'img-src', blockedURL: 'https://a.example/x.png' });
    expect(m.loadBlocked('news')).toHaveLength(1);
  });
});
