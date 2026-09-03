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

  it('parses, and defines the surface a page depends on', async () => {
    // The rest of this file greps for substrings, which cannot fail for the
    // right reason: a refactor that preserves behaviour but changes wording
    // breaks it, and one that breaks behaviour while keeping the wording
    // passes. So this one actually RUNS the script the way a browser would.
    //
    // The deeper version of this point is that ~200 lines of real logic are
    // authored as a template literal and so are checked by neither `tsc` nor
    // eslint. Executing it here is the cheap half; making it a real `.js`
    // asset copied by `scripts/copy-builtins.mjs` is the other half, and is
    // its own change.
    const vm = await import('node:vm');
    const ctx: Record<string, unknown> = {
      window: {} as Record<string, unknown>,
      addEventListener() {},
      document: { getElementById: () => null },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    };
    vm.createContext(ctx);
    // Throws on a syntax error, which no substring assertion would catch.
    new vm.Script(appletSdkScript()).runInContext(ctx);

    const bernard = (ctx.window as { bernard?: Record<string, unknown> }).bernard;
    expect(bernard).toBeDefined();
    expect(typeof bernard?.invoke).toBe('function');
    expect(typeof bernard?.showError).toBe('function');
    const store = bernard?.store as Record<string, unknown>;
    expect(Object.keys(store).sort()).toEqual(['delete', 'get', 'list', 'set']);
  });

  it('reports an action the applet does not declare, before any request', async () => {
    // The local check that turns a typo into a named error rather than a 403.
    const vm = await import('node:vm');
    let fetched = false;
    const ctx: Record<string, unknown> = {
      window: {} as Record<string, unknown>,
      addEventListener() {},
      document: { getElementById: () => null },
      fetch: async (url: string) => {
        if (String(url).includes('invoke')) fetched = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({ appId: 'a', token: 't', handles: { real: 'h' } }),
        };
      },
    };
    vm.createContext(ctx);
    new vm.Script(appletSdkScript()).runInContext(ctx);
    const bernard = (ctx.window as { bernard: { invoke: (a: string) => Promise<unknown> } })
      .bernard;

    await expect(bernard.invoke('missing')).rejects.toThrow(/declares no action "missing"/);
    expect(fetched).toBe(false);
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
