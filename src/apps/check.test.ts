import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from '../__tests__/temp-home.js';

/**
 * The only check in the tree whose green means a button works.
 *
 * `bernard script` and a source read were what the reviewer had, and between
 * them they cannot see this class at all: the CLI path never reaches the HTTP
 * server, and a static read cannot see a `500`. So when the host started
 * answering every invoke with one, the reviewer ran twice, got `"ok":true`
 * twice, and declared the applet good — which it was. The door was shut.
 *
 * Driven against a REAL server on port 0, because the failure was in what
 * came back over a socket. A unit test of the checker against a stub would
 * assert the shape we already believed we were getting.
 */
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
vi.mock('./invoke.js', async (orig) => {
  const actual = await orig<typeof import('./invoke.js')>();
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

describe('checkServedApplet', () => {
  useTempHome('bernard-check');
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (closers.length) await closers.pop()!();
    vi.clearAllMocks();
  });

  async function serve() {
    vi.resetModules();
    const paths = await import('../paths.js');
    const server = await import('../host/server.js');
    const caps = await import('./capabilities.js');
    const check = await import('./check.js');

    fs.mkdirSync(paths.APPS_DIR, { recursive: true });
    fs.writeFileSync(path.join(paths.APPS_DIR, 'demo.json'), JSON.stringify(APP));
    const dir = paths.appletAssetDir('demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>demo</h1>');

    const app = await server.startApplet({
      appId: 'demo',
      port: 0,
      token: 'tok-1',
      sessionId: 'sess-1',
      capabilities: new caps.CapabilityTable(),
      assetDir: dir,
    });
    closers.push(() => app.close());
    return { app, check };
  }

  const byName = (steps: Array<{ name: string; ok: boolean; detail: string }>, name: string) =>
    steps.find((s) => s.name === name)!;

  it('passes every transport step against a healthy applet', async () => {
    const { app, check } = await serve();
    const steps = await check.checkServedApplet(app.port, ['ask']);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(byName(steps, 'page').detail).toContain('200');
    expect(byName(steps, 'client').detail).toContain('200');
    expect(byName(steps, 'bootstrap').detail).toContain('1 handle');
    // No action named, so nothing ran. The transport half is side-effect free
    // on purpose: it separates a dead host from a dead action before anybody
    // spends a model call finding out which.
    expect(steps.find((s) => s.name === 'invoke')).toBeUndefined();
    expect(mockInvokeAction).not.toHaveBeenCalled();
  });

  it('presses the button when an action is named', async () => {
    const { app, check } = await serve();
    const steps = await check.checkServedApplet(app.port, ['ask'], {
      action: 'ask',
      args: { q: 'hi' },
    });
    expect(byName(steps, 'invoke').ok).toBe(true);
    expect(mockInvokeAction).toHaveBeenCalledTimes(1);
    // Through the real door: the args reached the dispatcher, which means the
    // token, the guard, the handle and the capability record all held.
    expect(mockInvokeAction.mock.calls[0][0].args).toEqual({ q: 'hi' });
  });

  /**
   * The regression. This is the exact failure the reviewer approved through.
   */
  it('FAILS when invoke answers 500, and says why', async () => {
    const { app, check } = await serve();
    mockInvokeAction.mockRejectedValueOnce(
      new Error("The requested module './paths.js' does not provide an export named 'X'"),
    );
    const steps = await check.checkServedApplet(app.port, ['ask'], {
      action: 'ask',
      args: { q: 'hi' },
    });
    const invoke = byName(steps, 'invoke');
    expect(invoke.ok).toBe(false);
    expect(invoke.detail).toContain('500');
    // The reason survives all the way to the reviewer's terminal. Without
    // this it reads as a bare failure and the next move is a guess.
    expect(invoke.detail).toContain('does not provide an export');
    // Every transport step still passed, which is the diagnosis: the host is
    // up and serving, and only the dispatch route is broken.
    expect(byName(steps, 'page').ok).toBe(true);
    expect(byName(steps, 'bootstrap').ok).toBe(true);
  });

  it('fails when the action reports a failure of its own', async () => {
    const { app, check } = await serve();
    mockInvokeAction.mockResolvedValueOnce({
      schemaVersion: 1,
      ok: false,
      invocationId: 'inv-2',
      app: 'demo',
      action: 'ask',
      durationMs: 3,
      error: { code: 'run_failed', category: 'unknown', message: 'the wrapper blew up' },
    });
    const steps = await check.checkServedApplet(app.port, ['ask'], { action: 'ask' });
    const invoke = byName(steps, 'invoke');
    expect(invoke.ok).toBe(false);
    expect(invoke.detail).toContain('run_failed');
    expect(invoke.detail).toContain('the wrapper blew up');
  });

  it('reports an action with no minted handle rather than inventing one', async () => {
    const { app, check } = await serve();
    const steps = await check.checkServedApplet(app.port, ['ask'], { action: 'nope' });
    expect(byName(steps, 'invoke').ok).toBe(false);
    expect(byName(steps, 'invoke').detail).toContain('nope');
    expect(mockInvokeAction).not.toHaveBeenCalled();
  });

  it('notices a manifest action the bootstrap minted no handle for', async () => {
    // A handle per declared action is what makes every button reachable. A
    // missing one is a control that can never fire, and it is invisible in
    // the page source.
    const { app, check } = await serve();
    const steps = await check.checkServedApplet(app.port, ['ask', 'ghost']);
    expect(byName(steps, 'bootstrap').ok).toBe(false);
    expect(byName(steps, 'bootstrap').detail).toContain('ghost');
  });

  it('treats a non-JSON body as a finding, not a pass', async () => {
    // What the host used to send on a crash. The served client calls
    // `res.json()` on every reply, so a text body is a reply the page could
    // not have read either — the check must not be more tolerant than the
    // thing it stands in for.
    vi.resetModules();
    const check = await import('./check.js');
    const bare = http.createServer((req, res) => {
      if (req.url === '/__bernard/bootstrap.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: 't', handles: { ask: 'h' } }));
        return;
      }
      if (req.url === '/__bernard/invoke') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('ok');
    });
    await new Promise<void>((r) => bare.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => bare.close(() => r())));
    const port = (bare.address() as { port: number }).port;

    const steps = await check.checkServedApplet(port, ['ask'], { action: 'ask' });
    const invoke = byName(steps, 'invoke');
    expect(invoke.ok).toBe(false);
    expect(invoke.detail).toContain('not JSON');
    expect(invoke.detail).toContain('Internal Server Error');
  });

  it('reports a dead port rather than throwing', async () => {
    vi.resetModules();
    const check = await import('./check.js');
    // Nothing is listening. Every step should fail with a readable reason and
    // the function must still return — the reviewer reads a verdict, and an
    // exception is not one.
    const steps = await check.checkServedApplet(1, ['ask'], { action: 'ask' });
    expect(steps.every((s) => !s.ok)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
  });
});
