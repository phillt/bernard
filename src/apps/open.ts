import { AppRegistry } from './registry.js';

/**
 * Opening an applet, shared by `bernard app open` and the `applet` tool.
 *
 * Returns rather than prints, so the CLI can print and the tool can fold the
 * outcome into the string a model reads — the same "one implementation, two
 * doors" split `store-route.ts` and `store-tools.ts` already make.
 *
 * ## It needs two waits, not one
 *
 * The host has to be up, because "spawning returns the instant the process
 * exists, which is well before it is listening". That is necessary and not
 * sufficient for a just-created applet:
 * the daemon notices a new manifest through `fs.watch` on a **500 ms
 * debounce** and then reconciles, so even an already-running host is not
 * serving this id at the moment `create` returns. Opening then shows a
 * connection error as the user's first impression of the applet they just
 * asked for — precisely the failure the first poll exists to prevent, one
 * level down.
 */
export interface OpenAppletResult {
  url: string;
  /** Whether a browser command was actually issued. */
  opened: boolean;
  /** Whether the host had to be started for this. */
  started: boolean;
  /** Why it was not opened, when it was not. */
  note?: string;
}

/** How long to wait for the daemon to notice a newly written applet. */
const SERVE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 150;

export async function openApplet(
  appId: string,
  opts: { open?: boolean } = {},
): Promise<OpenAppletResult | { error: string }> {
  if (!new AppRegistry().exists(appId)) return { error: `No such app: ${appId}` };

  const { HostRegistry } = await import('../host/registry.js');
  const { isHostProcessAlive, probeApplet, startHost } = await import('../host/client.js');

  // Resolved once: the assignment is stable and every branch below wants it.
  const port = new HostRegistry().recordFor(appId).port;
  const url = `http://127.0.0.1:${port}`;

  let started = false;
  if (!isHostProcessAlive()) {
    // `startHost`, deliberately NOT `appletHostStart`. That one is the CLI
    // door: it prints, and it sets `process.exitCode = 1` on failure. Called
    // from the `applet` tool during a REPL turn both are wrong — the writes
    // land in Ink's alternate screen buffer outside its render loop, and a
    // failed open would make the whole session exit non-zero. The printer is
    // a door, not the implementation.
    try {
      started = await startHost();
      if (!started) {
        return { url, opened: false, started: false, note: 'the applet host would not start' };
      }
    } catch (err) {
      // Never turn a successful create into a failure. `startHost` throws when
      // `dist/host/daemon.js` is missing, which is every `npm run dev` session.
      return {
        url,
        opened: false,
        started: false,
        note: `the applet host could not be started (${
          err instanceof Error ? err.message : String(err)
        })`,
      };
    }
  }

  const serving = await waitUntilServing(port, probeApplet);
  if (!serving) {
    return { url, opened: false, started, note: 'the host is not serving it yet' };
  }

  if (opts.open === false) return { url, opened: false, started };

  const { canOpenBrowser, openUrl } = await import('../open-url.js');
  if (!canOpenBrowser()) {
    return { url, opened: false, started, note: 'no browser is reachable from this session' };
  }
  return { url, opened: openUrl(url), started };
}

async function waitUntilServing(
  port: number,
  probe: (port: number, timeoutMs?: number) => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + SERVE_TIMEOUT_MS;
  for (;;) {
    if (await probe(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
