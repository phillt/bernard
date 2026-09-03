import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  serviceUnit,
  serviceDirSegments,
  serviceUnitPath,
  isSupportedServicePlatform,
  SERVICE_LABEL,
} from './service.js';

const OPTS = {
  nodePath: '/usr/bin/node',
  daemonPath: '/opt/bernard/dist/host/daemon.js',
  logPath: '/home/u/.local/state/bernard/applet-host.log',
};

describe('serviceUnit', () => {
  // `ExecStart` is the node binary plus `dist/host/daemon.js`, never the
  // `bernard` shim — exactly what `startHost` spawns, and the one path
  // guaranteed to exist because `startHost` already errors when it does not.
  it('invokes node on the daemon directly, on every platform', () => {
    for (const p of ['linux', 'darwin', 'win32'] as const) {
      const unit = serviceUnit(p, OPTS);
      expect(unit.contents).toContain('/usr/bin/node');
      expect(unit.contents).toContain('/opt/bernard/dist/host/daemon.js');
      expect(unit.contents).not.toContain('bernard-agent');
    }
  });

  /**
   * `Restart=always` would fight `bernard applet-host stop`, which SIGTERMs a
   * daemon that then exits 0. And an `ExecStart` pointing at a deleted
   * `dist/` must give up rather than loop — npm does not run a preuninstall
   * hook for global packages, so an uninstalled Bernard leaves this file
   * behind and the burst limit is what stops it spinning.
   */
  it('restarts on failure only, and gives up', () => {
    const unit = serviceUnit('linux', OPTS);
    expect(unit.contents).toContain('Restart=on-failure');
    expect(unit.contents).not.toContain('Restart=always');
    expect(unit.contents).toContain('StartLimitBurst=');
  });

  it('produces a launchd plist that loads at login', () => {
    const unit = serviceUnit('darwin', OPTS);
    expect(unit.relativePath).toBe('com.bernard.applet-host.plist');
    expect(unit.contents).toContain('<key>RunAtLoad</key>');
    expect(unit.contents).toContain('<true/>');
    expect(unit.activate?.command).toBe('launchctl');
  });

  // The Startup folder needs no activation, which is the reason to prefer it
  // over `schtasks` — that can require elevation depending on policy, and the
  // issue's rule is that nothing here may need admin.
  it('needs no activation command on Windows', () => {
    const unit = serviceUnit('win32', OPTS);
    expect(unit.relativePath).toBe(`${SERVICE_LABEL}.cmd`);
    expect(unit.activate).toBeNull();
    expect(unit.contents).toContain('\r\n');
  });

  it('knows which platforms it can register on', () => {
    expect(isSupportedServicePlatform('linux')).toBe(true);
    expect(isSupportedServicePlatform('freebsd')).toBe(false);
  });

  it('places each unit in its platform-conventional directory', () => {
    expect(serviceDirSegments('linux')).toEqual(['.config', 'systemd', 'user']);
    expect(serviceDirSegments('darwin')).toEqual(['Library', 'LaunchAgents']);
    expect(serviceUnitPath('linux', '/home/u', serviceUnit('linux', OPTS))).toBe(
      `/home/u/.config/systemd/user/${SERVICE_LABEL}.service`,
    );
  });
});

describe('install isolation', () => {
  /**
   * The risk that matters in this file, and the reason the whole module takes
   * its home root as a parameter.
   *
   * `useTempHome` redirects `BERNARD_HOME`, and every path in `src/paths.ts`
   * follows it — but `~/.config/systemd/user` and `~/Library/LaunchAgents` are
   * the first paths in this repo that Bernard does not own, and `BERNARD_HOME`
   * deliberately does not redirect them. A builder that read `os.homedir()`
   * itself would write into the developer's real home the first time this ran,
   * and into CI's.
   */
  it('writes only under the injected root, never the real home', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-svc-'));
    try {
      const { appletHostInstall, appletHostUninstall, isServiceInstalled } =
        await import('./service-cli.js');
      const ran: string[] = [];
      const run = (command: string, args: string[]) => {
        ran.push(`${command} ${args.join(' ')}`);
        return { ok: true, message: '' };
      };
      const opts = { platform: 'linux', homeRoot: root, run };

      appletHostInstall(opts);
      const unit = path.join(root, '.config/systemd/user', `${SERVICE_LABEL}.service`);
      // The install may bail before writing if `dist/` is absent, which is a
      // legitimate outcome — but if it wrote anything, it wrote it HERE.
      if (fs.existsSync(unit)) {
        expect(isServiceInstalled(opts)).toBe(true);
        expect(ran[0]).toContain('systemctl --user enable --now');
        appletHostUninstall(opts);
        expect(fs.existsSync(unit)).toBe(false);
      }
      // Nothing outside the injected root, whatever happened.
      expect(
        fs.existsSync(path.join(os.homedir(), '.config/systemd/user', `${SERVICE_LABEL}.service`)),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a platform it has no mechanism for', async () => {
    const { appletHostInstall } = await import('./service-cli.js');
    const before = process.exitCode;
    appletHostInstall({ platform: 'freebsd', homeRoot: '/tmp/nope' });
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
  });
});
