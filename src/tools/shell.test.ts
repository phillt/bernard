import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDangerous, isSafelisted, BERNARD_TMP_PREFIX, createShellTool } from './shell.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const { spawnSync } = await import('node:child_process');

/** A successful run: stdout, no stderr, exit 0. */
const okRun = (stdout: string, stderr = '') =>
  ({ stdout, stderr, status: 0 }) as unknown as ReturnType<typeof spawnSync>;

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

  it('rejects path-traversal segments that would escape the tmp prefix', () => {
    expect(isSafelisted(`rm -rf ${bernardA}/../..`)).toBe(false);
    expect(isSafelisted(`rm -rf ${BERNARD_TMP_PREFIX}x/../../etc`)).toBe(false);
    expect(isSafelisted(`rm -rf ${bernardA} ${bernardB}/../..`)).toBe(false);
  });

  it('rejects glob characters in safelisted paths', () => {
    expect(isSafelisted(`rm -rf ${BERNARD_TMP_PREFIX}*`)).toBe(false);
    expect(isSafelisted(`rm -rf ${BERNARD_TMP_PREFIX}?ask.sh`)).toBe(false);
    expect(isSafelisted(`rm -rf ${BERNARD_TMP_PREFIX}[abc].sh`)).toBe(false);
    expect(isSafelisted(`rm -rf ${BERNARD_TMP_PREFIX}{a,b}.sh`)).toBe(false);
  });

  it('rejects quoted or expansion-bearing tokens', () => {
    expect(isSafelisted(`rm -rf '${bernardA}'`)).toBe(false);
    expect(isSafelisted(`rm -rf "${bernardA}"`)).toBe(false);
    expect(isSafelisted(`rm -rf $HOME/${bernardA}`)).toBe(false);
    expect(isSafelisted(`rm -rf \\\\${bernardA}`)).toBe(false);
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

  describe('meta.isWriteAction (#212 read-only classification)', () => {
    const isWriteAction = () =>
      createShellTool({ shellTimeout: 30000, confirmDangerous }).meta.isWriteAction!;

    it('classifies simple read-only commands as read-shaped', () => {
      expect(isWriteAction()({ command: 'ls -la' })).toBe(false);
      expect(isWriteAction()({ command: 'git status' })).toBe(false);
      expect(isWriteAction()({ command: 'cat package.json' })).toBe(false);
    });

    it('classifies write-capable and complex commands as writes', () => {
      expect(isWriteAction()({ command: 'rm -rf /' })).toBe(true);
      expect(isWriteAction()({ command: 'git push' })).toBe(true);
      expect(isWriteAction()({ command: 'ls | wc -l' })).toBe(true);
      expect(isWriteAction()({ command: 'ls\nrm -rf /' })).toBe(true);
    });

    it('treats missing/non-string command as a write (fail-safe)', () => {
      expect(isWriteAction()({})).toBe(true);
      expect(isWriteAction()(undefined)).toBe(true);
    });
  });

  it('executes a safe command and returns ok envelope', async () => {
    vi.mocked(spawnSync).mockReturnValue(okRun('hello world'));
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'echo hello' }, {});
    expect(result).toEqual({
      status: 'ok',
      result: { output: 'hello world', is_error: false },
    });
    expect(confirmDangerous).not.toHaveBeenCalled();
  });

  it('returns "(no output)" for empty stdout', async () => {
    vi.mocked(spawnSync).mockReturnValue(okRun(''));
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'true' }, {});
    expect(result).toEqual({
      status: 'ok',
      result: { output: '(no output)', is_error: false },
    });
  });

  it('calls confirmDangerous for dangerous commands', async () => {
    confirmDangerous.mockResolvedValue(true);
    vi.mocked(spawnSync).mockReturnValue(okRun('done'));
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'rm -rf /tmp/test' }, {});
    expect(confirmDangerous).toHaveBeenCalledWith('rm -rf /tmp/test', undefined);
    expect(result).toEqual({
      status: 'ok',
      result: { output: 'done', is_error: false },
    });
  });

  it('forwards the abort signal to confirmDangerous', async () => {
    confirmDangerous.mockResolvedValue(true);
    vi.mocked(spawnSync).mockReturnValue(okRun('done'));
    const controller = new AbortController();
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    await shellTool.execute(
      { command: 'rm -rf /tmp/test' },
      {
        abortSignal: controller.signal,
      },
    );
    expect(confirmDangerous).toHaveBeenCalledWith('rm -rf /tmp/test', controller.signal);
  });

  it('skips confirmDangerous for safelisted Bernard tmp cleanup', async () => {
    vi.mocked(spawnSync).mockReturnValue(okRun(''));
    const tmpFile = `${BERNARD_TMP_PREFIX}task.sh`;
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: `rm -f ${tmpFile}` }, {});
    expect(confirmDangerous).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalled();
    expect(result.status).toBe('ok');
  });

  it('cancels command when user declines (ok envelope, not error)', async () => {
    confirmDangerous.mockResolvedValue(false);
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'rm -rf /tmp/test' }, {});
    expect(result).toEqual({
      status: 'ok',
      result: { output: 'Command cancelled by user.', is_error: false },
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('does NOT prompt at all when confirmAction is wired — the unified gate owns it (#144/#212)', async () => {
    // When the unified gate is wired (the REPL), it gates dangerous shell calls
    // centrally and is profile-/session-/skip-permissions-aware. Shell must NOT
    // call confirmAction OR confirmDangerous itself — doing so double-prompts
    // and ignores every "always allow" / skip-permissions decision (#212).
    const confirmAction = vi.fn().mockResolvedValue(true);
    confirmDangerous.mockResolvedValue(true);
    vi.mocked(spawnSync).mockReturnValue(okRun('done'));
    const shellTool = createShellTool({
      shellTimeout: 30000,
      confirmDangerous,
      confirmAction,
    });
    await shellTool.execute({ command: 'rm -rf /tmp/test' }, {});
    expect(confirmAction).not.toHaveBeenCalled();
    expect(confirmDangerous).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalled();
  });

  it('falls back to confirmDangerous when confirmAction is not wired (#144)', async () => {
    confirmDangerous.mockResolvedValue(true);
    vi.mocked(spawnSync).mockReturnValue(okRun('done'));
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    await shellTool.execute({ command: 'rm -rf /tmp/test' }, {});
    expect(confirmDangerous).toHaveBeenCalledWith('rm -rf /tmp/test', undefined);
  });

  it('surfaces stderr when a command exits 0 with nothing on stdout', async () => {
    // The silent failure this exists to end. `execSync` returns stdout and
    // nothing else, so stderr was captured by the child and discarded — and it
    // throws only on a non-zero exit, which in a PIPELINE is the last stage's.
    // `rg foo src | head -5` with no `rg` installed exits 0, so the model was
    // handed "(no output)" with `is_error: false` and correctly concluded the
    // string it was hunting did not exist. It did, 46 times.
    vi.mocked(spawnSync).mockReturnValue(okRun('', '/bin/sh: 1: rg: not found\n'));
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'rg foo src | head -5' }, {});
    expect(result).toEqual({
      status: 'ok',
      // `is_error` stays false: the pipeline really did exit 0. Claiming
      // otherwise would mislabel every command that warns and succeeds.
      result: { output: '/bin/sh: 1: rg: not found\n', is_error: false },
    });
  });

  it('does NOT fold stderr in when the command produced real output', async () => {
    // The other half, and why this is not `[stdout, stderr].join()`. Plenty of
    // working commands write progress and warnings to stderr; folding that into
    // every result would put noise on the common path. Only the silent case —
    // nothing on stdout, something on stderr — is rewritten.
    vi.mocked(spawnSync).mockReturnValue(okRun('real output\n', 'a warning\n'));
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'build' }, {});
    expect(result).toEqual({
      status: 'ok',
      result: { output: 'real output\n', is_error: false },
    });
  });

  it('still reports a non-zero exit as an error, with both streams', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      stdout: 'partial\n',
      stderr: 'boom\n',
      status: 2,
    } as never);
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'thing' }, {});
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.message).toContain('partial');
      expect(result.error.message).toContain('boom');
    }
  });

  it('returns error envelope on command failure', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      stdout: '',
      stderr: 'permission denied',
      status: 1,
    } as never);
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const result = await shellTool.execute({ command: 'cat /root/secret' }, {});
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.type).toBe('exec_failed');
      expect(result.error.message).toContain('permission denied');
      expect(result.error.snippet).toContain('permission denied');
    }
  });

  it('serializeForModel preserves {output, is_error} bytes on ok and error', async () => {
    const shellTool = createShellTool({ shellTimeout: 30000, confirmDangerous });
    const okOut = shellTool.serializeForModel({
      status: 'ok',
      result: { output: 'hello', is_error: false },
    });
    expect(okOut).toEqual({ output: 'hello', is_error: false });

    const errOut = shellTool.serializeForModel({
      status: 'error',
      error: { type: 'exec_failed', message: 'permission denied' },
    });
    expect(errOut).toEqual({ output: 'permission denied', is_error: true });
  });
});
