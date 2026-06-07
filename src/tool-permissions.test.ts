import { describe, it, expect } from 'vitest';
import {
  isReadOnlyShellInvocation,
  permissionKeyFor,
  permissionKeyLabel,
  primaryShellCommand,
} from './tool-permissions.js';

describe('primaryShellCommand', () => {
  it('extracts the first token from a simple command', () => {
    expect(primaryShellCommand('ls -al ./x/y/z')).toBe('ls');
    expect(primaryShellCommand('  git status  ')).toBe('git');
    expect(primaryShellCommand('touch file.txt')).toBe('touch');
  });

  it('returns null for complex command lines', () => {
    expect(primaryShellCommand('ls | wc -l')).toBeNull();
    expect(primaryShellCommand('echo hi > out.txt')).toBeNull();
    expect(primaryShellCommand('cat < in.txt')).toBeNull();
    expect(primaryShellCommand('ls; rm -rf /')).toBeNull();
    expect(primaryShellCommand('ls && rm -rf /')).toBeNull();
    expect(primaryShellCommand('echo `whoami`')).toBeNull();
    expect(primaryShellCommand('echo $(whoami)')).toBeNull();
  });

  it('returns null for multi-line payloads (newline smuggling)', () => {
    expect(primaryShellCommand('ls\nrm -rf /')).toBeNull();
    expect(primaryShellCommand('ls\r\nrm -rf /')).toBeNull();
  });

  it('returns null for env-assignment prefixes and empty input', () => {
    expect(primaryShellCommand('FOO=bar ls')).toBeNull();
    expect(primaryShellCommand('')).toBeNull();
    expect(primaryShellCommand('   ')).toBeNull();
  });
});

describe('permissionKeyFor', () => {
  it('keys shell calls by primary command', () => {
    expect(permissionKeyFor('shell', { command: 'ls -al' })).toBe('shell:ls');
    expect(permissionKeyFor('shell', { command: 'rm -rf ./x' })).toBe('shell:rm');
  });

  it('returns null for complex shell commands (no stable key)', () => {
    expect(permissionKeyFor('shell', { command: 'ls | wc' })).toBeNull();
    expect(permissionKeyFor('shell', { command: 'a; b' })).toBeNull();
  });

  it('returns null for shell calls without a string command', () => {
    expect(permissionKeyFor('shell', {})).toBeNull();
    expect(permissionKeyFor('shell', undefined)).toBeNull();
    expect(permissionKeyFor('shell', { command: 42 })).toBeNull();
  });

  it('keys every other tool by name, including MCP names', () => {
    expect(permissionKeyFor('web_read', { url: 'https://x' })).toBe('web_read');
    expect(permissionKeyFor('gdrive__files_create', {})).toBe('gdrive__files_create');
  });
});

describe('isReadOnlyShellInvocation', () => {
  it('accepts simple invocations of allowlisted commands', () => {
    expect(isReadOnlyShellInvocation('ls -al ./src')).toBe(true);
    expect(isReadOnlyShellInvocation('cat package.json')).toBe(true);
    expect(isReadOnlyShellInvocation('pwd')).toBe(true);
    expect(isReadOnlyShellInvocation('grep -rn TODO src')).toBe(true);
    expect(isReadOnlyShellInvocation('wc -l file.txt')).toBe(true);
  });

  it('accepts read-only git subcommands only', () => {
    expect(isReadOnlyShellInvocation('git status')).toBe(true);
    expect(isReadOnlyShellInvocation('git log --oneline')).toBe(true);
    expect(isReadOnlyShellInvocation('git diff HEAD~1')).toBe(true);
    expect(isReadOnlyShellInvocation('git push origin main')).toBe(false);
    expect(isReadOnlyShellInvocation('git checkout -b x')).toBe(false);
    expect(isReadOnlyShellInvocation('git branch new-branch')).toBe(false);
    expect(isReadOnlyShellInvocation('git')).toBe(false);
  });

  it('rejects write-capable and excluded commands', () => {
    expect(isReadOnlyShellInvocation('rm -rf ./x')).toBe(false);
    expect(isReadOnlyShellInvocation('touch x')).toBe(false);
    expect(isReadOnlyShellInvocation('find . -delete')).toBe(false);
    expect(isReadOnlyShellInvocation('sed -i s/a/b/ f')).toBe(false);
    expect(isReadOnlyShellInvocation('env')).toBe(false);
    expect(isReadOnlyShellInvocation('printenv')).toBe(false);
  });

  it('rejects complex lines even when the first token is allowlisted', () => {
    expect(isReadOnlyShellInvocation('ls | wc -l')).toBe(false);
    expect(isReadOnlyShellInvocation('cat f > g')).toBe(false);
    expect(isReadOnlyShellInvocation('ls; rm -rf /')).toBe(false);
    expect(isReadOnlyShellInvocation('ls\nrm -rf /')).toBe(false);
    expect(isReadOnlyShellInvocation('cat `which sh`')).toBe(false);
    expect(isReadOnlyShellInvocation('echo $(rm -rf /)')).toBe(false);
  });
});

describe('permissionKeyLabel', () => {
  it('strips the shell: prefix and passes other keys through', () => {
    expect(permissionKeyLabel('shell:ls')).toBe('ls');
    expect(permissionKeyLabel('web_read')).toBe('web_read');
  });
});
