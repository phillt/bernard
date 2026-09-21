import * as http from 'node:http';
import { AppRegistry } from './registry.js';
import { HostRegistry } from '../host/registry.js';
import { startHost, probeApplet } from '../host/client.js';

/**
 * Pressing an applet's button the way a browser does (#applet-staleness).
 *
 * The reviewer verified with `bernard script`, whose own prompt already
 * conceded the gap: that is a CLI path, so it never reaches the HTTP server,
 * never presents a token, and never runs one line of the page's JavaScript.
 * It compensated with a static source read — and a static read cannot see a
 * `500`, so when the host began answering every invoke with one, the reviewer
 * ran twice, got `"ok":true` twice, and declared the applet good. The applet
 * WAS good. The door was shut, and nothing was looking at the door.
 *
 * So this goes through the real origin: the assigned port, the served client,
 * the bootstrap handshake, and — when a caller names an action — a real
 * `POST /__bernard/invoke` carrying a real token against a real handle. That
 * is the only check in the tree whose green means a button works.
 *
 * `node:http` with `agent: false`, never `fetch`: undici's global keep-alive
 * pool holds the event loop open, which is why `probeApplet` is written this
 * way and why `bernard applet-host start` once printed its output and hung.
 */

/** Cap on any one request. Generous: an agent-backed action can be slow. */
const DEFAULT_TIMEOUT_MS = 200_000;
const PROBE_TIMEOUT_MS = 5_000;

export interface CheckStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CheckResult {
  appId: string;
  origin: string | null;
  steps: CheckStep[];
  /** True only when every step passed. */
  ok: boolean;
}

interface Reply {
  status: number;
  body: string;
}

function request(
  port: number,
  path: string,
  opts: { method?: string; token?: string; body?: string; timeoutMs?: number } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        agent: false,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        headers: {
          // The guard accepts `127.0.0.1:<port>` and rejects `localhost`,
          // because `localhost` goes through the system resolver, which is
          // exactly what a DNS-rebinding attacker influences. Sending what
          // the browser sends is the point of this whole module.
          Host: `127.0.0.1:${port}`,
          ...(opts.token ? { 'x-bernard-token': opts.token } : {}),
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const say = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Checks one applet over its real origin.
 *
 * With no `action`, every step is side-effect free: it proves the page, the
 * served client and the bootstrap handshake work, and that a handle exists
 * for every declared action. Naming an `action` adds the one step that
 * actually runs work — and that step is the one that matters, because the
 * transport can be perfectly healthy while `invoke` is the only route that
 * loads the dispatch chain, which is precisely how this failed.
 */
export async function checkApplet(
  appId: string,
  opts: { action?: string; args?: unknown; timeoutMs?: number } = {},
): Promise<CheckResult> {
  // `get` returns a parse RESULT, so a manifest a newer Bernard wrote — or a
  // hand edit that broke it — is a finding here rather than a crash.
  const parsed = new AppRegistry().get(appId);
  if (!parsed || !parsed.ok) {
    const detail = parsed ? parsed.failure.message : `No applet "${appId}".`;
    return { appId, origin: null, steps: [{ name: 'manifest', ok: false, detail }], ok: false };
  }
  const actionNames = Object.keys(parsed.manifest.actions);
  const record = new HostRegistry().recordFor(appId);
  const origin = `http://127.0.0.1:${record.port}`;

  let hostErr: string | undefined;
  try {
    await startHost();
  } catch (err) {
    hostErr = `Could not start the applet host: ${say(err)}`;
  }
  if (!hostErr && !(await probeApplet(record.port, PROBE_TIMEOUT_MS))) {
    hostErr = `Nothing answering on ${origin}. Try \`bernard applet-host start\`.`;
  }

  const manifestStep: CheckStep = {
    name: 'manifest',
    ok: true,
    detail: `${actionNames.length} action(s): ${actionNames.join(', ') || '(none)'}`,
  };
  if (hostErr) {
    return {
      appId,
      origin,
      steps: [manifestStep, { name: 'host', ok: false, detail: hostErr }],
      ok: false,
    };
  }

  const served = await checkServedApplet(record.port, actionNames, opts);
  const steps = [manifestStep, { name: 'host', ok: true, detail: `serving at ${origin}` }, ...served];
  return { appId, origin, steps, ok: steps.every((s) => s.ok) };
}

/**
 * The HTTP half, against a port that is already serving.
 *
 * Split out so it can be driven against a real `startApplet` on port 0 — the
 * only way to test this without spawning a detached daemon, and a test that
 * spawned one would be testing the daemon rather than the checks. It is also
 * the honest shape: "check the applet being served here" is a question worth
 * asking on its own.
 */
export async function checkServedApplet(
  port: number,
  actionNames: string[],
  opts: { action?: string; args?: unknown; timeoutMs?: number } = {},
): Promise<CheckStep[]> {
  const steps: CheckStep[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail });
  };
  const record = { port };

  // The page and the served client. A page that 404s, or a client the page
  // cannot load, is a dead applet no amount of source reading reveals.
  for (const [name, path] of [
    ['page', '/'],
    ['client', '/__bernard/applet.js'],
    ['stylesheet', '/__bernard/tokens.css'],
  ] as const) {
    try {
      const res = await request(record.port, path);
      add(name, res.status === 200, `GET ${path} -> ${res.status}`);
    } catch (err) {
      add(name, false, `GET ${path} failed: ${say(err)}`);
    }
  }

  let token: string | undefined;
  let handles: Record<string, string> = {};
  try {
    const res = await request(record.port, '/__bernard/bootstrap.json');
    if (res.status !== 200) {
      add('bootstrap', false, `GET /__bernard/bootstrap.json -> ${res.status}`);
    } else {
      const boot = JSON.parse(res.body) as { token?: string; handles?: Record<string, string> };
      token = boot.token;
      handles = boot.handles ?? {};
      const missing = actionNames.filter((a) => !handles[a]);
      add(
        'bootstrap',
        Boolean(token) && missing.length === 0,
        missing.length
          ? `no handle minted for: ${missing.join(', ')}`
          : `token present, ${Object.keys(handles).length} handle(s)`,
      );
    }
  } catch (err) {
    add('bootstrap', false, `bootstrap failed: ${say(err)}`);
  }

  if (!opts.action) return steps;

  // The step that presses the button.
  const handle = handles[opts.action];
  if (!token || !handle) {
    add('invoke', false, `No handle for action "${opts.action}"; cannot invoke.`);
    return steps;
  }
  try {
    const res = await request(record.port, '/__bernard/invoke', {
      method: 'POST',
      token,
      body: JSON.stringify({ handle, args: opts.args ?? {} }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    let detail = `POST /__bernard/invoke -> ${res.status}`;
    let ok = res.status === 200;
    try {
      const body = JSON.parse(res.body) as {
        ok?: boolean;
        error?: { code?: string; message?: string };
      };
      ok = ok && body.ok === true;
      if (body.ok !== true) {
        detail += ` ${body.error?.code ?? 'failed'}: ${body.error?.message ?? res.body.slice(0, 300)}`;
      }
    } catch {
      // A body that is not JSON is itself the finding: the served client
      // calls `res.json()` on every reply, so the page could not have read
      // this either.
      ok = false;
      detail += ` (body is not JSON: ${res.body.slice(0, 200)})`;
    }
    add('invoke', ok, detail);
  } catch (err) {
    add('invoke', false, `invoke failed: ${say(err)}`);
  }

  return steps;
}
