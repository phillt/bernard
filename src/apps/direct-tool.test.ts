import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';
import { directInvocableRefusalByName, toolArgRefusal } from './direct-tool.js';

/**
 * The write-path half of eligibility (the `datetime` defect).
 *
 * A manifest naming an ineligible tool was accepted at authoring and refused
 * at the click, as an HTTP 500. These assert the refusal has moved to where
 * the model can act on it — while `tool-dispatch.test.ts` asserts it did NOT
 * move, only gain a sibling.
 */
describe('directInvocableRefusalByName', () => {
  useTempHome('bernard-direct-tool');

  it('refuses the tool that actually shipped broken', async () => {
    const out = await directInvocableRefusalByName('datetime');
    expect(out).toContain('datetime');
    expect(out).toContain('specialist');
  });

  it('allows the five tools that opt in', async () => {
    for (const name of ['web_read', 'web_search', 'memory', 'file_read_lines', 'file_write']) {
      expect(await directInvocableRefusalByName(name)).toBeNull();
    }
  });

  it('refuses a tool that does not exist at all', async () => {
    expect(await directInvocableRefusalByName('nope')).toContain('nope');
  });

  it('refuses `shell`, which is the one that must never be eligible', async () => {
    expect(await directInvocableRefusalByName('shell')).not.toBeNull();
  });

  it('builds the registry once across many calls', async () => {
    // ~76 ms per build; the check runs per tool-backed action.
    const mod = await import('../tools/index.js');
    const spy = vi.spyOn(mod, 'createTools');
    await directInvocableRefusalByName('memory');
    await directInvocableRefusalByName('web_read');
    await directInvocableRefusalByName('datetime');
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });
});

describe('toolArgRefusal', () => {
  useTempHome('bernard-direct-tool-args');

  it('refuses a misspelled parameter, naming the real ones', async () => {
    // Today this is an `invalid_manifest` 500 at click time, indistinguishable
    // to the user from the eligibility failure.
    const out = await toolArgRefusal('file_write', { pth: '$.target', content: '$.body' });
    expect(out).toContain('"pth"');
    expect(out).toContain('path');
  });

  it('refuses a mapping that omits a required parameter', async () => {
    const out = await toolArgRefusal('file_write', { content: '$.body' });
    expect(out).toContain('path');
    expect(out).toContain('requires');
  });

  it('accepts a correct mapping', async () => {
    expect(await toolArgRefusal('file_write', { path: '$.target', content: '$.body' })).toBeNull();
  });

  it('says nothing about a tool it cannot resolve', async () => {
    // Eligibility already refused that case; two messages for one fault is noise.
    expect(await toolArgRefusal('nope', { a: 1 })).toBeNull();
  });
});
