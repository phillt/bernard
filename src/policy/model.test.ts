import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// `modelPolicy` ultimately calls `resolveSiteModel`, which reads
// `~/.config/bernard/lineups.json`. Without isolating `BERNARD_HOME` before
// `paths.ts` is imported (paths are frozen at module load), the test would
// touch the developer's real config. We reset modules + redirect `BERNARD_HOME`
// in `beforeEach` and dynamically import everything that transitively depends
// on it.
describe('modelPolicy', () => {
  let tmpDir: string;
  let origHome: string | undefined;
  let MODEL_COMPONENTS: typeof import('./model.js').MODEL_COMPONENTS;
  let modelPolicy: typeof import('./model.js').modelPolicy;
  let makePolicyInput: typeof import('./test-helpers.js').makePolicyInput;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-policy-model-'));
    origHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = tmpDir;
    vi.resetModules();
    ({ MODEL_COMPONENTS, modelPolicy } = await import('./model.js'));
    ({ makePolicyInput } = await import('./test-helpers.js'));
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.BERNARD_HOME;
    else process.env.BERNARD_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves each component via the active lineup', () => {
    const result = modelPolicy(makePolicyInput({ config: { provider: 'openai' } }));
    expect(result.reason).toBe('lineup-resolved');
    for (const key of MODEL_COMPONENTS) {
      expect(result.models[key].provider).toBeTruthy();
      expect(result.models[key].model).toBeTruthy();
    }
  });

  it('emits exactly the known component keys (no extras, no gaps)', () => {
    const result = modelPolicy(makePolicyInput());
    expect(Object.keys(result.models).sort()).toEqual([...MODEL_COMPONENTS].sort());
  });
});
