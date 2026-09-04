import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { useTempHome } from '../__tests__/temp-home.js';

/**
 * A raw request, because `fetch` cannot forge `Host`.
 *
 * `Host` is a forbidden header name — undici silently drops any override and
 * sends the real authority. A rebinding test written with `fetch` therefore
 * asserts nothing at all: it passes because the request was legitimate, not
 * because the guard worked. `node:http` sends what it is given.
 */
function rawGet(
  port: number,
  reqPath: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method: 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** {@link rawGet}, but the headers are what is being asserted. */
function rawGetHeaders(
  port: number,
  reqPath: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method: 'GET', headers },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const mockInvokeAction = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    schemaVersion: 1,
    ok: true,
    invocationId: 'inv-1',
    app: 'demo',
    action: 'ask',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 5,
    result: 'the answer',
    meta: { specialistId: 'web-wrapper', stepLimitHit: false, mcpConnectMs: 0 },
  }),
);
vi.mock('../apps/invoke.js', async (orig) => {
  const actual = await orig<typeof import('../apps/invoke.js')>();
  return { ...actual, invokeAction: mockInvokeAction };
});

const APP = {
  schemaVersion: 1,
  id: 'demo',
  name: 'Demo',
  actions: {
    ask: {
      instructions: 'Answer.',
      specialistId: 'web-wrapper',
      args: { q: { type: 'string', required: true } },
    },
  },
};

/**
 * The first tests in this repo to bind a port.
 *
 * Port `0` is non-negotiable rather than stylistic: two concurrent `vitest`
 * runs on one machine would collide on any fixed port, which is the same class
 * of problem the run-scoped temp root (#319) solved for directories.
 */
describe('applet server', () => {
  useTempHome('bernard-host');
  const running: Array<{ close: () => Promise<void> }> = [];

  async function load() {
    vi.resetModules();
    const paths = await import('../paths.js');
    const server = await import('./server.js');
    const webmanifest = await import('./webmanifest.js');
    const tokens = await import('./tokens.js');
    const sdk = await import('./sdk.js');
    const caps = await import('../apps/capabilities.js');
    return { ...server, ...caps, ...paths, ...webmanifest, ...tokens, ...sdk };
  }

  function writeApp(m: typeof import('../paths.js'), appId = 'demo', body: unknown = APP): string {
    fs.mkdirSync(m.APPS_DIR, { recursive: true });
    fs.writeFileSync(path.join(m.APPS_DIR, `${appId}.json`), JSON.stringify(body));
    const dir = m.appletAssetDir(appId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), `<h1>${appId}</h1>`);
    return dir;
  }

  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    while (running.length) await running.pop()!.close();
  });

  async function start(m: Awaited<ReturnType<typeof load>>, appId = 'demo', token = 'tok-1') {
    const capabilities = new m.CapabilityTable();
    const app = await m.startApplet({
      appId,
      port: 0,
      token,
      sessionId: 'sess-1',
      capabilities,
      assetDir: m.appletAssetDir(appId),
    });
    running.push(app);
    return { app, capabilities };
  }

  const hostHeaders = (port: number) => ({ Host: `127.0.0.1:${port}` });

  /**
   * #463's stated acceptance criterion, and the one nothing else would catch.
   *
   * A brief holds what the user said about their own workflow. It lives in
   * `APPLET_BRIEFS_DIR` — a directory the server has no handle on — rather
   * than beside the manifest, so this is asserted structurally rather than
   * relying on `isContainedIn`'s sibling-prefix rule. Driven over a real
   * socket because that is the only thing that proves it.
   */
  it('never serves an applet its own design brief', async () => {
    const m = await load();
    writeApp(m);
    const { AppletBriefStore } = await import('../apps/brief-store.js');
    new AppletBriefStore().write('demo', { note: 'a private note about the user' });
    // The brief must actually exist, or every 404 below is a 404 about
    // nothing and the whole test passes vacuously.
    const briefFile = path.join(AppletBriefStore.briefsDir, 'demo.json');
    expect(fs.readFileSync(briefFile, 'utf-8')).toContain('a private note about the user');
    // Structural, not derived: the briefs directory is not under the served
    // root at all, so no containment rule has to hold for this to be safe.
    expect(AppletBriefStore.briefsDir.startsWith(m.appletAssetDir('demo'))).toBe(false);
    expect(AppletBriefStore.briefsDir.startsWith(m.APPS_DIR)).toBe(false);
    const { app } = await start(m);

    const escapes = [
      '/demo.json',
      '/../demo.json',
      '/..%2fdemo.json',
      '/%2e%2e%2fdemo.json',
      '/../applet-briefs/demo.json',
      '/../../applet-briefs/demo.json',
      '/%2e%2e%2f%2e%2e%2fapplet-briefs%2fdemo.json',
      '/demo.notes.md',
    ];
    for (const p of escapes) {
      const res = await fetch(`${app.origin}${p}`, { headers: hostHeaders(app.port) });
      const body = await res.text();
      expect(res.status, `${p} was served`).not.toBe(200);
      expect(body).not.toContain('a private note about the user');
    }
  });

  it('serves the applet index from its own loopback origin', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    expect(app.origin).toBe(`http://127.0.0.1:${app.port}`);
    const res = await fetch(app.origin, { headers: hostHeaders(app.port) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('demo');
  });

  it('sends the CSP, including the two directives connect-src does not cover', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await fetch(app.origin, { headers: hostHeaders(app.port) });
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("form-action 'none'");
    // `allow-same-origin` is REQUIRED, not forbidden — see csp.ts. Without it
    // the document is opaque-origin: no localStorage, `Origin: null`, and
    // `connect-src 'self'` matching nothing.
    expect(csp).toContain('sandbox allow-scripts allow-same-origin');
  });

  /** Two applets, two origins — the acceptance criterion for storage isolation. */
  it('gives two applets distinct origins', async () => {
    const m = await load();
    writeApp(m, 'demo');
    writeApp(m, 'other', { ...APP, id: 'other' });
    const a = await start(m, 'demo');
    const b = await start(m, 'other');
    expect(a.app.origin).not.toBe(b.app.origin);
    const res = await fetch(b.app.origin, { headers: hostHeaders(b.app.port) });
    expect(await res.text()).toContain('other');
  });

  /** The rebinding shape: a real socket, a genuinely forged Host header. */
  it('rejects a request whose Host names somewhere else', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await rawGet(app.port, '/', { Host: 'evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('rejects `localhost` on the right port — it resolves through the system resolver', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await rawGet(app.port, '/', { Host: `localhost:${app.port}` });
    expect(res.status).toBe(403);
  });

  it('serves when the forged Host happens to be the correct one', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await rawGet(app.port, '/', { Host: `127.0.0.1:${app.port}` });
    expect(res.status).toBe(200);
  });

  it('mints one handle per declared action at serve time', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await fetch(`${app.origin}/__bernard/bootstrap.json`, {
      headers: hostHeaders(app.port),
    });
    const body = (await res.json()) as { handles: Record<string, string>; token: string };
    expect(Object.keys(body.handles)).toEqual(['ask']);
    expect(body.token).toBe('tok-1');
  });

  it('dispatches an invoke that presents a valid handle', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const boot = (await (
      await fetch(`${app.origin}/__bernard/bootstrap.json`, { headers: hostHeaders(app.port) })
    ).json()) as { handles: Record<string, string> };

    const res = await fetch(`${app.origin}/__bernard/invoke`, {
      method: 'POST',
      headers: {
        ...hostHeaders(app.port),
        Origin: app.origin,
        'Content-Type': 'application/json',
        'x-bernard-token': 'tok-1',
      },
      body: JSON.stringify({ handle: boot.handles.ask, args: { q: 'hi' } }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: string }).result).toBe('the answer');
    expect(mockInvokeAction).toHaveBeenCalledTimes(1);
    // The action came from the RECORD, never from the request body.
    expect(mockInvokeAction.mock.calls[0][0].action).toBe('ask');
  });

  it('refuses an invoke with no token', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await fetch(`${app.origin}/__bernard/invoke`, {
      method: 'POST',
      headers: { ...hostHeaders(app.port), Origin: app.origin },
      body: JSON.stringify({ handle: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(mockInvokeAction).not.toHaveBeenCalled();
  });

  /**
   * The residual risk `applet-sandbox.md` §3 names by hand, asserted over a
   * real socket: a handle minted for one applet, presented to another.
   */
  it("refuses another applet's handle even with a valid token", async () => {
    const m = await load();
    writeApp(m, 'demo');
    writeApp(m, 'other', { ...APP, id: 'other' });
    const a = await start(m, 'demo', 'tok-a');
    const b = await start(m, 'other', 'tok-b');

    const stolen = a.capabilities.mint({ appId: 'demo', action: 'ask', sessionId: 'sess-1' });
    // Present it to `other`, whose table is the one that will be consulted.
    b.capabilities.mint({ appId: 'other', action: 'ask', sessionId: 'sess-1' });

    const res = await fetch(`${b.app.origin}/__bernard/invoke`, {
      method: 'POST',
      headers: {
        ...hostHeaders(b.app.port),
        Origin: b.app.origin,
        'Content-Type': 'application/json',
        'x-bernard-token': 'tok-b',
      },
      body: JSON.stringify({ handle: stolen, args: { q: 'hi' } }),
    });
    expect(res.status).toBe(403);
    expect(mockInvokeAction).not.toHaveBeenCalled();
  });

  it('refuses a traversal out of the asset directory', async () => {
    const m = await load();
    writeApp(m);
    fs.writeFileSync(path.join(m.APPS_DIR, 'demo.json.secret'), 'SECRET');
    const { app } = await start(m);
    const res = await fetch(`${app.origin}/..%2fdemo.json.secret`, {
      headers: hostHeaders(app.port),
    });
    expect(res.status).toBe(404);
  });

  it('answers a health probe, which is what liveness keys on', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await fetch(`${app.origin}/__bernard/health`, { headers: hostHeaders(app.port) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { appId: string }).appId).toBe('demo');
  });

  /**
   * The store endpoint (#422). A `GET` read route would have been reachable by
   * anything that can satisfy the origin checks, because the guard exempts
   * `GET`/`HEAD` from the token so that an asset read works before the page
   * holds one. Applet data is not an asset.
   */
  it('gates the store behind the token, reads included', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);

    const noToken = await fetch(`${app.origin}${m.STORE_PATH}`, {
      method: 'POST',
      headers: { ...hostHeaders(app.port), 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'get', key: 'k' }),
    });
    expect(noToken.status).toBe(403);

    // A GET is not an alternative door: the route only answers POST.
    const asGet = await fetch(`${app.origin}${m.STORE_PATH}`, { headers: hostHeaders(app.port) });
    expect(asGet.status).toBe(405);
  });

  it('round-trips a value through the store endpoint', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const call = async (body: unknown) =>
      (
        await fetch(`${app.origin}${m.STORE_PATH}`, {
          method: 'POST',
          headers: {
            ...hostHeaders(app.port),
            'Content-Type': 'application/json',
            'x-bernard-token': 'tok-1',
          },
          body: JSON.stringify(body),
        })
      ).json();

    expect(await call({ op: 'set', key: 'draft', value: { text: 'hi' } })).toMatchObject({
      ok: true,
    });
    expect(await call({ op: 'get', key: 'draft' })).toMatchObject({
      ok: true,
      result: { key: 'draft', value: { text: 'hi' } },
    });

    const { closeAppletStore } = await import('./store-route.js');
    closeAppletStore('demo');
  });

  // #429. Whether a browser OFFERS install is unverified — the `sandbox`
  // header may refuse a top-level install and is not being relaxed on a guess
  // — but serving a correct manifest is the half that can be checked here.
  it('serves a web app manifest naming its own port', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await fetch(`${app.origin}${m.MANIFEST_PATH}`, { headers: hostHeaders(app.port) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/manifest+json');
    const body = (await res.json()) as { start_url: string; icons: unknown[] };
    expect(body.start_url).toBe(`http://127.0.0.1:${app.port}/`);
    expect(body.icons.length).toBeGreaterThan(0);
  });

  it('serves the icon the manifest points at', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await fetch(`${app.origin}${m.ICON_PATH}`, { headers: hostHeaders(app.port) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
  });

  // Without `manifest-src` the link falls through to `default-src 'none'` and
  // the manifest is never fetched, so install cannot even be offered.
  it('permits the manifest in its own CSP', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await fetch(app.origin, { headers: hostHeaders(app.port) });
    expect(res.headers.get('content-security-policy')).toContain("manifest-src 'self'");
  });

  it('serves the applet client, and with a MIME the browser will execute', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await fetch(`${app.origin}${m.SDK_PATH}`, { headers: hostHeaders(app.port) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('window.bernard');

    // Pinned against `contentTypeFor` rather than a literal. `nosniff` is on
    // every response, so a Content-Type the browser does not accept as script
    // means it silently declines to execute — no error, no console entry, just
    // a page where `bernard` is undefined. The two must not drift.
    const { contentTypeFor } = await import('./assets.js');
    expect(res.headers.get('content-type')).toBe(contentTypeFor('a.js'));
  });

  it('serves the client without a token, because a page cannot have one yet', async () => {
    // The guard gates on METHOD, not path: a GET needs no token, which is what
    // lets a page load its own client before it holds anything.
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await fetch(`${app.origin}${m.SDK_PATH}`, { headers: hostHeaders(app.port) });
    expect(res.status).toBe(200);
  });

  it('serves the shared token stylesheet', async () => {
    const m = await load();
    writeApp(m);
    const { app } = await start(m);
    const res = await fetch(`${app.origin}${m.TOKENS_PATH}`, { headers: hostHeaders(app.port) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  /**
   * Per-applet CSP grants (#467, #468).
   *
   * Over a real socket rather than against `cspFor`, because the property
   * being asserted is that the grant reaches the wire for THIS applet and no
   * other, which is a fact about the handler rather than about the builder.
   */
  describe('per-applet CSP grants', () => {
    async function grant(m: Awaited<ReturnType<typeof load>>, appId: string, value: unknown) {
      const store = await import('../apps/app-csp-grants.js');
      store.saveAppCspGrant(appId, value as never);
    }
    const cspOf = (res: Response) => res.headers.get('content-security-policy') ?? '';

    it('serves a granted origin in the applet own header', async () => {
      const m = await load();
      writeApp(m);
      await grant(m, 'demo', { imgSrc: ['https://cdn.example.com'] });
      const { app } = await start(m);
      const res = await fetch(app.origin, { headers: hostHeaders(app.port) });
      expect(cspOf(res)).toContain("img-src 'self' data: https://cdn.example.com");
      expect(cspOf(res)).toContain("connect-src 'self';");
    });

    it('does not leak one applet grant into another', async () => {
      // The assertion the whole per-app design rests on. Two servers, one
      // grant; the ungranted one must be byte-identical to the baseline.
      const m = await load();
      writeApp(m, 'demo');
      writeApp(m, 'other', { ...APP, id: 'other' });
      await grant(m, 'demo', { imgSrc: ['https://cdn.example.com'] });
      const granted = await start(m, 'demo', 'tok-1');
      const plain = await start(m, 'other', 'tok-2');

      const a = await fetch(granted.app.origin, { headers: hostHeaders(granted.app.port) });
      const b = await fetch(plain.app.origin, { headers: hostHeaders(plain.app.port) });
      expect(cspOf(a)).toContain('https://cdn.example.com');
      expect(cspOf(b)).not.toContain('cdn.example.com');
      expect(cspOf(b)).toContain("img-src 'self' data:;");
    });

    it('applies a revoke on the next request, with no restart', async () => {
      // Why the grant is read per request rather than captured at startApplet:
      // the same running server must narrow again the moment the user revokes.
      const m = await load();
      writeApp(m);
      await grant(m, 'demo', { imgSrc: ['https://cdn.example.com'] });
      const { app } = await start(m);
      const before = await fetch(app.origin, { headers: hostHeaders(app.port) });
      expect(cspOf(before)).toContain('https://cdn.example.com');

      await grant(m, 'demo', {});
      const after = await fetch(app.origin, { headers: hostHeaders(app.port) });
      expect(cspOf(after)).not.toContain('cdn.example.com');
    });

    it('appends a sandbox grant without dropping the base pair', async () => {
      const m = await load();
      writeApp(m);
      await grant(m, 'demo', { sandbox: ['links'] });
      const { app } = await start(m);
      const res = await fetch(app.origin, { headers: hostHeaders(app.port) });
      expect(cspOf(res)).toContain(
        'sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
      );
    });

    it('carries the CSP on a guard refusal too', async () => {
      // The refusal path resolves the same policy as every other response —
      // one policy per applet, rather than two that have to agree.
      const m = await load();
      writeApp(m);
      const { app } = await start(m);
      const res = await rawGetHeaders(app.port, '/', { Host: `localhost:${app.port}` });
      expect(res.status).toBe(403);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    });

    it('serves the ungranted header when the profile cannot be read', async () => {
      // A corrupt profile must degrade to the narrow policy, never take the
      // applet down.
      const m = await load();
      writeApp(m);
      await grant(m, 'demo', { imgSrc: ['https://cdn.example.com'] });
      fs.writeFileSync(m.PROFILES_PATH, '{ not json');
      const { app } = await start(m);
      const res = await fetch(app.origin, { headers: hostHeaders(app.port) });
      expect(res.status).toBe(200);
      expect(cspOf(res)).not.toContain('cdn.example.com');
      expect(cspOf(res)).toContain("img-src 'self' data:;");
    });
  });

  /**
   * The blocked-request channel (#467).
   *
   * A page reports what the browser refused so a denied applet stops being
   * silently broken. Recorded, never acted on.
   */
  describe('violation reports', () => {
    it('records a report the page posts with its token', async () => {
      const m = await load();
      writeApp(m);
      const { app } = await start(m);
      const violations = await import('./violations.js');
      const res = await fetch(`${app.origin}/__bernard/violation`, {
        method: 'POST',
        headers: {
          ...hostHeaders(app.port),
          'content-type': 'application/json',
          'x-bernard-token': 'tok-1',
        },
        body: JSON.stringify({ directive: 'img-src', blockedURL: 'https://cdn.example.com/x.png' }),
      });
      expect(res.status).toBe(200);
      expect(violations.loadBlocked('demo')).toEqual([
        expect.objectContaining({ directive: 'imgSrc', origin: 'https://cdn.example.com' }),
      ]);
    });

    it('refuses a report with no token, like every other state-changing route', async () => {
      // The reason this is a POST the PAGE makes rather than a CSP report-uri:
      // a browser-generated report carries no headers, so accepting one would
      // mean exempting a path from the token check.
      const m = await load();
      writeApp(m);
      const { app } = await start(m);
      const res = await fetch(`${app.origin}/__bernard/violation`, {
        method: 'POST',
        headers: { ...hostHeaders(app.port), 'content-type': 'application/json' },
        body: JSON.stringify({ directive: 'img-src', blockedURL: 'https://cdn.example.com/x.png' }),
      });
      expect(res.status).toBe(403);
    });
  });
});
