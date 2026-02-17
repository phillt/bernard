import { execSync, spawn } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import notifier from 'node-notifier';

const LINUX_TERMINALS = [
  'x-terminal-emulator',
  'gnome-terminal',
  'konsole',
  'xfce4-terminal',
  'alacritty',
  'kitty',
  'xterm',
];

function findLinuxTerminal(): string | null {
  for (const term of LINUX_TERMINALS) {
    try {
      execSync(`which ${term}`, { stdio: 'pipe' });
      return term;
    } catch {
      // not found, try next
    }
  }
  return null;
}

function getLinuxTerminalArgs(terminal: string, command: string): string[] {
  switch (terminal) {
    case 'gnome-terminal':
      return ['--', 'bash', '-c', command];
    case 'konsole':
      return ['-e', 'bash', '-c', command];
    case 'xfce4-terminal':
      return ['-e', command];
    case 'alacritty':
      return ['-e', 'bash', '-c', command];
    case 'kitty':
      return ['bash', '-c', command];
    default:
      // x-terminal-emulator, xterm, and others
      return ['-e', 'bash', '-c', command];
  }
}

function openAlertInTerminal(
  alertId: string,
  log?: (msg: string) => void,
  platform?: string,
): void {
  const plat = platform ?? osPlatform();
  const command = `bernard --alert ${alertId}`;

  if (plat === 'darwin') {
    try {
      const child = spawn(
        'osascript',
        ['-e', `tell application "Terminal" to do script "${command}"`],
        {
          detached: true,
          stdio: 'ignore',
        },
      );
      child.unref();
    } catch (err) {
      if (log)
        log(
          `Warning: Failed to open macOS Terminal: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    return;
  }

  if (plat === 'win32') {
    // Try Windows Terminal first, fall back to cmd
    try {
      const child = spawn('wt', ['--', 'cmd', '/k', command], {
        detached: true,
        stdio: 'ignore',
        shell: true,
      });
      child.unref();
    } catch {
      try {
        const child = spawn('cmd', ['/c', 'start', 'cmd', '/k', command], {
          detached: true,
          stdio: 'ignore',
          shell: true,
        });
        child.unref();
      } catch (err) {
        if (log)
          log(
            `Warning: Failed to open Windows terminal: ${err instanceof Error ? err.message : String(err)}`,
          );
      }
    }
    return;
  }

  // Linux
  const terminal = findLinuxTerminal();
  if (!terminal) {
    if (log) log('Warning: No supported terminal emulator found for alert display.');
    return;
  }

  const args = getLinuxTerminalArgs(terminal, command);
  try {
    const child = spawn(terminal, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    if (log)
      log(`Warning: Failed to open terminal: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let pendingAlertId: string | null = null;
let clickListenerRegistered = false;

export function sendNotification(options: {
  title: string;
  message: string;
  severity: 'low' | 'normal' | 'critical';
  alertId: string;
  log?: (msg: string) => void;
}): void {
  const { title, message, severity, alertId, log } = options;

  pendingAlertId = alertId;

  if (!clickListenerRegistered) {
    clickListenerRegistered = true;
    notifier.on('click', () => {
      if (pendingAlertId) {
        openAlertInTerminal(pendingAlertId, log);
        pendingAlertId = null;
      }
    });
  }

  const plat = osPlatform();

  // sound is macOS-only (NotificationCenter), urgency is Linux-only (NotifySend).
  // node-notifier ignores unknown fields per-platform, so we merge them.
  notifier.notify({
    title,
    message,
    sound: severity === 'critical',
    wait: plat !== 'linux',
    urgency: severity,
  } as import('node-notifier').Notification);
}
