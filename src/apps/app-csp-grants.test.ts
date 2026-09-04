import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { useTempHome } from '../__tests__/temp-home.js';
import { cspFor } from '../host/csp.js';

/**
 * `paths.ts` resolves its constants at module load, so the profile path has to
 * come from the SAME freshly-reset module graph as the store under test — a
 * statically imported `PROFILES_PATH` points at whichever temp home existed
 * when this file was first evaluated.
 */
async function loadModule() {
  vi.resetModules();
  const m = await import('./app-csp-grants.js');
  const { PROFILES_PATH } = await import('../paths.js');
  return { ...m, PROFILES_PATH };
}

describe('per-app CSP grants (#467, #468)', () => {
  useTempHome();

  it('round-trips one app grant', async () => {
    const m = await loadModule();
    m.saveAppCspGrant('notes', { imgSrc: ['https://cdn.example.com'] });
    expect(m.loadAppCspGrant('notes')).toEqual({ imgSrc: ['https://cdn.example.com'] });
  });

  it('reports no grant as null, and an emptied grant deletes the key', async () => {
    const m = await loadModule();
    expect(m.loadAppCspGrant('notes')).toBeNull();
    m.saveAppCspGrant('notes', { imgSrc: ['https://cdn.example.com'] });
    m.saveAppCspGrant('notes', {});
    expect(m.loadAppCspGrant('notes')).toBeNull();
    // Removed rather than left as an empty object, so a future app cannot
    // inherit a stale entry by id collision.
    const stored = JSON.parse(fs.readFileSync(m.PROFILES_PATH, 'utf-8')) as {
      profiles: Record<string, { settings: { appCspGrants?: Record<string, unknown> } }>;
    };
    const settings = Object.values(stored.profiles)[0].settings;
    expect(settings.appCspGrants?.notes).toBeUndefined();
  });

  it('keeps apps separate', async () => {
    const m = await loadModule();
    m.saveAppCspGrant('notes', { imgSrc: ['https://cdn.example.com'] });
    expect(m.loadAppCspGrant('other')).toBeNull();
    expect(m.listCspGrantedApps()).toEqual({ notes: { imgSrc: ['https://cdn.example.com'] } });
  });

  it('drops a hand-edited grant that could split the header, end to end', async () => {
    // The assertion that matters: not "the validator refuses it" (that is
    // csp-grant.test.ts) but that a value hand-written into profiles.json
    // cannot reach a served header. Load → cspFor → string.
    const m = await loadModule();
    m.saveAppCspGrant('notes', { imgSrc: ['https://ok.example'] });
    const file = JSON.parse(fs.readFileSync(m.PROFILES_PATH, 'utf-8')) as {
      profiles: Record<string, { settings: { appCspGrants: Record<string, unknown> } }>;
    };
    const profile = Object.values(file.profiles)[0];
    profile.settings.appCspGrants.notes = {
      imgSrc: ["https://x.example; script-src 'unsafe-eval'"],
      scriptSrc: ['https://evil.example'],
    };
    fs.writeFileSync(m.PROFILES_PATH, JSON.stringify(file));

    const grant = m.loadAppCspGrant('notes');
    expect(grant).toBeNull();
    const csp = cspFor(grant);
    expect(csp).toBe(cspFor());
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('evil.example');
  });

  it('drops an app id that cannot address an applet', async () => {
    const m = await loadModule();
    m.saveAppCspGrant('notes', { imgSrc: ['https://cdn.example.com'] });
    const file = JSON.parse(fs.readFileSync(m.PROFILES_PATH, 'utf-8')) as {
      profiles: Record<string, { settings: { appCspGrants: Record<string, unknown> } }>;
    };
    const profile = Object.values(file.profiles)[0];
    profile.settings.appCspGrants['../escape'] = { imgSrc: ['https:'] };
    fs.writeFileSync(m.PROFILES_PATH, JSON.stringify(file));
    expect(Object.keys(m.listCspGrantedApps())).toEqual(['notes']);
  });

  it('normalizes a sandbox alias on the way in', async () => {
    const m = await loadModule();
    m.saveAppCspGrant('notes', { sandbox: ['links'] } as never);
    expect(m.loadAppCspGrant('notes')).toEqual({
      sandbox: ['allow-popups', 'allow-popups-to-escape-sandbox'],
    });
  });
});
