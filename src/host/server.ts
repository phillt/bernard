import * as fs from 'node:fs';
import * as http from 'node:http';
import { appletAssetDir } from '../paths.js';
import { invokeAction, type InvocationResult } from '../apps/invoke.js';
import { CapabilityTable } from '../apps/capabilities.js';
import { AppRegistry } from '../apps/registry.js';
import { checkRequest } from './guard.js';
import { securityHeaders, originFor } from './csp.js';
import { resolveAsset } from './assets.js';
import { TOKENS_PATH, tokensStylesheet } from './tokens.js';
import { SDK_PATH, appletSdkScript } from './sdk.js';
import { ICON_PATH, MANIFEST_PATH, appletIcon, webManifest } from './webmanifest.js';
import { handleStoreRequest } from './store-route.js';

/**
 * One loopback HTTP server per applet (#421).
 *
 * **One origin per applet, and a port is how.** Serving several generated apps
 * from a shared origin means they share `localStorage`, so a hostile applet
 * reads another's data — confirmed in five independent systems. The intuitive
 * fix, `<applet-id>.localhost`, does not work: WebKit bug 160504 is RESOLVED
 * MOVED, `*.localhost` resolves in Safari only on macOS 26, and the fix is in
 * the macOS system resolver so no browser update backports it. A port is a
 * real origin and works everywhere.
 *
 * That origin is doing security work, not tidiness: an applet needs
 * `allow-scripts` to be an app at all, and `allow-scripts` +
 * `allow-same-origin` on a same-origin frame lets it delete its own `sandbox`
 * attribute. A distinct origin is what makes the grant safe.
 */

/** Path the applet's page posts a capability handle to. */
export const INVOKE_PATH = '/__bernard/invoke';
/** Liveness, used by the client instead of a bare PID check. */
export const HEALTH_PATH = '/__bernard/health';
/** What the served page reads to learn its own token and handles. */
export const BOOTSTRAP_PATH = '/__bernard/bootstrap.json';
/**
 * The applet's own key-value store (#422).
 *
 * **POST for reads too, deliberately.** The guard requires the token only for
 * non-`GET`/`HEAD` requests, because an asset read has to work before the page
 * holds anything. Applet *data* is not an asset, so a `GET` read endpoint here
 * would be reachable by anything that can satisfy the origin checks. Making
 * every store call a POST puts it behind the token without weakening the asset
 * path.
 */
export const STORE_PATH = '/__bernard/store';

/** Bodies are small by construction — an action's args are scalars. */
const MAX_BODY_BYTES = 64 * 1024;

export interface AppletServerOptions {
  appId: string;
  port: number;
  token: string;
  sessionId: string;
  capabilities: CapabilityTable;
  /** Asset root; defaults to this applet's own directory. */
  assetDir?: string;
  log?: (msg: string) => void;
}

export interface RunningApplet {
  port: number;
  origin: string;
  close: () => Promise<void>;
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
}

/** Reads a bounded JSON body. Rejects rather than buffering without limit. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

/** Builds the request handler for one applet. */
function createHandler(
  opts: AppletServerOptions,
  /**
   * Resolves the port actually bound.
   *
   * A thunk because `port: 0` — which is how the tests avoid colliding with a
   * concurrent run — is not known until `listen` completes, and the guard
   * compares `Host` against it. A captured `opts.port` would be `0` and refuse
   * every request.
   */
  getPort: () => number,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const { appId, token, sessionId, capabilities } = opts;
  const assetDir = opts.assetDir ?? appletAssetDir(appId);
  const log = opts.log ?? (() => {});
  // One registry for the life of this applet's server. The three routes below
  // each constructed their own, so every request re-ran `seedOnce`'s mkdir and
  // marker stat — and a page load hits two of them. The manifest itself is
  // still read per request, deliberately: it is user-editable between requests,
  // so caching the parsed value would re-open the time-of-check/time-of-use gap
  // that validating on read exists to close (#420 R6).
  const registry = new AppRegistry();

  return (req, res) => {
    void (async () => {
      const port = getPort();
      const verdict = checkRequest(
        { port, token },
        {
          method: req.method ?? 'GET',
          headers: req.headers as Record<string, string | string[] | undefined>,
        },
      );
      if (!verdict.ok) {
        log(`refused ${req.method} ${req.url} (${verdict.reason})`);
        send(res, verdict.status, verdict.reason);
        return;
      }

      const url = (req.url ?? '/').split('?')[0];

      if (url === HEALTH_PATH) {
        sendJson(res, 200, { ok: true, appId, origin: originFor(port) });
        return;
      }

      /**
       * The page's own token and its handles.
       *
       * Handles are minted HERE, at serve time, before any caller-supplied
       * data is in scope (#420 R2) — one per action the manifest declares.
       * They bind the action and its arg schema; the values vary per click and
       * are validated against that schema at invoke.
       */
      if (url === BOOTSTRAP_PATH) {
        const app = registry.get(appId);
        if (!app.ok) {
          sendJson(res, 500, { ok: false, error: app.failure.message });
          return;
        }
        const handles: Record<string, string> = {};
        for (const action of Object.keys(app.manifest.actions)) {
          // `handleFor`, not `mint`: the designation is constant for this
          // process, so a fresh handle per page load only grew the table —
          // and this route is a GET, which the guard does not gate on the
          // token. See `CapabilityTable.handleFor`.
          handles[action] = capabilities.handleFor(appId, action, sessionId);
        }
        sendJson(res, 200, { schemaVersion: 1, appId, token, handles });
        return;
      }

      if (url === INVOKE_PATH) {
        if (req.method !== 'POST') {
          send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { ok: false, error: { code: 'invalid_args', message: 'Bad body.' } });
          return;
        }
        const { handle, args } = (body ?? {}) as { handle?: unknown; args?: unknown };
        if (typeof handle !== 'string') {
          sendJson(res, 400, {
            ok: false,
            error: { code: 'invalid_args', message: 'A capability handle is required.' },
          });
          return;
        }

        // Resolve handle → record, and enforce from the record. The action is
        // NEVER read from the request body: taking a designation from the
        // caller is the ambient-authority mistake #420 R3 forbids.
        const resolved = capabilities.redeem(handle, { appId, sessionId });
        if (!resolved.ok) {
          log(`capability refused for ${appId} (${resolved.reason})`);
          sendJson(res, 403, {
            ok: false,
            error: { code: 'invalid_args', message: 'Capability refused.' },
          });
          return;
        }

        const record = resolved.record;
        const result: InvocationResult = await invokeAction({
          appId: record.appId,
          action: record.action,
          // A frozen handle's values win over anything the page sends — the
          // user approved those, not whatever arrived with the request.
          args: record.frozenArgs ?? args ?? {},
          log,
          capabilityId: record.id,
        });
        sendJson(res, result.ok ? 200 : 500, result);
        return;
      }

      // The shared palette (#424). Served from the host's own namespace so
      // every applet references one artifact rather than carrying a copy that
      // drifts — which is what happened to the four `docs/*.html` this is
      // lifted from. `style-src 'self'` already permits it.
      /**
       * The web app manifest (#429), generated rather than shipped.
       *
       * A static `manifest.webmanifest` in the asset directory cannot know its
       * own `start_url`: the port is assigned at runtime by `HostRegistry` and
       * lives in `APPLET_HOSTS_FILE`, not beside the page. So it is a route,
       * like `BOOTSTRAP_PATH`, built from the manifest the registry holds and
       * the port this server actually bound.
       *
       * Whether a browser will OFFER to install it is not settled: the
       * `sandbox` header (#421) may refuse a top-level install, and that
       * header is not being relaxed on a guess. Serving a correct manifest
       * costs nothing either way and is the half that can be verified here.
       */
      if (url === MANIFEST_PATH) {
        const app = registry.get(appId);
        if (!app.ok) {
          sendJson(res, 500, { ok: false, error: app.failure.message });
          return;
        }
        send(res, 200, JSON.stringify(webManifest(app.manifest, port), null, 2), {
          'Content-Type': 'application/manifest+json; charset=utf-8',
        });
        return;
      }

      if (url === ICON_PATH) {
        const app = registry.get(appId);
        const label = app.ok ? app.manifest.name : appId;
        send(res, 200, appletIcon(label), { 'Content-Type': 'image/svg+xml; charset=utf-8' });
        return;
      }

      if (url === SDK_PATH) {
        // The Content-Type is hardcoded like its neighbours rather than going
        // through `contentTypeFor` — these routes never touch the filesystem.
        // It has to be exactly a JS MIME: with `nosniff` on every response a
        // wrong one means the browser silently declines to execute, which is
        // the same invisible-failure class this whole module exists to remove.
        send(res, 200, appletSdkScript(), { 'Content-Type': 'text/javascript; charset=utf-8' });
        return;
      }

      if (url === TOKENS_PATH) {
        send(res, 200, tokensStylesheet(), { 'Content-Type': 'text/css; charset=utf-8' });
        return;
      }

      if (url === STORE_PATH) {
        if (req.method !== 'POST') {
          send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { ok: false, error: 'Bad body.' });
          return;
        }
        // `appId` comes from THIS server's own closure, never from the body.
        // A store addressed by a request parameter would let any page that can
        // reach this port read every applet's data — the same
        // designation-from-the-caller mistake the invoke route refuses.
        sendJson(res, 200, handleStoreRequest(appId, body));
        return;
      }

      const asset = resolveAsset(assetDir, url);
      if (!asset.ok) {
        send(res, asset.status, 'Not Found');
        return;
      }
      if (req.method === 'HEAD') {
        send(res, 200, '', { 'Content-Type': asset.contentType });
        return;
      }
      send(res, 200, fs.readFileSync(asset.absPath), { 'Content-Type': asset.contentType });
    })().catch((err: unknown) => {
      log(`handler error: ${err instanceof Error ? err.message : String(err)}`);
      try {
        send(res, 500, 'Internal Server Error');
      } catch {
        // response already sent
      }
    });
  };
}

/**
 * Binds one applet's server.
 *
 * **`127.0.0.1` explicitly** — never `0.0.0.0`, never `::`. Binding the
 * wildcard would expose the applet to the local network, and the `Host` guard
 * is a second line, not a substitute for not listening there in the first
 * place.
 */
export function startApplet(opts: AppletServerOptions): Promise<RunningApplet> {
  let boundPort = opts.port;
  const server = http.createServer(createHandler(opts, () => boundPort));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      boundPort = port;
      resolve({
        port,
        origin: originFor(port),
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            // Idle keep-alive sockets would otherwise hold `close` open past
            // any sensible shutdown budget.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
