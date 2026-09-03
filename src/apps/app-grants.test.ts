import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';
import { parseGrantSpec } from './grant-cli.js';

async function loadModule() {
  vi.resetModules();
  return await import('./app-grants.js');
}

describe('per-app permission grants (#420)', () => {
  useTempHome();

  it('round-trips rules for one app', async () => {
    const m = await loadModule();
    m.saveAppGrants('notes', [{ effect: 'deny', tool: 'web_read', _v: 2 }]);
    expect(m.loadAppGrants('notes')).toEqual([{ effect: 'deny', tool: 'web_read', _v: 2 }]);
  });

  // `null` rather than `[]` is what `HeadlessPostureInput.toolPermissions`
  // means by "no rules apply", and it is what lets `runHeadless` skip both
  // the reader and the shell-parser warmup.
  it('reports no grants as null, not an empty list', async () => {
    const m = await loadModule();
    expect(m.loadAppGrants('notes')).toBeNull();
    m.saveAppGrants('notes', [{ effect: 'allow', tool: 'web_read', _v: 2 }]);
    m.saveAppGrants('notes', []);
    expect(m.loadAppGrants('notes')).toBeNull();
  });

  it('keeps apps separate', async () => {
    const m = await loadModule();
    m.saveAppGrants('notes', [{ effect: 'deny', tool: 'web_read', _v: 2 }]);
    m.saveAppGrants('todo', [{ effect: 'allow', tool: 'web_search', _v: 2 }]);
    expect(m.loadAppGrants('notes')?.[0].tool).toBe('web_read');
    expect(m.loadAppGrants('todo')?.[0].tool).toBe('web_search');
  });

  // The file is hand-editable, so a malformed rule that survived to the engine
  // would be matched against rather than ignored.
  it('drops malformed rules and unaddressable app ids', async () => {
    const m = await loadModule();
    const { saveActiveSettings } = await import('../profiles.js');
    saveActiveSettings({
      appToolGrants: {
        notes: [
          { effect: 'nope', tool: 'x' },
          { effect: 'deny', tool: 'web_read', _v: 2 },
        ],
        'Not An App Id': [{ effect: 'allow', tool: 'shell', _v: 2 }],
      },
    } as never);
    expect(m.loadAppGrants('notes')).toEqual([{ effect: 'deny', tool: 'web_read', _v: 2 }]);
    expect(Object.keys(m.listGrantedApps())).toEqual(['notes']);
  });
});

describe('parseGrantSpec', () => {
  it('reads a bare tool name as any invocation', () => {
    expect(parseGrantSpec('web_read', 'deny')).toEqual({
      effect: 'deny',
      tool: 'web_read',
      _v: 2,
    });
  });

  // Only the FIRST colon splits: an action-scoped specifier is itself
  // `action:<value>`, which is what the breadth ladder mints.
  it('splits on the first colon only', () => {
    expect(parseGrantSpec('memory:action:read', 'allow')).toEqual({
      effect: 'allow',
      tool: 'memory',
      specifier: 'action:read',
      _v: 2,
    });
  });

  it('rejects a spec with an empty half', () => {
    expect(parseGrantSpec(':read', 'allow')).toBeNull();
    expect(parseGrantSpec('memory:', 'allow')).toBeNull();
    expect(parseGrantSpec('  ', 'allow')).toBeNull();
  });
});
