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

/**
 * Whether opening a browser could plausibly work here.
 *
 * {@link openUrl} cannot answer this: it returns `true` the moment `spawn`
 * succeeds, and the real failure — `xdg-open` with no display — arrives
 * asynchronously on `child.on('error')`, long after the caller has moved on.
 * So a headless session gets a cheerful "opened it" and no window.
 *
 * Checked rather than attempted, because the caller's alternative is to print
 * the URL, and printing it is only useful if it happens INSTEAD of a claim
 * that the browser is already showing it. Same injectable-platform shape as
 * {@link browserCommand}, so this is testable without a machine.
 */
export function canOpenBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = osPlatform(),
): boolean {
  if (!browserCommand('about:blank', platform)) return false;
  // macOS and Windows always have a window server for a logged-in user.
  if (platform !== 'linux') return true;
  // A display is what `xdg-open` actually needs; SSH without one is the
  // common case, but a bare tty console is the same situation.
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
