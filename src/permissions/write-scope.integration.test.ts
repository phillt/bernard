import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { augmentTools } from '../tools/augment.js';
import { createFileTools } from '../tools/file.js';
import { ToolProfileStore } from '../tool-profiles.js';
import type { WriteScope } from './write-scope.js';

/**
 * The write-scope gate against the REAL file tools (#340).
 *
 * Deliberately narrow. `augment.test.ts` already covers the gate's decisions
 * against a stub — allow inside, refuse outside, honour a grant, skip reads,
 * unrestricted with no scope — and restating those here buys nothing but four
 * real-filesystem round trips.
 *
 * What a stub CANNOT falsify is the pair below: that the gate's `args.path`
 * read and its `WRITE_PATH_TOOLS` name match line up with the real tools'
 * actual signatures, and that a refusal leaves no file on disk. The second is
 * the acceptance criterion of #340, and it is only statable against a real
 * filesystem.
 */
describe('write scope against the real file tools (#340)', () => {
  let root: string;
  let workspace: string;
  let outside: string;
  let store: ToolProfileStore;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-scope-int-')));
    workspace = path.join(root, 'workspace');
    outside = path.join(root, 'outside');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    store = new ToolProfileStore({ seed: false });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function tools(scope?: WriteScope) {
    const base = createFileTools();
    return augmentTools(base as never, {
      profileStore: store,
      ...(scope ? { writeScope: scope } : {}),
    });
  }

  // The acceptance criterion, stated as an assertion about the filesystem
  // rather than about a return value: the file must not exist afterwards.
  it('refuses a write outside the workspace, and no file appears', async () => {
    const target = path.join(outside, 'pwned.txt');
    const out = await tools({ workspace }).file_write.execute(
      { path: target, content: 'HELLO' },
      {},
    );
    expect(fs.existsSync(target)).toBe(false);
    expect(JSON.stringify(out)).toContain(workspace);
  });

  it('refuses file_edit_lines outside the workspace too', async () => {
    const target = path.join(outside, 'existing.txt');
    fs.writeFileSync(target, 'before');
    await tools({ workspace }).file_edit_lines.execute(
      { path: target, mode: 'append', content: 'after' },
      {},
    );
    expect(fs.readFileSync(target, 'utf-8')).toBe('before');
  });
});
