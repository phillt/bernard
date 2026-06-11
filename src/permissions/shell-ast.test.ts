import { describe, it, expect, beforeAll } from 'vitest';
import { initShellParser, isShellParserReady, parseShellCommand } from './shell-ast.js';
import { resolveGrant } from './engine.js';
import type { PermissionRule } from '../tool-permissions.js';

const rule = (
  effect: PermissionRule['effect'],
  tool: string,
  specifier?: string,
): PermissionRule =>
  specifier === undefined ? { effect, tool, _v: 2 } : { effect, tool, specifier, _v: 2 };

describe('shell-ast (tree-sitter)', () => {
  beforeAll(async () => {
    await initShellParser();
  });

  it('loads the parser', () => {
    expect(isShellParserReady()).toBe(true);
  });

  it('parses a simple command', () => {
    expect(parseShellCommand('git status')).toEqual({
      kind: 'simple',
      program: 'git',
      command: 'git status',
    });
  });

  it('splits compound commands into independent subcommands', () => {
    const parsed = parseShellCommand('git status && npm test');
    expect(parsed.kind).toBe('compound');
    if (parsed.kind === 'compound') {
      expect(parsed.subcommands.map((s) => (s.kind === 'simple' ? s.command : '?'))).toEqual([
        'git status',
        'npm test',
      ]);
    }
  });

  it('splits ; and | the same way', () => {
    expect(parseShellCommand('git status; ls -la').kind).toBe('compound');
    expect(parseShellCommand('cat f | grep x').kind).toBe('compound');
  });

  it('fails closed on exec wrappers', () => {
    expect(parseShellCommand('bash -c "rm -rf /"')).toEqual({ kind: 'parse-error' });
    expect(parseShellCommand('sudo rm -rf /')).toEqual({ kind: 'parse-error' });
    expect(parseShellCommand('xargs -n1 rm')).toEqual({ kind: 'parse-error' });
  });

  it('fails closed on substitution, redirects, and variable assignment', () => {
    expect(parseShellCommand('echo $(whoami)')).toEqual({ kind: 'parse-error' });
    expect(parseShellCommand('cat foo > /etc/passwd')).toEqual({ kind: 'parse-error' });
    expect(parseShellCommand('FOO=bar git status')).toEqual({ kind: 'parse-error' });
    expect(parseShellCommand('echo $HOME')).toEqual({ kind: 'parse-error' });
  });

  it('fails closed on find -exec', () => {
    expect(parseShellCommand('find . -name x -exec rm {} ;')).toEqual({ kind: 'parse-error' });
    // plain find is fine
    expect(parseShellCommand('find . -name x')).toEqual({
      kind: 'simple',
      program: 'find',
      command: 'find . -name x',
    });
  });
});

describe('resolveGrant with AST compound (#261)', () => {
  beforeAll(async () => {
    await initShellParser();
  });

  it('allows a compound only when every subcommand is granted', () => {
    const rules = [rule('allow', 'shell', 'git *'), rule('allow', 'shell', 'ls *')];
    expect(resolveGrant('shell', { command: 'git status && ls -la' }, rules, false)).toBe('allow');
  });

  it('asks when any subcommand is ungranted', () => {
    const rules = [rule('allow', 'shell', 'git *')];
    expect(resolveGrant('shell', { command: 'git status && npm install' }, rules, false)).toBe(
      'ask',
    );
  });

  it('denies the whole compound if any subcommand is denied', () => {
    const rules = [
      rule('allow', 'shell', 'git *'),
      rule('allow', 'shell', 'rm *'),
      rule('deny', 'shell', 'rm *'),
    ];
    // rm isn't dangerous here (no -rf /), so the deny rule is what sinks it.
    expect(resolveGrant('shell', { command: 'git status && rm foo' }, rules, false)).toBe('deny');
  });

  it('dangerous floor still wins over a fully-granted compound', () => {
    const rules = [rule('allow', 'shell', 'git *'), rule('allow', 'shell', 'rm *')];
    expect(resolveGrant('shell', { command: 'git status && rm -rf /' }, rules, true)).toBe('ask');
  });
});
