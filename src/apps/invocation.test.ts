import { describe, it, expect } from 'vitest';
import { grantedToolNames, renderArgsBlock, resolveFromManifest } from './invocation.js';
import { AppActionSchema } from './manifest.js';
import type { AppRegistry } from './registry.js';

// No mocks: resolution is pure. That is the point of the module split — these
// used to live beside `dispatchAction` and so had to mock the tool registry to
// exercise functions that never touch a tool.

function action(over: Record<string, unknown> = {}) {
  return AppActionSchema.parse({
    instructions: 'Answer the question.',
    specialistId: 'web-wrapper',
    ...over,
  });
}

/** A registry stub — the real one is covered by `registry.test.ts`. */
function registryReturning(result: unknown): AppRegistry {
  return { resolve: () => result } as unknown as AppRegistry;
}

describe('renderArgsBlock', () => {
  it('labels the args as caller-supplied data and fences them', () => {
    const block = renderArgsBlock({ question: 'why is the sky blue' });
    expect(block).toContain('DATA supplied by an external caller');
    expect(block).toContain('```json');
    expect(block).toContain(JSON.stringify({ question: 'why is the sky blue' }));
  });
});

describe('resolveFromManifest', () => {
  const resolved = { ok: true as const, manifest: {} as never, actionName: 'go', action: action() };

  it('freezes the VALIDATED args, not the caller object', () => {
    const res = resolveFromManifest(
      registryReturning({
        ...resolved,
        action: action({ args: { q: { type: 'string', required: true } } }),
      }),
      'demo',
      'go',
      { q: 'hello' },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.invocation.frozenArgs).toEqual({ q: 'hello' });
      expect(Object.isFrozen(res.invocation.frozenArgs)).toBe(true);
    }
  });

  it('carries the resolved identifiers, so downstream reads the record not the request', () => {
    const res = resolveFromManifest(registryReturning(resolved), 'demo', 'go', {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.invocation.appId).toBe('demo');
      expect(res.invocation.actionName).toBe('go');
    }
  });

  it('rejects args that fail the action schema without dispatching', () => {
    const res = resolveFromManifest(
      registryReturning({
        ...resolved,
        action: action({ args: { q: { type: 'string', required: true } } }),
      }),
      'demo',
      'go',
      {},
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe('invalid_args');
  });

  it('passes a registry resolve failure straight through', () => {
    const res = resolveFromManifest(
      registryReturning({
        ok: false,
        failure: { kind: 'unknown_action', appId: 'demo', action: 'x', message: 'nope' },
      }),
      'demo',
      'x',
      {},
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe('unknown_action');
  });
});

describe('grantedToolNames', () => {
  const action = (allowlist: string[]) =>
    ({ toolAllowlist: allowlist }) as unknown as Parameters<typeof grantedToolNames>[0];

  // The intersection, which is the property `buildActionTools` rests on: an
  // action can narrow what the specialist already targets, never widen it.
  it('intersects the action allowlist with the specialist targets', () => {
    expect(grantedToolNames(action(['web_search', 'shell']), ['web_search', 'web_read'])).toEqual([
      'web_search',
    ]);
  });

  // The log used to record the DECLARED allowlist, so a manifest naming a tool
  // the specialist does not target overstated the grant in the audit trail.
  it('grants nothing when the specialist targets nothing', () => {
    expect(grantedToolNames(action(['web_search']), undefined)).toEqual([]);
    expect(grantedToolNames(action(['web_search']), [])).toEqual([]);
  });
});
