import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveAsset, contentTypeFor } from './assets.js';

describe('resolveAsset', () => {
  let root: string;
  let assets: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-assets-')));
    assets = path.join(root, 'app');
    outside = path.join(root, 'outside');
    fs.mkdirSync(assets, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(assets, 'index.html'), '<h1>hi</h1>');
    fs.writeFileSync(path.join(assets, 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('serves index.html for the root path', () => {
    const res = resolveAsset(assets, '/');
    expect(res.ok).toBe(true);
    if (res.ok) expect(path.basename(res.absPath)).toBe('index.html');
  });

  it('serves a named file with its content type', () => {
    const res = resolveAsset(assets, '/app.js');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.contentType).toBe('text/javascript; charset=utf-8');
  });

  it('ignores query and fragment', () => {
    expect(resolveAsset(assets, '/app.js?v=2#top').ok).toBe(true);
  });

  it('refuses a plain .. traversal', () => {
    expect(resolveAsset(assets, '/../outside/secret.txt').ok).toBe(false);
  });

  // A containment check that runs before decoding is a check that can be
  // walked straight past: %2e%2e%2f is ../.
  it('refuses a percent-encoded traversal', () => {
    expect(resolveAsset(assets, '/%2e%2e%2foutside%2fsecret.txt').ok).toBe(false);
    expect(resolveAsset(assets, '/..%2foutside%2fsecret.txt').ok).toBe(false);
  });

  it('refuses malformed percent-encoding rather than throwing', () => {
    expect(resolveAsset(assets, '/%ZZ').ok).toBe(false);
  });

  // A NUL truncates the path for some syscalls while surviving string checks.
  it('refuses a NUL byte in the path', () => {
    expect(resolveAsset(assets, '/index.html\0.js').ok).toBe(false);
  });

  /**
   * The bytes served are agent-generated, so a symlink inside the asset
   * directory is as trustworthy as the model that wrote it. `write-scope`'s
   * `resolveForComparison` resolves the nearest existing ancestor, which is
   * what catches this.
   */
  it('refuses a symlink that escapes the asset directory', () => {
    const link = path.join(assets, 'escape');
    try {
      fs.symlinkSync(outside, link, 'dir');
    } catch {
      return; // symlinks unavailable — skip
    }
    expect(resolveAsset(assets, '/escape/secret.txt').ok).toBe(false);
  });

  // A bare `startsWith` accepts this; #340's `isContainedIn` is separator-aware.
  it('refuses a sibling directory sharing the name prefix', () => {
    const evil = `${assets}-evil`;
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'x.txt'), 'nope');
    expect(resolveAsset(assets, '/../app-evil/x.txt').ok).toBe(false);
  });

  it('404s a missing file', () => {
    expect(resolveAsset(assets, '/nope.txt').ok).toBe(false);
  });

  // Distinguishing "outside the root" from "not there" tells a prober which
  // paths exist.
  it('reports every refusal as 404, never 403', () => {
    for (const p of ['/../outside/secret.txt', '/nope.txt', '/%ZZ']) {
      const res = resolveAsset(assets, p);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(404);
    }
  });

  it('refuses a non-regular file', () => {
    const fifo = path.join(assets, 'pipe');
    try {
      // mkfifo is not available through node:fs; a directory without an index
      // exercises the same branch.
      fs.mkdirSync(fifo);
    } catch {
      return;
    }
    expect(resolveAsset(assets, '/pipe').ok).toBe(false);
  });
});

describe('contentTypeFor', () => {
  it('maps known extensions', () => {
    expect(contentTypeFor('/a/b.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('/a/b.CSS')).toBe('text/css; charset=utf-8');
  });

  /**
   * An unknown extension downloads rather than executes. With `nosniff`, a
   * file the applet author did not anticipate cannot be coerced into running
   * as script.
   */
  it('falls back to octet-stream for anything unrecognised', () => {
    expect(contentTypeFor('/a/b.wasm')).toBe('application/octet-stream');
    expect(contentTypeFor('/a/noext')).toBe('application/octet-stream');
  });
});
