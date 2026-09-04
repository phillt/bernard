import { describe, it, expect } from 'vitest';
import { pendingPermissions, grantWith, notAskedLine } from './permission-consent.js';
import type { AppPermissions } from './manifest.js';

const ASK: AppPermissions = {
  imgSrc: {
    origins: ['https://a.example', 'https://b.example'],
    reason: 'so headlines have thumbnails',
  },
  sandbox: { tokens: ['links'], reason: 'so you can open a story' },
};

describe('pendingPermissions', () => {
  it('describes an ask in terms of what the applet does, not the directive', () => {
    const [img] = pendingPermissions(ASK, null);
    expect(img.label).toBe('Show images from 2 sites');
    expect(img.detail).toBe('https://a.example, https://b.example');
    expect(img.reason).toBe('so headlines have thumbnails');
  });

  it('says nothing when nothing was declared', () => {
    expect(pendingPermissions(undefined, null)).toEqual([]);
  });

  it('drops an ask that is already granted', () => {
    // Re-running an update must not re-ask a question the user answered.
    const pending = pendingPermissions(ASK, {
      imgSrc: ['https://a.example', 'https://b.example'],
      sandbox: ['allow-popups', 'allow-popups-to-escape-sandbox'],
    });
    expect(pending).toEqual([]);
  });

  it('keeps a partially granted ask, listing only what is missing', () => {
    const [img] = pendingPermissions(ASK, { imgSrc: ['https://a.example'] });
    expect(img.sources).toEqual(['https://b.example']);
    expect(img.label).toBe('Show images from 1 site');
  });

  it('summarises a long origin list rather than printing all of it', () => {
    const many = Array.from({ length: 6 }, (_, i) => `https://h${i}.example`);
    const [img] = pendingPermissions({ imgSrc: { origins: many } }, null);
    expect(img.detail).toBe('https://h0.example, https://h1.example, https://h2.example, +3 more');
  });

  it('routes a two-way channel to its own screen', () => {
    // connect-src can send the applet data out; img-src pulls a picture in.
    const [conn] = pendingPermissions({ connectSrc: { origins: ['https://api.example'] } }, null);
    expect(conn.ownScreen).toBe(true);
    const [img] = pendingPermissions({ imgSrc: { origins: ['https://a.example'] } }, null);
    expect(img.ownScreen).toBe(false);
  });

  it('routes a whole-scheme wildcard to its own screen even for images', () => {
    const [img] = pendingPermissions({ imgSrc: { origins: ['https:'] } }, null);
    expect(img.ownScreen).toBe(true);
  });

  it('labels the popup pair as one capability', () => {
    const [sandbox] = pendingPermissions({ sandbox: { tokens: ['links'] } }, null);
    expect(sandbox.label).toBe('Open links in your browser');
    expect(sandbox.tokens).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox']);
  });
});

describe('grantWith', () => {
  it('adds only what was allowed, leaving the rest ungranted', () => {
    const pending = pendingPermissions(ASK, null);
    const next = grantWith(null, [pending[0]]);
    expect(next.imgSrc).toEqual(['https://a.example', 'https://b.example']);
    expect(next.sandbox).toBeUndefined();
  });

  it('never withdraws a grant already held', () => {
    // The prompt only shows what is outstanding, so answering one ask must
    // not silently drop an unrelated one.
    const next = grantWith({ connectSrc: ['https://api.example'] }, pendingPermissions(ASK, null));
    expect(next.connectSrc).toEqual(['https://api.example']);
    expect(next.imgSrc).toHaveLength(2);
  });

  it('is a no-op when nothing was allowed', () => {
    expect(grantWith({ imgSrc: ['https://a.example'] }, [])).toEqual({
      imgSrc: ['https://a.example'],
    });
  });
});

describe('notAskedLine', () => {
  it('is derived from the ask, so it cannot go stale', () => {
    // An applet that later asks for a network channel must stop being
    // described as one that did not.
    expect(
      notAskedLine(pendingPermissions({ imgSrc: { origins: ['https://a.example'] } }, null)),
    ).toBe('It did not ask to: send data out, read your files, run commands.');
    expect(
      notAskedLine(pendingPermissions({ connectSrc: { origins: ['https://a.example'] } }, null)),
    ).not.toContain('send data out');
  });
});
