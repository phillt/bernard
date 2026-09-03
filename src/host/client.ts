import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import { APPLET_HOST_PID_FILE } from '../paths.js';
import { HEALTH_PATH } from './server.js';
import { HostRegistry } from './registry.js';
import { AppRegistry } from '../apps/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Starting, stopping and probing the applet host (#421).
 *
 * Modelled on `src/cron/client.ts`, with one deliberate difference:
 * **liveness is a health probe, not a PID check.** `kill(pid, 0)` cannot tell
 * Bernard from a process that recycled the PID — a weakness the cron client
 * carries because it has nothing better. A server has a port, so asking it is
 * strictly better and costs one loopback round trip.
 */

export function getHostPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(APPLET_HOST_PID_FILE, 'utf-8').trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** True when a process holding the PID file exists. Necessary, not sufficient. */
export function isHostProcessAlive(): boolean {
  const pid = getHostPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      fs.unlinkSync(APPLET_HOST_PID_FILE);
    } catch {
      /* already gone */
    }
    return false;
  }
}

/**
 * Asks an applet's own port whether it is actually serving.
 *
 * This is what "running" means here. A stale PID file plus a recycled PID
 * looks alive to a signal and answers nothing on the port.
 */
export function probeApplet(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    // `node:http` with `agent: false`, not `fetch`. Undici keeps a global
    // keep-alive pool whose sockets hold the event loop open, so a CLI that
    // probed with `fetch` printed its output and then never exited — observed,
    // not theorised. An un-pooled request closes with the response.
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: HEALTH_PATH,
        method: 'GET',
        agent: false,
        timeout: timeoutMs,
        headers: { Host: `127.0.0.1:${port}` },
      },
      (res) => {
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        res.resume(); // drain, or the socket lingers
        res.on('end', () => resolve(ok));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * True when at least one registered applet answers its health endpoint.
 *
 * **Distinct from "the process is up", and #428 is why that matters.** A host
 * started at login before any applet exists is running correctly and serving
 * nothing, and this returns `false` for it — which made `appletHostStart` poll
 * for ten seconds and then report a healthy service as stopped. Callers that
 * want liveness want {@link isHostProcessAlive}; callers that want "is my
 * applet reachable" want this.
 */
export async function isHostServing(): Promise<boolean> {
  if (!isHostProcessAlive()) return false;
  const hosts = new HostRegistry();
  for (const appId of new AppRegistry().listIds()) {
    const port = hosts.portFor(appId);
    if (port !== undefined && (await probeApplet(port))) return true;
  }
  return false;
}

/**
 * True when the host is up AND either serving an applet or has none to serve.
 *
 * The question `applet-host start` actually needs: "did it come up?", which for
 * an install with no applets is answered by the process alone.
 */
export async function isHostRunning(): Promise<boolean> {
  if (!isHostProcessAlive()) return false;
  if (new AppRegistry().listIds().length === 0) return true;
  return isHostServing();
}

/**
 * Forks the detached host if it is not already serving.
 *
 * Requires a build: `daemon.js` does not exist under `tsx`, so `npm run dev`
 * cannot start one. Same limitation the cron daemon has, stated rather than
 * worked around.
 */
export async function startHost(): Promise<boolean> {
  if (await isHostRunning()) return true;

  const daemonPath = path.resolve(__dirname, 'daemon.js');
  if (!fs.existsSync(daemonPath)) {
    throw new Error(`Applet host script not found at ${daemonPath}. Run "npm run build" first.`);
  }

  // `spawn`, not `fork`. `fork` always opens an IPC channel, and that channel
  // keeps the PARENT's event loop alive even after `child.unref()` — observed
  // as `bernard applet-host start` printing nothing and never exiting. We
  // never talk to this process, so it should not have a channel to talk on.
  // (`src/cron/client.ts` forks; it survives because its callers keep running
  // anyway, but the same hazard is latent there.)
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  if (!child.pid) return false;

  fs.mkdirSync(path.dirname(APPLET_HOST_PID_FILE), { recursive: true });
  fs.writeFileSync(APPLET_HOST_PID_FILE, String(child.pid), 'utf-8');
  return true;
}

export function stopHost(): boolean {
  const pid = getHostPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  try {
    fs.unlinkSync(APPLET_HOST_PID_FILE);
  } catch {
    /* already gone */
  }
  return true;
}
