import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isDangerous, createShellTool } from './shell.js';

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
    expect(confirmDangerous).toHaveBeenCalledWith('rm -rf /tmp/test');
    expect(result).toEqual({ output: 'done', is_error: false });
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
