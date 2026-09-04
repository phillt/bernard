import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from '../__tests__/temp-home.js';

async function load() {
  vi.resetModules();
  const paths = await import('../paths.js');
  return {
    ...(await import('./lifecycle.js')),
    ...(await import('./registry.js')),
    ...(await import('./app-grants.js')),
    ...(await import('./app-csp-grants.js')),
    specialists: await import('../specialists.js'),
    store: await import('./store.js'),
    paths,
  };
}

const MANIFEST = (id: string) => ({
  schemaVersion: 2,
  id,
  name: 'Notes',
  actions: {
    go: { dispatch: { kind: 'tool', tool: 'web_search', args: { query: 'x' } } },
  },
});

describe('applet authoring', () => {
  useTempHome('bernard-applet-lifecycle');

  it('writes a manifest and its page together', async () => {
    const m = await load();
    const r = new m.AppRegistry({ seed: false });
    const created = r.create(MANIFEST('notes'), { 'index.html': '<h1>Notes</h1>' });
    expect(created.id).toBe('notes');
    expect(r.listIds()).toContain('notes');
    expect(fs.readFileSync(path.join(m.paths.appletAssetDir('notes'), 'index.html'), 'utf-8')).toBe(
      '<h1>Notes</h1>',
    );
  });

  // A manifest with no page serves a 404; the two are one artifact.
  it('refuses a manifest with no page', async () => {
    const m = await load();
    expect(() => new m.AppRegistry({ seed: false }).create(MANIFEST('notes'), {})).toThrow(
      /index\.html/,
    );
  });

  /**
   * The trap the write side exists to avoid: `AppManifestSchema` LIFTS a v1
   * action into `dispatch`, so validating with the reader's schema and then
   * serializing the result produces a manifest its own `schemaVersion`
   * refinement rejects. The written bytes must round-trip.
   */
  it('writes a manifest that reads back and can be written again', async () => {
    const m = await load();
    const r = new m.AppRegistry({ seed: false });
    r.create(MANIFEST('notes'), { 'index.html': 'x' });
    const read = r.get('notes');
    expect(read.ok).toBe(true);
    const raw = JSON.parse(
      fs.readFileSync(path.join(m.paths.APPS_DIR, 'notes.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(() => r.update('notes', raw)).not.toThrow();
  });

  // Model-authored keys reach this. `resolveAsset` refuses traversal on the
  // way out; this refuses it on the way in, where it would land beside the
  // sibling manifests in APPS_DIR.
  it('refuses a file name that escapes the applet directory', async () => {
    const m = await load();
    const r = new m.AppRegistry({ seed: false });
    expect(() =>
      r.create(MANIFEST('notes'), { 'index.html': 'x', '../evil.json': 'nope' }),
    ).toThrow(/valid applet file name/);
    expect(fs.existsSync(path.join(m.paths.APPS_DIR, 'evil.json'))).toBe(false);
  });

  it('refuses a duplicate id', async () => {
    const m = await load();
    const r = new m.AppRegistry({ seed: false });
    r.create(MANIFEST('notes'), { 'index.html': 'x' });
    expect(() => r.create(MANIFEST('notes'), { 'index.html': 'y' })).toThrow(/already exists/);
  });
});

describe('deleteApplet', () => {
  useTempHome('bernard-applet-delete');

  it('sweeps every store keyed by the app id', async () => {
    const m = await load();
    const r = new m.AppRegistry({ seed: false });
    r.create(MANIFEST('notes'), { 'index.html': 'x' });

    // Populate the other stores.
    m.saveAppGrants('notes', [{ effect: 'deny', tool: 'web_read', _v: 2 }]);
    m.saveAppCspGrant('notes', { imgSrc: ['https://cdn.example.com'] });
    new m.store.AppletStore('notes').set('k', 'v');
    fs.mkdirSync(m.paths.runWorkspace('apps', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(m.paths.runWorkspace('apps', 'notes'), 'out.txt'), 'work');
    const specialists = new m.specialists.SpecialistStore({ seed: false });
    specialists.createFull({
      id: 'notes-agent',
      name: 'Notes Agent',
      description: 'd',
      systemPrompt: 'p',
      boundTo: { appId: 'notes', action: 'go' },
    });

    const result = m.deleteApplet('notes');

    expect(result.deleted).toBe(true);
    expect(result.boundSpecialists).toEqual(['notes-agent']);
    expect(r.listIds()).not.toContain('notes');
    expect(fs.existsSync(m.paths.appletAssetDir('notes'))).toBe(false);
    expect(fs.existsSync(m.paths.appletDataDir('notes'))).toBe(false);
    expect(fs.existsSync(m.paths.runWorkspace('apps', 'notes'))).toBe(false);
    expect(m.loadAppGrants('notes')).toBeNull();
    // A leftover origin grant would hand a re-added applet of the same id
    // external access the user granted to a different one.
    expect(m.loadAppCspGrant('notes')).toBeNull();
    expect(specialists.get('notes-agent')).toBeUndefined();
  });

  /**
   * `HostRegistry` has deliberately no `release`: a re-added applet gets its
   * origin back, and with it the browser storage that origin still holds.
   * Deletion must not undo that.
   */
  it('keeps the port assignment', async () => {
    const m = await load();
    const { HostRegistry } = await import('../host/registry.js');
    const r = new m.AppRegistry({ seed: false });
    r.create(MANIFEST('notes'), { 'index.html': 'x' });
    const before = new HostRegistry().recordFor('notes').port;
    m.deleteApplet('notes');
    expect(new HostRegistry().recordFor('notes').port).toBe(before);
  });

  it('leaves an unrelated app and its bound specialist alone', async () => {
    const m = await load();
    const r = new m.AppRegistry({ seed: false });
    r.create(MANIFEST('notes'), { 'index.html': 'x' });
    r.create(MANIFEST('todo'), { 'index.html': 'y' });
    const specialists = new m.specialists.SpecialistStore({ seed: false });
    specialists.createFull({
      id: 'todo-agent',
      name: 'Todo Agent',
      description: 'd',
      systemPrompt: 'p',
      boundTo: { appId: 'todo', action: 'go' },
    });
    m.deleteApplet('notes');
    expect(r.listIds()).toContain('todo');
    expect(specialists.get('todo-agent')).toBeDefined();
  });

  it('reports a missing app rather than throwing', async () => {
    const m = await load();
    expect(m.deleteApplet('nope')).toEqual({ deleted: false, boundSpecialists: [] });
  });
});
