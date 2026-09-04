import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';

async function load() {
  vi.resetModules();
  const manage = await import('./manage.js');
  const grants = await import('./app-csp-grants.js');
  const { AppRegistry } = await import('./registry.js');
  const registry = new AppRegistry({ seed: false });
  registry.create(
    {
      schemaVersion: 2,
      id: 'notes',
      name: 'Notes',
      actions: {
        go: { dispatch: { kind: 'agent', specialistId: 'web-wrapper', instructions: 'x' } },
      },
    } as never,
    { 'index.html': '<h1>x</h1>' },
  );
  return { ...manage, ...grants };
}

describe('applyCspGrant', () => {
  useTempHome('bernard-manage');

  it('reads without writing when no flag names anything', async () => {
    const m = await load();
    const out = m.applyCspGrant('notes', {});
    expect(out.ok && out.lines[0]).toContain('nothing granted');
  });

  it('writes a grant and reports it back from the store', async () => {
    const m = await load();
    const out = m.applyCspGrant('notes', { imgSrc: ['https://cdn.example.com'] });
    expect(out.ok && out.lines).toEqual(['img-src: https://cdn.example.com']);
    expect(m.loadAppCspGrant('notes')).toEqual({ imgSrc: ['https://cdn.example.com'] });
  });

  it('refuses the whole write when one source is invalid', async () => {
    // A partial grant is the worst outcome available: the user believes they
    // granted three origins, two landed, and the applet half-works.
    const m = await load();
    m.applyCspGrant('notes', { imgSrc: ['https://ok.example'] });
    const out = m.applyCspGrant('notes', {
      imgSrc: ['https://good.example', "https://bad; script-src 'unsafe-eval'"],
    });
    expect(out.ok).toBe(false);
    expect(m.loadAppCspGrant('notes')).toEqual({ imgSrc: ['https://ok.example'] });
  });

  it('leaves an untouched directive alone and clears one passed empty', async () => {
    const m = await load();
    m.applyCspGrant('notes', { imgSrc: ['https://a.example'], fontSrc: ['https://f.example'] });
    m.applyCspGrant('notes', { imgSrc: [] });
    expect(m.loadAppCspGrant('notes')).toEqual({ fontSrc: ['https://f.example'] });
  });

  it('clears everything on --clear', async () => {
    const m = await load();
    m.applyCspGrant('notes', { imgSrc: ['https://a.example'], sandbox: ['links'] });
    m.applyCspGrant('notes', { clear: true });
    expect(m.loadAppCspGrant('notes')).toBeNull();
  });

  it('resolves a sandbox alias to what will actually be emitted', async () => {
    const m = await load();
    const out = m.applyCspGrant('notes', { sandbox: ['links'] });
    expect(out.ok && out.grant.sandbox).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox']);
  });

  it('refuses an unknown app before writing anything', async () => {
    const m = await load();
    const out = m.applyCspGrant('nope', { imgSrc: ['https://a.example'] });
    expect(out.ok).toBe(false);
    expect(m.loadAppCspGrant('nope')).toBeNull();
  });

  it('warns about the grants whose breadth is easy to forget', async () => {
    const m = await load();
    const wild = m.applyCspGrant('notes', { imgSrc: ['https:'] });
    expect(wild.ok && wild.warnings.join(' ')).toContain('Wildcard');
    const chan = m.applyCspGrant('notes', { connectSrc: ['https://api.example'] });
    expect(chan.ok && chan.warnings.join(' ')).toContain('two-way channel');
    const links = m.applyCspGrant('notes', { sandbox: ['links'] });
    expect(links.ok && links.warnings.join(' ')).toContain('not origin-scoped');
  });

  it('repeats the warnings on a plain read, not only on the write', async () => {
    // A grant made months ago is the one whose breadth has been forgotten.
    const m = await load();
    m.applyCspGrant('notes', { connectSrc: ['https://api.example'] });
    const out = m.applyCspGrant('notes', {});
    expect(out.ok && out.warnings.join(' ')).toContain('two-way channel');
  });
});
