import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { APPLET_HOST_PID_FILE, APPLET_HOST_LOG_FILE, APPS_DIR } from '../paths.js';
import { AppRegistry } from '../apps/registry.js';
import { CapabilityTable } from '../apps/capabilities.js';
import { HostRegistry } from './registry.js';
import { startApplet, type RunningApplet } from './server.js';

/**
 * The applet host process (#421).
 *
 * Serves every registered applet, each on its own loopback port, and
 * reconciles when the app directory changes. Long-lived and terminal-less, so
 * it keeps its own rotating file log — `stdio: 'ignore'` means stdout goes
 * nowhere.
 *
 * #428 turns this into a per-user service started at login. Nothing here
 * assumes an Ink tree or a REPL, so that becomes a registration change rather
 * than a rewrite.
 */

const MAX_LOG_BYTES = 1024 * 1024;

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(path.dirname(APPLET_HOST_LOG_FILE), { recursive: true });
    try {
      if (fs.statSync(APPLET_HOST_LOG_FILE).size > MAX_LOG_BYTES) {
        fs.renameSync(APPLET_HOST_LOG_FILE, `${APPLET_HOST_LOG_FILE}.old`);
      }
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(APPLET_HOST_LOG_FILE, line);
  } catch {
    // Can't log, nothing we can do.
  }
}

/**
 * One session id for the life of this process.
 *
 * Handles are bound to it, so a restart invalidates every page still open —
 * which is correct: those pages hold handles this process's capability table
 * has never heard of.
 */
const sessionId = crypto.randomUUID();
const capabilities = new CapabilityTable();
const hosts = new HostRegistry();
const running = new Map<string, RunningApplet>();

async function reconcile(): Promise<void> {
  const wanted = new Set(new AppRegistry().listIds());

  for (const [appId, applet] of running) {
    if (!wanted.has(appId)) {
      await applet.close();
      running.delete(appId);
      // The actions a handle names may no longer exist. Revocation for an
      // in-memory table means dropping the entries, not marking them (#420).
      capabilities.revokeApp(appId);
      log(`stopped ${appId}`);
    }
  }

  for (const appId of wanted) {
    if (running.has(appId)) continue;
    try {
      const { port, token } = hosts.recordFor(appId);
      const applet = await startApplet({ appId, port, token, sessionId, capabilities, log });
      running.set(appId, applet);
      log(`serving ${appId} at ${applet.origin}`);
    } catch (err) {
      // A port held by something else is data-integrity news, not a retry:
      // reassigning would silently destroy that applet's browser storage.
      log(`could not serve ${appId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function shutdown(): Promise<void> {
  log('shutting down');
  for (const applet of running.values()) await applet.close();
  try {
    fs.unlinkSync(APPLET_HOST_PID_FILE);
  } catch {
    /* already gone */
  }
  process.exit(0);
}

async function main(): Promise<void> {
  fs.mkdirSync(path.dirname(APPLET_HOST_PID_FILE), { recursive: true });
  fs.writeFileSync(APPLET_HOST_PID_FILE, String(process.pid), 'utf-8');
  fs.mkdirSync(APPS_DIR, { recursive: true });
  log(`applet host started (pid ${process.pid}, session ${sessionId})`);

  await reconcile();

  // Watch the DIRECTORY, never the files. Manifest writes go through
  // `atomicWriteFileSync`, and a rename replaces the inode — a watch on the
  // file itself stops firing after the first write. The cron daemon carries
  // this comment for the same reason.
  let debounce: NodeJS.Timeout | undefined;
  try {
    fs.watch(APPS_DIR, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        void reconcile().catch((err: unknown) => log(`reconcile failed: ${String(err)}`));
      }, 500);
    });
  } catch (err) {
    log(`could not watch ${APPS_DIR}: ${String(err)}`);
  }

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
