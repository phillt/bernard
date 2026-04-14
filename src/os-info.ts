import * as os from 'node:os';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

/** Minimal OS fingerprint used to tailor tool-wrapper prompts and examples. */
export interface OsInfo {
  /** Node's `process.platform` — 'darwin' | 'linux' | 'win32' | ... */
  platform: NodeJS.Platform;
  /** 'x64', 'arm64', etc. */
  arch: string;
  /** Default shell path, best-effort from $SHELL or a platform fallback. */
  shell: string;
  /** Human-readable OS label (e.g. "macOS 14.3", "Ubuntu 22.04", "Windows 10"). */
  osRelease?: string;
}

let cached: OsInfo | undefined;

function detectOsRelease(platform: NodeJS.Platform): string | undefined {
  try {
    if (platform === 'linux' && fs.existsSync('/etc/os-release')) {
      const contents = fs.readFileSync('/etc/os-release', 'utf-8');
      const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(contents);
      if (pretty) return pretty[1];
      const name = /^NAME="?([^"\n]+)"?/m.exec(contents);
      if (name) return name[1];
    }
    if (platform === 'darwin') {
      const raw = execSync('sw_vers', { encoding: 'utf-8', timeout: 1000 });
      const product = /ProductName:\s*(.+)/i.exec(raw)?.[1]?.trim() ?? 'macOS';
      const version = /ProductVersion:\s*(.+)/i.exec(raw)?.[1]?.trim() ?? '';
      return `${product} ${version}`.trim();
    }
  } catch {
    /* best-effort — fall through */
  }
  return `${os.type()} ${os.release()}`;
}

function detectShell(platform: NodeJS.Platform): string {
  const envShell = process.env.SHELL;
  if (envShell) return envShell;
  if (platform === 'win32') return process.env.ComSpec ?? 'cmd.exe';
  return '/bin/sh';
}

/** Returns a cached OS fingerprint for the current process. */
export function getOsInfo(): OsInfo {
  if (cached) return cached;
  const platform = os.platform();
  const info: OsInfo = {
    platform,
    arch: os.arch(),
    shell: detectShell(platform),
    osRelease: detectOsRelease(platform),
  };
  cached = info;
  return info;
}

/** Clears the cached value. Used by tests. */
export function _resetOsInfoCache(): void {
  cached = undefined;
}

/**
 * Returns a short markdown block describing the host OS, suitable for injecting
 * into a tool-wrapper specialist's system prompt. The block is a few lines so
 * specialists can tailor commands (brew vs apt, gfind vs find, etc.) without
 * re-detecting.
 */
export function osPromptBlock(): string {
  const info = getOsInfo();
  const lines = [
    '## Host OS',
    `- Platform: ${info.platform}`,
    `- Architecture: ${info.arch}`,
    `- Shell: ${info.shell}`,
  ];
  if (info.osRelease) lines.push(`- Release: ${info.osRelease}`);
  lines.push(
    '',
    'Tailor commands to this platform. On macOS, BSD userland (e.g. `find` without `-printf`) applies unless GNU tools are installed as `g*` prefixes. On Linux, assume GNU userland. On Windows, prefer PowerShell-compatible syntax.',
  );
  return lines.join('\n');
}
