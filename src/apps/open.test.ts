import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';
import { canOpenBrowser, browserCommand } from '../open-url.js';

describe('canOpenBrowser', () => {
  /**
   * `openUrl` cannot answer this: it returns true the moment `spawn`
   * succeeds, and `xdg-open` with no display fails asynchronously on
   * `child.on('error')` — long after the caller claimed it opened a window.
   */
  it('is true where a window server is a given', () => {
    expect(canOpenBrowser({}, 'darwin')).toBe(true);
    expect(canOpenBrowser({}, 'win32')).toBe(true);
  });

  it('needs a display on linux, which is what SSH lacks', () => {
    expect(canOpenBrowser({}, 'linux')).toBe(false);
    expect(canOpenBrowser({ DISPLAY: ':0' }, 'linux')).toBe(true);
    expect(canOpenBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(true);
  });

  it('is false where there is no command to run at all', () => {
    expect(browserCommand('x', 'aix')).toBeNull();
    expect(canOpenBrowser({ DISPLAY: ':0' }, 'aix')).toBe(false);
  });
});

describe('openApplet', () => {
  useTempHome('bernard-open-applet');

  it('reports an unknown applet rather than throwing', async () => {
    const { openApplet } = await import('./open.js');
    expect(await openApplet('nope')).toEqual({ error: 'No such app: nope' });
  });

  it('never throws when the host cannot be started', async () => {
    // `startHost` throws when `dist/host/daemon.js` is missing — every
    // `npm run dev` session. Auto-open must not turn a successful create into
    // a failure, so this degrades to a URL and a reason.
    vi.resetModules();
    vi.doMock('../host/client.js', () => ({
      isHostProcessAlive: () => false,
      probeApplet: async () => false,
      startHost: async () => {
        throw new Error('daemon not built');
      },
    }));
    const { AppRegistry } = await import('./registry.js');
    new AppRegistry({ seed: false }).create(
      {
        schemaVersion: 2,
        id: 'app-x',
        name: 'App',
        actions: {
          hello: { dispatch: { kind: 'agent', specialistId: 'web-wrapper', instructions: 'hi' } },
        },
      },
      { 'index.html': '<p>x</p>' },
    );
    const { openApplet } = await import('./open.js');
    const out = await openApplet('app-x');
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.opened).toBe(false);
    expect(out.url).toContain('http://127.0.0.1:');
    expect(out.note).toContain('daemon not built');
    vi.doUnmock('../host/client.js');
  });

  it('waits for the applet to actually be served before opening', async () => {
    // The daemon notices a new manifest via `fs.watch` on a 500 ms debounce,
    // so even a running host is not serving a just-created applet. Opening
    // ahead of that shows a connection error as the user's first impression.
    vi.resetModules();
    let probes = 0;
    vi.doMock('../host/client.js', () => ({
      isHostProcessAlive: () => true,
      probeApplet: async () => ++probes >= 3,
      startHost: async () => true,
    }));
    const opened: string[] = [];
    vi.doMock('../open-url.js', () => ({
      canOpenBrowser: () => true,
      openUrl: (u: string) => {
        opened.push(u);
        return true;
      },
    }));
    const { AppRegistry } = await import('./registry.js');
    new AppRegistry({ seed: false }).create(
      {
        schemaVersion: 2,
        id: 'app-y',
        name: 'App',
        actions: {
          hello: { dispatch: { kind: 'agent', specialistId: 'web-wrapper', instructions: 'hi' } },
        },
      },
      { 'index.html': '<p>y</p>' },
    );
    const { openApplet } = await import('./open.js');
    const out = await openApplet('app-y');
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(opened).toHaveLength(1);
    expect('error' in out ? null : out.opened).toBe(true);
    vi.doUnmock('../host/client.js');
    vi.doUnmock('../open-url.js');
  });

  it('returns the URL without spawning when no browser is reachable', async () => {
    vi.resetModules();
    vi.doMock('../host/client.js', () => ({
      isHostProcessAlive: () => true,
      probeApplet: async () => true,
      startHost: async () => true,
    }));
    let spawned = false;
    vi.doMock('../open-url.js', () => ({
      canOpenBrowser: () => false,
      openUrl: () => {
        spawned = true;
        return true;
      },
    }));
    const { AppRegistry } = await import('./registry.js');
    new AppRegistry({ seed: false }).create(
      {
        schemaVersion: 2,
        id: 'app-z',
        name: 'App',
        actions: {
          hello: { dispatch: { kind: 'agent', specialistId: 'web-wrapper', instructions: 'hi' } },
        },
      },
      { 'index.html': '<p>z</p>' },
    );
    const { openApplet } = await import('./open.js');
    const out = await openApplet('app-z');
    expect(spawned).toBe(false);
    if ('error' in out) return;
    expect(out.opened).toBe(false);
    expect(out.note).toContain('no browser');
    vi.doUnmock('../host/client.js');
    vi.doUnmock('../open-url.js');
  });
});
