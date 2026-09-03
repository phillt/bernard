import { spawn } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import { debugLog } from './logger.js';

/**
 * Opening a URL in the user's default browser (#429).
 *
 * There was no browser-launching code in Bernard at all. Modelled on
 * `src/cron/notify.ts`, which is the same shape one layer over: a three-way
 * platform switch, `platform` overridable for tests, `detached` + `unref` so a
 * long-lived browser never holds the CLI open, `stdio: 'ignore'` per the
 * repo-wide convention, and best-effort — a failure logs rather than throws,
 * because failing to open a window must not fail the thing that built it.
 */

/** The command for a platform, or `null` when there is nothing to try. */
export function browserCommand(
  url: string,
  platform: string = osPlatform(),
): { command: string; args: string[] } | null {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      // `start` is a cmd builtin, not an executable. The empty string is the
      // window TITLE argument — without it `start` treats a quoted URL as the
      // title and opens nothing.
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    case 'linux':
      return { command: 'xdg-open', args: [url] };
    default:
      return null;
  }
}

/** Opens `url`, returning whether a command was even attempted. */
export function openUrl(url: string, platform: string = osPlatform()): boolean {
  const cmd = browserCommand(url, platform);
  if (!cmd) {
    debugLog('open-url:unsupported', { platform });
    return false;
  }
  try {
    const child = spawn(cmd.command, cmd.args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => debugLog('open-url:failed', { message: err.message }));
    child.unref();
    return true;
  } catch (err) {
    debugLog('open-url:threw', { message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
