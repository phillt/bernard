import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { printError, printInfo } from '../output.js';
import { APPLET_HOST_LOG_FILE } from '../paths.js';
import {
  isSupportedServicePlatform,
  serviceUnit,
  serviceUnitPath,
  type ServicePlatform,
} from './service.js';

/**
 * `bernard applet-host install` / `uninstall` (#428).
 *
 * The impure half of {@link serviceUnit}: it resolves the home root, writes
 * the file and runs the one activation command. Everything platform-specific
 * that can be a string is a string, and lives in the pure module.
 */

/** Resolved once here rather than inside the builders, so tests can inject it. */
export interface InstallOptions {
  platform?: string;
  homeRoot?: string;
  /** Injected so a test never shells out. */
  run?: (command: string, args: string[], cwd: string) => { ok: boolean; message: string };
}

function defaultRun(command: string, args: string[], cwd: string) {
  const res = spawnSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf-8' });
  const message = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return { ok: res.status === 0, message };
}

function daemonPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'daemon.js');
}

export function appletHostInstall(opts: InstallOptions = {}): void {
  const platform = opts.platform ?? os.platform();
  if (!isSupportedServicePlatform(platform)) {
    printError(`No login-service mechanism for platform "${platform}".`);
    process.exitCode = 1;
    return;
  }
  const daemon = daemonPath();
  if (!fs.existsSync(daemon)) {
    // Same guard `startHost` carries: under `npm run dev` there is no dist.
    printError(`Applet host daemon not found at ${daemon}. Run \`npm run build\` first.`);
    process.exitCode = 1;
    return;
  }
  const homeRoot = opts.homeRoot ?? os.homedir();
  const unit = serviceUnit(platform, {
    nodePath: process.execPath,
    daemonPath: daemon,
    logPath: APPLET_HOST_LOG_FILE,
  });
  const target = serviceUnitPath(platform, homeRoot, unit);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Plain write, not `atomicWriteFileSync`: systemd and launchd both watch
  // these directories, and a temp-then-rename briefly presents a `.tmp` unit.
  fs.writeFileSync(target, unit.contents, 'utf-8');
  printInfo(`Wrote ${target}`);

  if (unit.activate) {
    const run = opts.run ?? defaultRun;
    const res = run(unit.activate.command, unit.activate.args, path.dirname(target));
    if (!res.ok) {
      printError(
        `Wrote the unit but could not activate it: ${unit.activate.command} failed. ${res.message}`,
      );
      process.exitCode = 1;
      return;
    }
  }
  printInfo('The applet host will start at login.');
}

export function appletHostUninstall(opts: InstallOptions = {}): void {
  const platform = opts.platform ?? os.platform();
  if (!isSupportedServicePlatform(platform)) {
    printError(`No login-service mechanism for platform "${platform}".`);
    process.exitCode = 1;
    return;
  }
  const homeRoot = opts.homeRoot ?? os.homedir();
  const unit = serviceUnit(platform, {
    nodePath: process.execPath,
    daemonPath: daemonPath(),
    logPath: APPLET_HOST_LOG_FILE,
  });
  const target = serviceUnitPath(platform as ServicePlatform, homeRoot, unit);

  // Deactivate BEFORE removing the file: `systemctl --user disable` reads the
  // unit to know what to unlink, and launchctl needs it to exist to unload.
  if (unit.deactivate && fs.existsSync(target)) {
    const run = opts.run ?? defaultRun;
    run(unit.deactivate.command, unit.deactivate.args, path.dirname(target));
  }
  if (!fs.existsSync(target)) {
    printInfo('Not installed.');
    return;
  }
  fs.rmSync(target, { force: true });
  printInfo(`Removed ${target}. The applet host will no longer start at login.`);
}

/** Whether the unit file is present, for `applet-host status`. */
export function isServiceInstalled(opts: InstallOptions = {}): boolean {
  const platform = opts.platform ?? os.platform();
  if (!isSupportedServicePlatform(platform)) return false;
  const homeRoot = opts.homeRoot ?? os.homedir();
  const unit = serviceUnit(platform, {
    nodePath: process.execPath,
    daemonPath: daemonPath(),
    logPath: APPLET_HOST_LOG_FILE,
  });
  return fs.existsSync(serviceUnitPath(platform, homeRoot, unit));
}
