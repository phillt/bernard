import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSpawn, mockFork, mockExistsSync, mockWriteFileSync, mockReadFileSync, mockUnlinkSync } =
  vi.hoisted(() => ({
    mockSpawn: vi.fn(() => ({ pid: 4242, unref: vi.fn() })),
    mockFork: vi.fn(() => ({ pid: 4242, unref: vi.fn() })),
    mockExistsSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockUnlinkSync: vi.fn(),
  }));

// Both are stubbed so the test can say which one was reached. Asserting only on
// `spawn` would pass while `fork` ran too, and a source scan would pin the
// spelling rather than the behaviour.
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  fork: (...args: unknown[]) => mockFork(...args),
}));

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
}));

vi.mock('./store.js', () => ({
  CronStore: { pidFile: '/tmp/bernard-test-cron.pid' },
}));

const { startDaemon } = await import('./client.js');

describe('startDaemon (#586)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No PID file, so `isDaemonRunning` is false; `daemon.js` present, so the
    // build check passes. Both questions are answered by `existsSync`, and the
    // PID file is asked about first.
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('daemon.js'));
  });

  /**
   * The whole of #586. `fork` always opens an IPC channel, and that channel
   * keeps the PARENT's event loop alive past `child.unref()` — so a caller
   * whose only job is starting the daemon would never exit. We never talk to
   * this process, so it must not have a channel to talk on.
   */
  it('starts the daemon with spawn, never fork', () => {
    expect(startDaemon()).toBe(true);

    expect(mockFork).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  // `fork` implied the child was a Node script run with the same executable;
  // `spawn` has to say so.
  it('runs daemon.js with this process own node executable', () => {
    startDaemon();

    const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe(process.execPath);
    expect(args).toHaveLength(1);
    expect(args[0].endsWith('daemon.js')).toBe(true);
  });

  // #586 changes how the child is started and nothing else. Detach, the
  // ignored stdio and the PID record are all load-bearing and all unchanged.
  it('still detaches, still ignores stdio, still records the pid', () => {
    startDaemon();

    const opts = mockSpawn.mock.calls[0]?.[2] as { detached: boolean; stdio: string };
    expect(opts).toEqual({ detached: true, stdio: 'ignore' });
    expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/bernard-test-cron.pid', '4242', 'utf-8');
  });

  it('unrefs the child handle', () => {
    startDaemon();

    const child = mockSpawn.mock.results[0]?.value as { unref: ReturnType<typeof vi.fn> };
    expect(child.unref).toHaveBeenCalled();
  });

  it('refuses to start when the compiled daemon is missing', () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => startDaemon()).toThrow(/npm run build/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does not start a second daemon when one is already running', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('4242\n');
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    expect(startDaemon()).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();

    kill.mockRestore();
  });
});
