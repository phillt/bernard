import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from './__tests__/temp-home.js';

/**
 * The one-time migration off `CorrectionCandidateStore` (#564).
 *
 * Real disk and a fresh module graph per test, because the whole behaviour is
 * "what is on disk when a new build first asks for the queue" — `useTempHome`
 * already does the `vi.resetModules()` that makes the memoised getter run again.
 */
const home = useTempHome('correction-migration');

const legacyDir = () => path.join(home(), 'bernard', 'correction-candidates');

const writeLegacy = (name: string, row: Record<string, unknown>) => {
  fs.mkdirSync(legacyDir(), { recursive: true });
  fs.writeFileSync(path.join(legacyDir(), name), JSON.stringify(row));
};

const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  specialistId: 'shell-wrapper',
  input: 'list the files',
  attemptedCall: '{"command":"ls -Z"}',
  error: 'invalid option',
  status: 'pending',
  createdAt: new Date().toISOString(),
  ...over,
});

describe('migrateLegacyCandidates', () => {
  it('carries PENDING rows onto the queue instead of deleting them', async () => {
    // The rows were not all terminal. Deleting the directory outright — which the
    // first cut of this PR did — loses learning the user had already earned, and
    // the comment framed the deletion as removing only the 54 finished ones.
    writeLegacy('c1.json', candidate());
    writeLegacy('c2.json', candidate({ id: 'c2', status: 'applied' }));
    writeLegacy('c3.json', candidate({ id: 'c3', status: 'invalid' }));

    const { correctionQueue } = await import('./correction-queue.js');
    const items = correctionQueue().peek();

    expect(items).toHaveLength(1);
    expect(items[0].payload).toMatchObject({
      specialistId: 'shell-wrapper',
      error: 'invalid option',
    });
    // And the terminal rows are gone, which is the half the deletion was for.
    expect(fs.existsSync(legacyDir())).toBe(false);
  });

  it('leaves a directory it does not recognise exactly where it is', async () => {
    // `rmSync(recursive, force)` on a path built from `DATA_DIR` can never be
    // undone, so it refuses anything not shaped like the store being replaced
    // rather than trusting the path alone.
    fs.mkdirSync(path.join(legacyDir(), 'unexpected'), { recursive: true });
    writeLegacy('c1.json', candidate());

    const { correctionQueue } = await import('./correction-queue.js');
    expect(correctionQueue().peek()).toHaveLength(0);
    expect(fs.existsSync(legacyDir())).toBe(true);
  });

  it('is a no-op when there is nothing to migrate', async () => {
    const { correctionQueue } = await import('./correction-queue.js');
    expect(correctionQueue().peek()).toHaveLength(0);
    expect(fs.existsSync(legacyDir())).toBe(false);
  });

  it('does not let one unreadable row strand the others', async () => {
    // Otherwise the directory survives forever because of a single bad file.
    writeLegacy('c1.json', candidate());
    fs.writeFileSync(path.join(legacyDir(), 'c2.json'), '{"half":');

    const { correctionQueue } = await import('./correction-queue.js');
    expect(correctionQueue().peek()).toHaveLength(1);
    expect(fs.existsSync(legacyDir())).toBe(false);
  });
});
