import { execSync, spawn } from 'node:child_process';

const TERMINALS = [
  'x-terminal-emulator',
  'gnome-terminal',
  'konsole',
  'xfce4-terminal',
  'alacritty',
  'kitty',
  'xterm',
];

function findTerminal(): string | null {
  for (const term of TERMINALS) {
    try {
      execSync(`which ${term}`, { stdio: 'pipe' });
      return term;
    } catch {
      // not found, try next
    }
  }
  return null;
}

function getTerminalArgs(terminal: string, command: string): string[] {
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

export function sendNotification(
  title: string,
  message: string,
  severity: 'low' | 'normal' | 'critical' = 'normal',
  log?: (msg: string) => void,
): void {
  const urgencyMap = { low: 'low', normal: 'normal', critical: 'critical' } as const;
  const urgency = urgencyMap[severity];

  try {
    execSync(
      `notify-send -u ${urgency} ${JSON.stringify(title)} ${JSON.stringify(message)}`,
      { stdio: 'pipe', timeout: 5000 },
    );
  } catch (err) {
    const msg = `Warning: notify-send failed: ${err instanceof Error ? err.message : String(err)}`;
    if (log) log(msg);
  }
}

export function openAlertTerminal(alertId: string, log?: (msg: string) => void): void {
  const terminal = findTerminal();
  if (!terminal) {
    const msg = 'Warning: No supported terminal emulator found for alert display.';
    if (log) log(msg);
    return;
  }

  const command = `bernard --alert ${alertId}`;
  const args = getTerminalArgs(terminal, command);

  try {
    const child = spawn(terminal, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    const msg = `Warning: Failed to open terminal: ${err instanceof Error ? err.message : String(err)}`;
    if (log) log(msg);
  }
}
