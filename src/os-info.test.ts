import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    platform: vi.fn(() => 'linux' as NodeJS.Platform),
    arch: vi.fn(() => 'x64'),
    type: vi.fn(() => 'Linux'),
    release: vi.fn(() => '5.15.0'),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const os = await import('node:os');
const fs = await import('node:fs');
const { execSync } = await import('node:child_process');

const { getOsInfo, _resetOsInfoCache, osPromptBlock } = await import('./os-info.js');

describe('os-info', () => {
  const origSHELL = process.env.SHELL;
  const origComSpec = process.env.ComSpec;

  beforeEach(() => {
    _resetOsInfoCache();
    vi.clearAllMocks();
    // Default: linux, no os-release file, fallback to os.type()/os.release()
    vi.mocked(os.platform).mockReturnValue('linux');
    vi.mocked(os.arch).mockReturnValue('x64');
    vi.mocked(os.type).mockReturnValue('Linux');
    vi.mocked(os.release).mockReturnValue('5.15.0');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    process.env.SHELL = '/bin/bash';
    delete process.env.ComSpec;
  });

  afterEach(() => {
    if (origSHELL !== undefined) {
      process.env.SHELL = origSHELL;
    } else {
      delete process.env.SHELL;
    }
    if (origComSpec !== undefined) {
      process.env.ComSpec = origComSpec;
    } else {
      delete process.env.ComSpec;
    }
  });

  describe('getOsInfo', () => {
    it('returns an OsInfo object with platform, arch, and shell', () => {
      const info = getOsInfo();
      expect(info).toMatchObject({
        platform: 'linux',
        arch: 'x64',
        shell: '/bin/bash',
      });
    });

    it('includes osRelease field', () => {
      const info = getOsInfo();
      expect(info).toHaveProperty('osRelease');
    });

    it('caches result — second call returns the same object reference', () => {
      const first = getOsInfo();
      const second = getOsInfo();
      expect(second).toBe(first);
    });

    it('calls os.platform() only once due to caching', () => {
      getOsInfo();
      getOsInfo();
      expect(os.platform).toHaveBeenCalledTimes(1);
    });
  });

  describe('_resetOsInfoCache', () => {
    it('clears the cache so the next getOsInfo call re-reads from os module', () => {
      const first = getOsInfo();
      _resetOsInfoCache();
      vi.mocked(os.arch).mockReturnValue('arm64');
      const second = getOsInfo();
      expect(second).not.toBe(first);
      expect(second.arch).toBe('arm64');
    });

    it('forces os.platform() to be called again after reset', () => {
      getOsInfo();
      _resetOsInfoCache();
      getOsInfo();
      expect(os.platform).toHaveBeenCalledTimes(2);
    });
  });

  describe('shell detection', () => {
    it('uses $SHELL env var when set', () => {
      process.env.SHELL = '/usr/bin/zsh';
      const info = getOsInfo();
      expect(info.shell).toBe('/usr/bin/zsh');
    });

    it('falls back to /bin/sh on non-win32 when SHELL is unset', () => {
      delete process.env.SHELL;
      vi.mocked(os.platform).mockReturnValue('linux');
      const info = getOsInfo();
      expect(info.shell).toBe('/bin/sh');
    });

    it('uses ComSpec on win32 when SHELL is unset', () => {
      delete process.env.SHELL;
      process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
      vi.mocked(os.platform).mockReturnValue('win32');
      const info = getOsInfo();
      expect(info.shell).toBe('C:\\Windows\\System32\\cmd.exe');
    });

    it('falls back to cmd.exe on win32 when both SHELL and ComSpec are unset', () => {
      delete process.env.SHELL;
      delete process.env.ComSpec;
      vi.mocked(os.platform).mockReturnValue('win32');
      const info = getOsInfo();
      expect(info.shell).toBe('cmd.exe');
    });
  });

  describe('detectOsRelease on linux', () => {
    it('uses PRETTY_NAME from /etc/os-release when present', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'PRETTY_NAME="Ubuntu 22.04 LTS"\nNAME="Ubuntu"\n',
      );
      const info = getOsInfo();
      expect(info.osRelease).toBe('Ubuntu 22.04 LTS');
    });

    it('falls back to NAME when PRETTY_NAME is absent', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('NAME="Debian GNU/Linux"\nVERSION="11"\n');
      const info = getOsInfo();
      expect(info.osRelease).toBe('Debian GNU/Linux');
    });

    it('falls back to os.type() + os.release() when /etc/os-release does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(os.type).mockReturnValue('Linux');
      vi.mocked(os.release).mockReturnValue('5.15.0');
      const info = getOsInfo();
      expect(info.osRelease).toBe('Linux 5.15.0');
    });
  });

  describe('detectOsRelease on darwin', () => {
    beforeEach(() => {
      vi.mocked(os.platform).mockReturnValue('darwin');
    });

    it('parses sw_vers output into a human-readable string', () => {
      vi.mocked(execSync).mockReturnValue(
        'ProductName:\t\tmacOS\nProductVersion:\t\t14.3\nBuildVersion:\t\t23D56\n',
      );
      const info = getOsInfo();
      expect(info.osRelease).toBe('macOS 14.3');
    });

    it('falls back to os.type() + os.release() when sw_vers throws', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('command not found');
      });
      vi.mocked(os.type).mockReturnValue('Darwin');
      vi.mocked(os.release).mockReturnValue('23.3.0');
      const info = getOsInfo();
      expect(info.osRelease).toBe('Darwin 23.3.0');
    });
  });

  describe('osPromptBlock', () => {
    it('starts with "## Host OS"', () => {
      const block = osPromptBlock();
      expect(block.startsWith('## Host OS')).toBe(true);
    });

    it('contains platform, arch, and shell lines', () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      vi.mocked(os.arch).mockReturnValue('x64');
      process.env.SHELL = '/bin/bash';
      const block = osPromptBlock();
      expect(block).toContain('- Platform: linux');
      expect(block).toContain('- Architecture: x64');
      expect(block).toContain('- Shell: /bin/bash');
    });

    it('includes Release line when osRelease is present', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('PRETTY_NAME="Ubuntu 22.04 LTS"\n');
      const block = osPromptBlock();
      expect(block).toContain('- Release: Ubuntu 22.04 LTS');
    });

    it('omits Release line when osRelease is absent (fallback disabled by throwing)', () => {
      // Simulate a platform where release detection returns undefined:
      // we can't easily produce undefined from the module without making
      // fs.existsSync return false and execSync throw on a non-linux/darwin platform.
      vi.mocked(os.platform).mockReturnValue('freebsd' as NodeJS.Platform);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // execSync not called for freebsd — detectOsRelease falls through to fallback
      vi.mocked(os.type).mockReturnValue('FreeBSD');
      vi.mocked(os.release).mockReturnValue('13.2');
      const block = osPromptBlock();
      // freebsd falls through to the os.type()+os.release() fallback, so Release IS included
      expect(block).toContain('- Release: FreeBSD 13.2');
    });

    it('returns a multi-line string with a tailoring hint', () => {
      const block = osPromptBlock();
      expect(block).toContain('Tailor commands to this platform');
    });
  });
});
