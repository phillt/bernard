import { describe, it, expect } from 'vitest';
import { webManifest, appletIcon, MANIFEST_PATH, ICON_PATH } from './webmanifest.js';
import { APPLET_COLOR_TOKENS } from './tokens.js';
import type { AppManifest } from '../apps/manifest.js';

const app = (over: Partial<AppManifest> = {}): AppManifest =>
  ({ schemaVersion: 2, id: 'notes', name: 'Notes', actions: {}, ...over }) as AppManifest;

describe('webManifest', () => {
  /**
   * The reason it is a route and not a file: a static manifest in the asset
   * directory cannot know its own port, which `HostRegistry` assigns at
   * runtime and stores in `APPLET_HOSTS_FILE`, not beside the page.
   */
  it('names the port this server actually bound', () => {
    expect(webManifest(app(), 45123).start_url).toBe('http://127.0.0.1:45123/');
    expect(webManifest(app(), 45999).start_url).toBe('http://127.0.0.1:45999/');
  });

  it('carries what an installable manifest needs', () => {
    const m = webManifest(app({ description: 'Jot things down' }), 45123);
    expect(m.name).toBe('Notes');
    expect(m.short_name).toBe('Notes');
    expect(m.display).toBe('standalone');
    expect(m.description).toBe('Jot things down');
    expect(Array.isArray(m.icons)).toBe(true);
  });

  it('is themed from the same tokens the applet is styled with', () => {
    const m = webManifest(app(), 45123);
    expect(m.theme_color).toBe(APPLET_COLOR_TOKENS['--accent']);
    expect(m.background_color).toBe(APPLET_COLOR_TOKENS['--bg']);
  });

  it('bounds short_name, which browsers truncate anyway', () => {
    const m = webManifest(app({ name: 'A rather long applet name indeed' }), 1);
    expect((m.short_name as string).length).toBeLessThanOrEqual(12);
  });

  it('lives in the host-reserved namespace so it cannot shadow an applet file', () => {
    expect(MANIFEST_PATH.startsWith('/__bernard/')).toBe(true);
    expect(ICON_PATH.startsWith('/__bernard/')).toBe(true);
  });
});

describe('appletIcon', () => {
  it('is the applet initial on the accent colour', () => {
    const svg = appletIcon('Notes');
    expect(svg).toContain('>N<');
    expect(svg).toContain(APPLET_COLOR_TOKENS['--accent']);
  });

  // The name comes from a manifest a model wrote, and the SVG is served
  // inline — an unescaped `<` would be markup, not a letter.
  it('escapes a name that would otherwise be markup', () => {
    expect(appletIcon('<script>')).toContain('&lt;');
    expect(appletIcon('<script>')).not.toContain('><<');
  });

  it('survives an empty name', () => {
    expect(appletIcon('')).toContain('>?<');
  });
});
