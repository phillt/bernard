import { describe, it, expect } from 'vitest';
import { buildChildTools } from '../tool-wrapper.js';
import type { Tool } from 'ai';

const reg = (names: string[]) =>
  Object.fromEntries(names.map((n) => [n, {} as Tool])) as Record<string, Tool>;

describe('buildChildTools alias tolerance (#413)', () => {
  // `targetTools` is persisted, so a specialist written before namespacing
  // names a bare MCP tool.
  it('resolves a stored bare name forward and keys the result by the live name', () => {
    const live = 'playwright_ab12cd__browser_click';
    const out = buildChildTools({ targetTools: ['browser_click'] }, reg([live]), (n) =>
      n === 'browser_click' ? live : null,
    );
    expect(Object.keys(out)).toEqual([live]);
  });

  it('drops an ambiguous name rather than guessing which server was meant', () => {
    const out = buildChildTools(
      { targetTools: ['browser_click'] },
      reg(['a__browser_click']),
      () => null,
    );
    expect(out).toEqual({});
  });

  it('an exact match never consults the resolver', () => {
    let called = false;
    const out = buildChildTools({ targetTools: ['shell'] }, reg(['shell']), () => {
      called = true;
      return null;
    });
    expect(Object.keys(out)).toEqual(['shell']);
    expect(called).toBe(false);
  });

  it('without a resolver, behaves exactly as before', () => {
    expect(buildChildTools({ targetTools: ['shell', 'gone'] }, reg(['shell']))).toEqual({
      shell: {},
    });
    expect(buildChildTools({ targetTools: [] }, reg(['shell']))).toEqual({});
  });
});
