import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { APPLET_HOST_PID_FILE, APPLET_HOST_LOG_FILE, APPS_DIR } from '../paths.js';
import { watchOwnBuild, respawnSelf } from '../build-stamp.js';
import { sendToSessions } from '../inbox/send.js';
import { AppRegistry } from '../apps/registry.js';
import { CapabilityTable } from '../apps/capabilities.js';
import { recordCapabilityMint } from '../apps/capability-log.js';
import { HostRegistry } from './registry.js';
import { startApplet, inFlightInvocations, type RunningApplet } from './server.js';
import { closeAllAppletStores, closeAppletStore } from './store-route.js';

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
        // Unlink first, as the cron daemon does. `renameSync` over an existing
        // file is fine on POSIX and FAILS on Windows — which #428 is about to
        // make a supported platform, where the failure would be a host that
        // silently stops logging once it hits 1 MB.
        fs.rmSync(`${APPLET_HOST_LOG_FILE}.old`, { force: true });
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
// Every mint is logged (#420 R9), so a handle presented later can be traced
// back to when and for what it was issued. The host is the only minter.
const capabilities = new CapabilityTable(recordCapabilityMint);
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
      // Its SQLite connection is cached for the life of the process, so an
      // app removed and re-added would otherwise keep writing through a handle
      // to the old file if the data directory were replaced underneath it.
      closeAppletStore(appId);
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

/**
 * Releases every listening port and closes every SQLite handle.
 *
 * Shared by {@link shutdown} and {@link restartForNewBuild}: a replacement
 * process binds the SAME hash-derived ports, so anything short of releasing
 * them first makes the new host log "could not serve" and leave that applet
 * dark until somebody restarts it by hand.
 */
async function closeAll(): Promise<void> {
  for (const applet of running.values()) await applet.close();
  // Closes each cached SQLite handle so WAL checkpoints, rather than leaving
  // it to `process.exit`.
  closeAllAppletStores();
}

async function shutdown(): Promise<void> {
  log('shutting down');
  await closeAll();
  try {
    fs.unlinkSync(APPLET_HOST_PID_FILE);
  } catch {
    /* already gone */
  }
  process.exit(0);
}

/**
 * How long to let in-flight invocations finish before replacing this process.
 *
 * An applet action's own `timeoutMs` reaches 180 s, so this cannot wait for
 * the worst case without leaving the host serving stale code for three
 * minutes after a build. 30 s covers the ordinary agent-backed action —
 * measured 7-18 s across every invocation this install has logged — and a run
 * that outlives it is abandoned with a line saying so, which is a truthful
 * report rather than a silent kill.
 */
const DRAIN_TIMEOUT_MS = 30_000;
const DRAIN_POLL_MS = 250;

async function drain(): Promise<boolean> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (inFlightInvocations() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
  }
  return inFlightInvocations() === 0;
}

/**
 * Replaces this process after Bernard was rebuilt or upgraded underneath it.
 *
 * Why this exists at all is in `src/build-stamp.ts`: a daemon holds its module
 * graph for its whole life, and the deferred `await import()` calls scattered
 * through the tree link fresh code against that stale cache the first time
 * they run. The host is where it bites, because it sits idle for days and
 * then loads half the graph on the first click.
 *
 * Automatic rather than a prompt, because the alternative is what shipped:
 * nothing noticed, every applet answered `500`, the only evidence was a log
 * file nothing surfaces, and the stylesheet the pages were being served was
 * nine days old. Nobody is going to restart this by hand on a schedule they
 * cannot see.
 */
async function restartForNewBuild(): Promise<void> {
  const entry = fileURLToPath(import.meta.url);
  if (!fs.existsSync(entry)) {
    // Mid-upgrade, or a `dist/` that was removed rather than replaced. Staying
    // up on stale code beats exiting into nothing.
    log(`not restarting: own entry ${entry} is gone`);
    return;
  }

  log('bernard was rebuilt; restarting to pick up the new build');
  // Sent BEFORE the drain so it lands while the REPL is still the thing the
  // user is looking at, rather than up to 30 s later.
  try {
    sendToSessions({
      text: 'Bernard was rebuilt, so the applet host restarted to pick it up.',
      source: { kind: 'applet', label: 'applet-host' },
      hint: 'Reload any open applet tabs — a restart mints new tokens.',
      target: { all: true },
    });
  } catch {
    // Nothing about reporting a restart may prevent one.
  }

  const drained = await drain();
  if (!drained) {
    log(`restarting with ${inFlightInvocations()} invocation(s) still running`);
  }

  await closeAll();
  if (!respawnSelf({ entry, pidFile: APPLET_HOST_PID_FILE })) {
    log('respawn failed; exiting anyway so a later `applet-host start` is clean');
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

  // Notice when this process's own code stops matching what is on disk.
  watchOwnBuild({
    log,
    onStale: () => void restartForNewBuild(),
  });

  /**
   * A crash must leave a trace.
   *
   * The daemon is spawned `stdio: 'ignore'`, so anything Node writes to
   * stderr on the way down goes nowhere — and this file's log is the only
   * place a person can look. That gap cost real debugging time: an unhandled
   * `'error'` event from a recursive `fs.watch` ended the host mid-session
   * with no restart line, no shutdown line, and nothing on disk to say it had
   * happened at all. The watch is gone, but the next silent death should not
   * have to be reconstructed from its absence.
   *
   * It re-throws rather than swallowing. A process that keeps running after
   * an unhandled exception is in a state nobody designed, and the pid file
   * would still name it while it served nothing.
   */
  process.on('uncaughtException', (err: unknown) => {
    log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    log(
      `fatal (unhandled rejection): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
    process.exit(1);
  });

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
