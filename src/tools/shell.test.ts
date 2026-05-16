import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDangerous, isSafelisted, BERNARD_TMP_PREFIX, createShellTool } from './shell.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const { execSync } = await import('node:child_process');

describe('isDangerous', () => {
  describe('detects dangerous commands', () => {
    it.each([
      ['rm -rf /', 'rm -rf'],
      ['rm -f file.txt', 'rm -f'],
      ['sudo apt install foo', 'sudo'],
      ['mkfs.ext4 /dev/sda1', 'mkfs'],
      ['dd if=/dev/zero of=/dev/sda', 'dd'],
      ['chmod 777 /etc/passwd', 'chmod 777'],
      ['chown -R root:root /', 'chown -R'],
      ['reboot', 'reboot'],
      ['shutdown -h now', 'shutdown'],
      ['systemctl stop nginx', 'systemctl stop'],
      ['systemctl disable sshd', 'systemctl disable'],
      ['systemctl mask firewalld', 'systemctl mask'],
      ['kill -9 1234', 'kill -9'],
      ['pkill node', 'pkill'],
      ['killall nginx', 'killall'],
    ])('detects "%s" as dangerous (%s)', (command) => {
      expect(isDangerous(command)).toBe(true);
    });
  });

  describe('allows safe commands', () => {
    it.each([
      'ls -la',
      'cat file.txt',
      'git status',
      'npm install',
      'rm file.txt',
      'chmod 644 file.txt',
      'echo hello',
      'grep pattern file',
      'mkdir -p foo/bar',
    ])('allows "%s"', (command) => {
      expect(isDangerous(command)).toBe(false);
    });
  });
});

describe('isSafelisted', () => {
  const tmp = os.tmpdir();
  const bernardA = `${BERNARD_TMP_PREFIX}task.sh`;
  const bernardB = `${BERNARD_TMP_PREFIX}other.py`;

  it('safelists rm -f on a single Bernard tmp script', () => {
    expect(isSafelisted(`rm -f ${bernardA}`)).toBe(true);
  });

  it('safelists rm -rf on multiple Bernard tmp paths', () => {
    expect(isSafelisted(`rm -rf ${bernardA} ${bernardB}`)).toBe(true);
  });

  it('does not safelist rm on non-Bernard tmp paths', () => {
    expect(isSafelisted(`rm -rf ${path.join(tmp, 'something-else')}`)).toBe(false);
  });

  it('does not safelist rm under the user home directory', () => {
    expect(isSafelisted('rm -rf ~/.config/bernard')).toBe(false);
  });

  it('rejects commands with shell metacharacters even if the prefix matches', () => {
    expect(isSafelisted(`rm -rf ${bernardA} && rm -rf /`)).toBe(false);
    expect(isSafelisted(`rm -rf ${bernardA}; rm -rf /`)).toBe(false);
    expect(isSafelisted(`rm -rf ${bernardA} | tee out`)).toBe(false);
    expect(isSafelisted(`rm -rf $(echo ${bernardA})`)).toBe(false);
  });

  it('does not safelist rm with no path arguments', () => {
    expect(isSafelisted('rm -rf')).toBe(false);
  });

  it('does not safelist non-rm commands', () => {
    expect(isSafelisted(`cat ${bernardA}`)).toBe(false);
    expect(isSafelisted(`sudo ls ${bernardA}`)).toBe(false);
  });
});

describe('createShellTool', () => {
  let confirmDangerous: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    confirmDangerous = vi.fn();
  });

  it('executes a safe command and returns output', async () => {
    vi.mocked(execSync).mockReturnValue('hello world');
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'echo hello' }, {} as any);
    expect(result).toEqual({ output: 'hello world', is_error: false });
    expect(confirmDangerous).not.toHaveBeenCalled();
  });

  it('returns "(no output)" for empty stdout', async () => {
    vi.mocked(execSync).mockReturnValue('');
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'true' }, {} as any);
    expect(result).toEqual({ output: '(no output)', is_error: false });
  });

  it('calls confirmDangerous for dangerous commands', async () => {
    confirmDangerous.mockResolvedValue(true);
    vi.mocked(execSync).mockReturnValue('done');
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'rm -rf /tmp/test' }, {} as any);
    expect(confirmDangerous).toHaveBeenCalledWith('rm -rf /tmp/test', undefined);
    expect(result).toEqual({ output: 'done', is_error: false });
  });

  it('forwards the abort signal to confirmDangerous', async () => {
    confirmDangerous.mockResolvedValue(true);
    vi.mocked(execSync).mockReturnValue('done');
    const controller = new AbortController();
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    await shellTool.execute({ command: 'rm -rf /tmp/test' }, {
      abortSignal: controller.signal,
    } as any);
    expect(confirmDangerous).toHaveBeenCalledWith('rm -rf /tmp/test', controller.signal);
  });

  it('skips confirmDangerous for safelisted Bernard tmp cleanup', async () => {
    vi.mocked(execSync).mockReturnValue('');
    const tmpFile = `${BERNARD_TMP_PREFIX}task.sh`;
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: `rm -f ${tmpFile}` }, {} as any);
    expect(confirmDangerous).not.toHaveBeenCalled();
    expect(execSync).toHaveBeenCalled();
    expect(result.is_error).toBe(false);
  });

  it('cancels command when user declines', async () => {
    confirmDangerous.mockResolvedValue(false);
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'rm -rf /tmp/test' }, {} as any);
    expect(result).toEqual({ output: 'Command cancelled by user.', is_error: false });
    expect(execSync).not.toHaveBeenCalled();
  });

  it('returns error on command failure', async () => {
    vi.mocked(execSync).mockImplementation(() => {
      const err = new Error('Command failed') as any;
      err.stderr = 'permission denied';
      err.stdout = '';
      throw err;
    });
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'cat /root/secret' }, {} as any);
    expect(result.is_error).toBe(true);
    expect(result.output).toContain('permission denied');
  });
});
