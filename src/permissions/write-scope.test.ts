import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkWritePath, isContainedIn, resolveForComparison } from './write-scope.js';

describe('isContainedIn', () => {
  it('accepts the directory itself and anything beneath it', () => {
    expect(isContainedIn('/safe', '/safe')).toBe(true);
    expect(isContainedIn('/safe', path.join('/safe', 'a', 'b.txt'))).toBe(true);
  });

  // A bare `startsWith` matches this, and the allowlist would read as scoped
  // while granting a sibling directory. #340 names this trap explicitly.
  it('does not match a sibling whose name merely shares the prefix', () => {
    expect(isContainedIn('/safe', '/safe-evil')).toBe(false);
    expect(isContainedIn('/safe', '/safe-evil/x.txt')).toBe(false);
  });

  it('tolerates a trailing separator on the parent', () => {
    expect(isContainedIn('/safe' + path.sep, path.join('/safe', 'a'))).toBe(true);
  });
});

describe('checkWritePath', () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-scope-')));
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('allows a write inside the workspace', () => {
    expect(checkWritePath({ workspace }, path.join(workspace, 'out.txt'))).toBeNull();
  });

  it('allows a write into a not-yet-existing subdirectory of the workspace', () => {
    const target = path.join(workspace, 'nested', 'deep', 'out.txt');
    expect(checkWritePath({ workspace }, target)).toBeNull();
  });

  it('refuses a write outside the workspace', () => {
    expect(checkWritePath({ workspace }, path.join(root, 'elsewhere.txt'))).not.toBeNull();
  });

  // The caller is generated code with no operator watching: a bare "denied"
  // gets retried against the same path forever.
  it('names the workspace in the refusal', () => {
    expect(checkWritePath({ workspace }, path.join(root, 'elsewhere.txt'))).toContain(workspace);
  });

  it('names explicit grants in the refusal too', () => {
    const granted = path.join(root, 'granted');
    fs.mkdirSync(granted);
    expect(checkWritePath({ workspace, grants: [granted] }, path.join(root, 'nope.txt'))).toContain(
      granted,
    );
  });

  it('allows a write inside an explicit grant', () => {
    const granted = path.join(root, 'granted');
    fs.mkdirSync(granted);
    expect(
      checkWritePath({ workspace, grants: [granted] }, path.join(granted, 'a.txt')),
    ).toBeNull();
  });

  it('refuses traversal out of the workspace via ..', () => {
    const target = path.join(workspace, '..', 'escape.txt');
    expect(checkWritePath({ workspace }, target)).not.toBeNull();
  });

  // Without resolving the nearest existing ancestor, a symlinked parent lets
  // the write land anywhere the link points — the allowlist becomes decoration.
  it('refuses a write through a symlink that escapes the workspace', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(workspace, 'link');
    try {
      fs.symlinkSync(outside, link, 'dir');
    } catch {
      return; // symlinks unavailable (e.g. unprivileged Windows) — skip
    }
    expect(checkWritePath({ workspace }, path.join(link, 'pwned.txt'))).not.toBeNull();
  });

  it('allows a grant that is itself reached through a symlink', () => {
    const real = path.join(root, 'real-target');
    fs.mkdirSync(real);
    const link = path.join(root, 'link-to-target');
    try {
      fs.symlinkSync(real, link, 'dir');
    } catch {
      return;
    }
    // Granted by its link name, written to by its real name.
    expect(checkWritePath({ workspace, grants: [link] }, path.join(real, 'a.txt'))).toBeNull();
  });

  it('refuses an empty or non-string path', () => {
    expect(checkWritePath({ workspace }, '')).not.toBeNull();
    expect(checkWritePath({ workspace }, '   ')).not.toBeNull();
    expect(checkWritePath({ workspace }, undefined as unknown as string)).not.toBeNull();
  });
});

describe('resolveForComparison', () => {
  it('removes .. segments even when nothing on the path exists', () => {
    const p = resolveForComparison('/definitely/not/real/../here.txt');
    expect(p).not.toContain('..');
    expect(p).toBe(path.resolve('/definitely/not/here.txt'));
  });
});
