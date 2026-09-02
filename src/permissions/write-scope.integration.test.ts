import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { augmentTools } from '../tools/augment.js';
import { createFileTools } from '../tools/file.js';
import { ToolProfileStore } from '../tool-profiles.js';

/**
 * The write-scope gate against the REAL file tools (#340).
 *
 * `augment.test.ts` covers the gate with a stub tool, which proves the wiring.
 * This proves the acceptance criteria: a run with a workspace can actually
 * create a file in it, and actually cannot create one outside it. The
 * difference matters because the gate keys on `WRITE_PATH_TOOLS` by name and
 * reads `args.path` — both are assumptions about the real tools that a stub
 * cannot falsify.
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

  function tools(scope?: { workspace: string; grants?: string[] }) {
    const base = createFileTools();
    return augmentTools(base as never, {
      profileStore: store,
      ...(scope ? { getWriteScope: () => scope } : {}),
    });
  }

  it('writes a file inside the workspace', async () => {
    const target = path.join(workspace, 'notes.txt');
    await tools({ workspace }).file_write.execute({ path: target, content: 'HELLO' }, {});
    expect(fs.readFileSync(target, 'utf-8')).toBe('HELLO');
  });

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

  it('writes into an explicitly granted directory', async () => {
    const target = path.join(outside, 'allowed.txt');
    await tools({ workspace, grants: [outside] }).file_write.execute(
      { path: target, content: 'OK' },
      {},
    );
    expect(fs.readFileSync(target, 'utf-8')).toBe('OK');
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

  it('still reads outside the workspace — this gate bounds writes, not reads', async () => {
    const target = path.join(outside, 'readable.txt');
    fs.writeFileSync(target, 'visible');
    const out = await tools({ workspace }).file_read_lines.execute({ path: target }, {});
    expect(JSON.stringify(out)).toContain('visible');
  });

  // No scope configured is the interactive default and must stay unrestricted.
  it('writes anywhere when no scope is configured', async () => {
    const target = path.join(outside, 'interactive.txt');
    await tools().file_write.execute({ path: target, content: 'FREE' }, {});
    expect(fs.readFileSync(target, 'utf-8')).toBe('FREE');
  });
});
