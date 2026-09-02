import { describe, it, expect, vi, afterEach } from 'vitest';
import { withStdoutRedirectedToStderr } from './stdout-guard.js';

describe('withStdoutRedirectedToStderr', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    while (spies.length) spies.pop()?.mockRestore();
  });

  function captureStderr(): string[] {
    const seen: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      seen.push(String(c));
      return true;
    });
    spies.push(spy);
    return seen;
  }

  it('sends stdout writes to stderr while the callback runs', async () => {
    const stderr = captureStderr();
    await withStdoutRedirectedToStderr(async () => {
      process.stdout.write('chatter from a tool\n');
    });
    expect(stderr.join('')).toContain('chatter from a tool');
  });

  it('restores stdout afterwards', async () => {
    const before = process.stdout.write;
    await withStdoutRedirectedToStderr(async () => {});
    expect(process.stdout.write).toBe(before);
  });

  // A throw mid-run must not leave the process with a permanently hijacked
  // stdout — every later write in the process would silently go to stderr.
  it('restores stdout even when the callback throws', async () => {
    const before = process.stdout.write;
    await expect(
      withStdoutRedirectedToStderr(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(process.stdout.write).toBe(before);
  });

  it('returns the callback value', async () => {
    await expect(withStdoutRedirectedToStderr(async () => 42)).resolves.toBe(42);
  });
});
