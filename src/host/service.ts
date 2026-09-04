import * as path from 'node:path';

/**
 * Registering the applet host to start at login (#428).
 *
 * The host has to be running when someone opens an applet, which is usually
 * when no terminal is open. `src/cron/` already solved the process problem —
 * PID file, signal-0 liveness, detached spawn, SIGTERM shutdown — but nothing
 * in this repo has ever asked the OS to start something.
 *
 * **Pure string building, with the target directory injected.** That shape is
 * `resolveBackend(platform, configBackend, availableBins?)`'s, and here it is
 * load-bearing rather than stylistic: `~/.config/systemd/user` and
 * `~/Library/LaunchAgents` are the first paths in this repo that Bernard does
 * not own, and `BERNARD_HOME` — which every test relies on to redirect
 * `src/paths.ts` — deliberately does not redirect them. A builder that read
 * `os.homedir()` itself would write into the developer's real home the first
 * time a test called it.
 */

export type ServicePlatform = 'linux' | 'darwin' | 'win32';

export interface ServiceUnit {
  /** Path relative to the platform's per-user integration root. */
  relativePath: string;
  contents: string;
  /** Shell command that activates it, or `null` when dropping the file suffices. */
  activate: { command: string; args: string[] } | null;
  deactivate: { command: string; args: string[] } | null;
}

export const SERVICE_LABEL = 'bernard-applet-host';
const REVERSE_DNS = 'com.bernard.applet-host';

export interface ServiceUnitOptions {
  /** Absolute path to the node binary — `process.execPath`. */
  nodePath: string;
  /** Absolute path to `dist/host/daemon.js`. */
  daemonPath: string;
  /** Where the daemon's own log goes; the service redirects nothing else there. */
  logPath: string;
  /**
   * Environment the daemon must inherit to read the same files the CLI writes.
   *
   * A login service starts from the session's own environment, not from the
   * shell that installed it, so `BERNARD_HOME` / `XDG_CONFIG_HOME` set in a
   * profile script do not reach it — and the daemon then reads a DIFFERENT
   * `profiles.json` than `bernard app csp` writes. The symptom is the worst
   * kind: the grant is stored, the CLI prints it back, and the applet keeps
   * being blocked. Pre-existing (it already affects `appToolGrants`), but a
   * permission the user can see themselves grant is what makes it visible.
   *
   * Passed in rather than read here, so `serviceUnit` stays a pure string
   * builder that tests can drive without touching a real environment.
   */
  env?: Record<string, string>;
}

/**
 * The variables a daemon needs forwarded, when they are set.
 *
 * Deliberately a short allowlist rather than the whole environment: a unit
 * file is written to disk in a user-readable location, so copying an entire
 * environment into it would put whatever secrets it holds there too.
 */
export const FORWARDED_ENV_VARS = [
  'BERNARD_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
] as const;

/** Those of {@link FORWARDED_ENV_VARS} that are actually set. */
export function serviceEnvFrom(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FORWARDED_ENV_VARS) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * The per-user integration directory for a platform, relative to a home root.
 *
 * Returned as segments rather than a joined path so the caller decides the
 * root — which is what makes the whole module testable without touching a real
 * home.
 */
export function serviceDirSegments(platform: ServicePlatform): string[] {
  switch (platform) {
    case 'linux':
      return ['.config', 'systemd', 'user'];
    case 'darwin':
      return ['Library', 'LaunchAgents'];
    case 'win32':
      // `shell:startup`. Deliberately NOT Task Scheduler: `schtasks` at logon
      // is more capable and is what the issue lists first, but depending on
      // policy it can require elevation — and the issue's own rule is that
      // nothing here should need admin, and to pick something else if it does.
      return ['AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'];
  }
}

/**
 * The unit file for a platform.
 *
 * `ExecStart` is the node binary plus `dist/host/daemon.js`, never the
 * `bernard` shim: that is exactly what `startHost` already spawns, it sidesteps
 * resolving an npm bin link, and it is the one path guaranteed to exist
 * because `startHost` already errors when it does not.
 */
export function serviceUnit(platform: ServicePlatform, opts: ServiceUnitOptions): ServiceUnit {
  const { nodePath, daemonPath, logPath } = opts;
  const env = opts.env ?? {};
  switch (platform) {
    case 'linux':
      return {
        relativePath: `${SERVICE_LABEL}.service`,
        // `Restart=on-failure` rather than `always`: a daemon that exits 0 on
        // SIGTERM has been asked to stop, and restarting it would fight
        // `bernard applet-host stop`. `ExecStart` pointing at a file that no
        // longer exists fails immediately and gives up after the burst limit,
        // which is what an uninstalled Bernard must not turn into a loop.
        contents: [
          '[Unit]',
          'Description=Bernard applet host',
          '',
          '[Service]',
          'Type=simple',
          `ExecStart=${nodePath} ${daemonPath}`,
          ...Object.entries(env).map(([k, v]) => `Environment="${k}=${v}"`),
          'Restart=on-failure',
          'RestartSec=5',
          'StartLimitBurst=3',
          '',
          '[Install]',
          'WantedBy=default.target',
          '',
        ].join('\n'),
        activate: { command: 'systemctl', args: ['--user', 'enable', '--now', SERVICE_LABEL] },
        deactivate: {
          command: 'systemctl',
          args: ['--user', 'disable', '--now', SERVICE_LABEL],
        },
      };
    case 'darwin':
      return {
        relativePath: `${REVERSE_DNS}.plist`,
        contents: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
          '<plist version="1.0">',
          '<dict>',
          '  <key>Label</key>',
          `  <string>${REVERSE_DNS}</string>`,
          '  <key>ProgramArguments</key>',
          '  <array>',
          `    <string>${nodePath}</string>`,
          `    <string>${daemonPath}</string>`,
          '  </array>',
          ...(Object.keys(env).length > 0
            ? [
                '  <key>EnvironmentVariables</key>',
                '  <dict>',
                ...Object.entries(env).flatMap(([k, v]) => [
                  `    <key>${k}</key>`,
                  `    <string>${v}</string>`,
                ]),
                '  </dict>',
              ]
            : []),
          '  <key>RunAtLoad</key>',
          '  <true/>',
          '  <key>StandardErrorPath</key>',
          `  <string>${logPath}</string>`,
          '</dict>',
          '</plist>',
          '',
        ].join('\n'),
        activate: { command: 'launchctl', args: ['load', '-w', `${REVERSE_DNS}.plist`] },
        deactivate: { command: 'launchctl', args: ['unload', '-w', `${REVERSE_DNS}.plist`] },
      };
    case 'win32':
      return {
        relativePath: `${SERVICE_LABEL}.cmd`,
        // A file in the Startup folder IS the registration — nothing to
        // activate, which is the reason to prefer it over Task Scheduler here.
        contents: [
          '@echo off',
          ...Object.entries(env).map(([k, v]) => `set "${k}=${v}"`),
          `start "" /b "${nodePath}" "${daemonPath}"`,
          '',
        ].join('\r\n'),
        activate: null,
        deactivate: null,
      };
  }
}

/** True when this platform has a registration mechanism at all. */
export function isSupportedServicePlatform(platform: string): platform is ServicePlatform {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32';
}

/** Absolute path of the unit file, given a home root. */
export function serviceUnitPath(
  platform: ServicePlatform,
  homeRoot: string,
  unit: ServiceUnit,
): string {
  return path.join(homeRoot, ...serviceDirSegments(platform), unit.relativePath);
}
