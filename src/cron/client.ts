import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CronStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Checks whether the daemon process is alive by sending signal 0 to the recorded PID. Cleans up stale PID files. */
export function isDaemonRunning(): boolean {
  const pidFile = CronStore.pidFile;
  if (!fs.existsSync(pidFile)) return false;

  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isNaN(pid)) {
      fs.unlinkSync(pidFile);
      return false;
    }
    // Check if process is alive (signal 0 doesn't kill, just checks)
    process.kill(pid, 0);
    return true;
  } catch {
    // Process not running — clean up stale PID file
    try {
      fs.unlinkSync(pidFile);
    } catch {}
    return false;
  }
}

/** Reads the daemon PID from the PID file, or returns `null` if unavailable. */
export function getDaemonPid(): number | null {
  const pidFile = CronStore.pidFile;
  if (!fs.existsSync(pidFile)) return null;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Starts the daemon as a detached background process if it is not already
 * running.
 *
 * @returns `true` if the daemon is now running (already was or just started).
 * @throws {Error} If the compiled daemon script is missing (build required).
 */
export function startDaemon(): boolean {
  if (isDaemonRunning()) return true;

  const daemonPath = path.resolve(__dirname, 'daemon.js');
  if (!fs.existsSync(daemonPath)) {
    throw new Error(`Daemon script not found at ${daemonPath}. Run "npm run build" first.`);
  }

  // `spawn`, not `fork`. `fork` always opens an IPC channel, and that channel
  // keeps the PARENT's event loop alive past `child.unref()` — `unref()`
  // releases the child handle, not the channel. Latent here rather than
  // observed, because every caller today keeps running anyway (the REPL is
  // long-lived; the `bernard cron` subcommands do more work afterwards), but a
  // caller whose only job is "start the daemon and exit" would hang with no
  // error — the worst shape for something on the automation path. #421 hit
  // exactly this on the applet host and fixed it there; this is the copy that
  // did not get the fix. We never talk to this process, so it should not have
  // a channel to talk on.
  //
  // Naming `process.execPath` also states what `fork` only implied: the child
  // is a Node script run with the same executable.
  //
  // It is not a COMPLETE substitution, and the difference that is not the
  // channel is `execArgv`: `fork` defaults the child's to the parent's, and
  // `spawn` passes none. Measured — a parent run under
  // `--enable-source-maps --max-old-space-size=3000` forks a child that reports
  // both flags and spawns one that reports `[]`. Inert here: nothing in the tree
  // sets `execArgv`, `NODE_OPTIONS` still reaches the child through the
  // inherited environment, and the `tsx` dev path where flags are likeliest
  // cannot start a daemon at all (the throw two lines up). `host/client.ts` has
  // made the identical trade since #421. Written down because the next person
  // wondering why a long-lived daemon ignores a heap flag they set will land on
  // these lines. Restoring it is `execArgv: process.execArgv` in the options —
  // but the flags a REPL wants and the flags an unattended daemon wants are not
  // obviously one set, so inheriting them would be a decision, not a repair.
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  if (child.pid) {
    fs.writeFileSync(CronStore.pidFile, String(child.pid), 'utf-8');
    return true;
  }

  return false;
}

/** Sends SIGTERM to the daemon and removes the PID file. Returns `false` if no daemon was found. */
export function stopDaemon(): boolean {
  const pid = getDaemonPid();
  if (pid === null) return false;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already dead
  }

  try {
    fs.unlinkSync(CronStore.pidFile);
  } catch {}
  return true;
}
