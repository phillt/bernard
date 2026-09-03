import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { useTempHome } from '../__tests__/temp-home.js';

async function load() {
  vi.resetModules();
  const paths = await import('../paths.js');
  const caps = await import('./capabilities.js');
  const log = await import('./capability-log.js');
  return { ...caps, ...log, CAPABILITY_LOG_FILE: paths.CAPABILITY_LOG_FILE };
}

describe('capability mint log (#420 R9)', () => {
  useTempHome('bernard-caplog');

  function rows(file: string): Record<string, unknown>[] {
    return fs
      .readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('records the record id and never any part of the handle', async () => {
    const m = await load();
    const table = new m.CapabilityTable(m.recordCapabilityMint);
    const handle = table.mint({ appId: 'demo', action: 'ask', sessionId: 'sess-1' });
    const raw = fs.readFileSync(m.CAPABILITY_LOG_FILE, 'utf-8');
    const [row] = rows(m.CAPABILITY_LOG_FILE);
    expect(row.appId).toBe('demo');
    expect(row.action).toBe('ask');
    expect(row.sessionId).toBe('sess-1');
    expect(typeof row.capabilityId).toBe('string');
    // The handle is a live credential; part of one on disk is still part of
    // one. Checked against every prefix a log line might plausibly have taken.
    expect(raw).not.toContain(handle);
    expect(raw).not.toContain(handle.slice(0, 8));
  });

  it('records arg KEYS but never their values', async () => {
    const m = await load();
    const table = new m.CapabilityTable(m.recordCapabilityMint);
    table.mint({
      appId: 'demo',
      action: 'ask',
      sessionId: 's',
      frozenArgs: { q: 'a-secret-value' },
      uses: 1,
    });
    const raw = fs.readFileSync(m.CAPABILITY_LOG_FILE, 'utf-8');
    expect(raw).toContain('"q"');
    expect(raw).not.toContain('a-secret-value');
    expect(rows(m.CAPABILITY_LOG_FILE)[0].uses).toBe(1);
  });

  // `Infinity` does not survive JSON — it serialises as `null`, which reads as
  // "unknown" rather than "unlimited".
  it('renders an unlimited use count as a word, not null', async () => {
    const m = await load();
    new m.CapabilityTable(m.recordCapabilityMint).mint({
      appId: 'demo',
      action: 'ask',
      sessionId: 's',
    });
    expect(rows(m.CAPABILITY_LOG_FILE)[0].uses).toBe('unlimited');
  });

  // A reused designation is not a new capability; a row per page load would be
  // noise hiding the mints that matter.
  it('logs a mint, not a reuse', async () => {
    const m = await load();
    const table = new m.CapabilityTable(m.recordCapabilityMint);
    table.handleFor('demo', 'ask', 's');
    table.handleFor('demo', 'ask', 's');
    expect(rows(m.CAPABILITY_LOG_FILE)).toHaveLength(1);
  });

  it('a throwing observer does not cost the caller its handle', async () => {
    const m = await load();
    const table = new m.CapabilityTable(() => {
      throw new Error('disk full');
    });
    const handle = table.mint({ appId: 'demo', action: 'ask', sessionId: 's' });
    expect(table.redeem(handle, { appId: 'demo', sessionId: 's' }).ok).toBe(true);
  });
});
