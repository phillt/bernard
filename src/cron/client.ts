import * as fs from 'node:fs';
import * as path from 'node:path';
import { fork } from 'node:child_process';
import { CronStore } from './store.js';

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
 * Forks the daemon process in the background if it is not already running.
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

  const child = fork(daemonPath, [], {
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
