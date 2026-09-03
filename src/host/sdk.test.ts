import { describe, it, expect } from 'vitest';
import { SDK_PATH, appletSdkScript } from './sdk.js';
import { TOKENS_PATH } from './tokens.js';

describe('the applet client (#453 follow-up)', () => {
  it('lives in the reserved namespace, so an applet file cannot shadow it', () => {
    // Same rule `tokens.css` is held to: everything the host serves itself is
    // under `/__bernard/`, which `resolveAsset` never reaches.
    expect(SDK_PATH.startsWith('/__bernard/')).toBe(true);
    expect(SDK_PATH).not.toBe(TOKENS_PATH);
  });

  it('is built once and handed back by reference', () => {
    expect(appletSdkScript()).toBe(appletSdkScript());
  });

  it('speaks the protocol a page would otherwise have to reinvent', () => {
    const js = appletSdkScript();
    // The three things the generated page got wrong, in one place now.
    expect(js).toContain('x-bernard-token');
    expect(js).toContain('/__bernard/bootstrap.json');
    expect(js).toContain('/__bernard/invoke');
    expect(js).toContain('window.bernard');
  });

  it('carries no closing script tag, which would truncate any inline embed', () => {
    // Served standalone today, but a page that ever inlines it would end its
    // own <script> early — a silent, total failure.
    expect(appletSdkScript()).not.toContain('</script');
  });

  it('explains the 403 the guard deliberately will not', () => {
    // `guard.ts` answers every refusal with one terse `Forbidden` so a prober
    // cannot enumerate causes. That leaves the developer with nothing, so the
    // explanation lives in a file the prober can already GET.
    const js = appletSdkScript();
    expect(js).toContain('403');
    expect(js).toContain('localhost');
    expect(js).toContain('restarted');
  });

  it('never caches a failed bootstrap', () => {
    // A page that loaded while the host was still starting would otherwise be
    // broken until reload, with no way to recover.
    expect(appletSdkScript()).toContain('booted = null;');
  });
});
