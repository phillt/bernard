import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

const fs = await import('node:fs');
const { atomicWriteFileSync, atomicWriteFileSyncUnique } = await import('./fs-utils.js');

describe('atomicWriteFileSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes to a .tmp file before renaming', () => {
    atomicWriteFileSync('/some/dir/file.json', '{"key":"value"}');
    // Both must have been called; verify order via mock.invocationCallOrder
    const writtenOrder = vi.mocked(fs.writeFileSync).mock.invocationCallOrder[0];
    const renamedOrder = vi.mocked(fs.renameSync).mock.invocationCallOrder[0];
    expect(writtenOrder).toBeLessThan(renamedOrder);
  });

  it('writes to filePath + .tmp', () => {
    atomicWriteFileSync('/some/dir/file.json', 'data');
    expect(fs.writeFileSync).toHaveBeenCalledWith('/some/dir/file.json.tmp', 'data', 'utf-8');
  });

  it('renames tmp to the original filePath', () => {
    atomicWriteFileSync('/some/dir/file.json', 'data');
    expect(fs.renameSync).toHaveBeenCalledWith('/some/dir/file.json.tmp', '/some/dir/file.json');
  });

  it('passes utf-8 encoding to writeFileSync', () => {
    atomicWriteFileSync('/path/to/config.json', '{}');
    const [, , encoding] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, string, string];
    expect(encoding).toBe('utf-8');
  });

  it('writes the exact data string provided', () => {
    const data = '{"hello":"world","n":42}';
    atomicWriteFileSync('/tmp/test.json', data);
    const [, writtenData] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, string, string];
    expect(writtenData).toBe(data);
  });

  it('tmp path is always filePath + ".tmp" for various inputs', () => {
    const cases = ['/a/b/c.json', '/no-extension', '/path/with.dots/file.json'];
    for (const filePath of cases) {
      vi.clearAllMocks();
      atomicWriteFileSync(filePath, 'x');
      expect(fs.writeFileSync).toHaveBeenCalledWith(filePath + '.tmp', 'x', 'utf-8');
      expect(fs.renameSync).toHaveBeenCalledWith(filePath + '.tmp', filePath);
    }
  });
});

/**
 * The unique-suffix variant (#533).
 *
 * Its whole reason for existing over {@link atomicWriteFileSync} is that
 * `memories.json` has four writers, so a shared `.tmp` means two concurrent
 * persists write one file and rename it twice. The unlink is what makes that
 * safe: a fixed suffix left ONE orphan that the next write overwrote, while a
 * unique one leaves a distinct ~31 MB file per failure and nothing sweeps them.
 */
describe('atomicWriteFileSyncUnique', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes to a temp path nobody else can collide with, then renames', () => {
    expect(atomicWriteFileSyncUnique('/x/store.json', 'data')).toBeNull();
    const tmp = vi.mocked(fs.writeFileSync).mock.calls[0][0] as string;
    expect(tmp).toMatch(/^\/x\/store\.json\.\d+\.[0-9a-f]{8}\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalledWith(tmp, '/x/store.json');
  });

  it('picks a different temp path each call', () => {
    atomicWriteFileSyncUnique('/x/store.json', 'a');
    atomicWriteFileSyncUnique('/x/store.json', 'b');
    const [first, second] = vi.mocked(fs.writeFileSync).mock.calls.map((c) => c[0]);
    expect(first).not.toBe(second);
  });

  it('unlinks the temp file when the rename fails, so nothing is orphaned', () => {
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('EXDEV');
    });
    const failure = atomicWriteFileSyncUnique('/x/store.json', 'data');
    expect(failure).toContain('EXDEV');
    const tmp = vi.mocked(fs.writeFileSync).mock.calls[0][0];
    expect(fs.unlinkSync).toHaveBeenCalledWith(tmp);
  });

  it('reports rather than throws, so a best-effort caller can stay silent', () => {
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => atomicWriteFileSyncUnique('/x/store.json', 'd')).not.toThrow();
    expect(atomicWriteFileSyncUnique('/x/store.json', 'd')).toBeNull();
  });
});
