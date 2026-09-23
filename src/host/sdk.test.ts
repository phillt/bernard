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
  /**
   * The icon spelling a runtime page can use (#610 follow-up).
   *
   * `bernard.icon()` returns a STRING and `bernard.icons.hydrate()` sets
   * `innerHTML` on a node Preact owns, so neither survives a re-render. The
   * page shape with enough controls to want icons is exactly the one
   * `UI_RUNTIME_RULE` sends to the runtime, so it was the one shape that
   * could not use the set at all.
   */
  describe('bernard.Icon', () => {
    const load = async (window: Record<string, unknown>) => {
      const vm = await import('node:vm');
      const ctx: Record<string, unknown> = {
        window,
        addEventListener() {},
        document: { getElementById: () => null },
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      };
      vm.createContext(ctx);
      new vm.Script(appletSdkScript()).runInContext(ctx);
      return (ctx.window as { bernard: Record<string, unknown> }).bernard;
    };

    /** A stand-in for htm/preact's `h`, recording what it was handed. */
    const runtime = () => {
      const calls: Array<{ tag: string; attrs: Record<string, unknown> }> = [];
      return {
        calls,
        htmPreact: {
          h: (tag: string, attrs: Record<string, unknown>) => (
            calls.push({ tag, attrs }),
            { tag, attrs }
          ),
        },
      };
    };

    it('builds the svg directly, with no wrapper element', async () => {
      // No wrapper is the property: the glyph itself has to be the flex item
      // a `button` lays out, exactly as the string spelling produces. A
      // `<span>` around it would need `display: contents` to stay out of the
      // way, which is a second rule and a second thing to get wrong.
      const rt = runtime();
      const bernard = await load(rt as unknown as Record<string, unknown>);
      const out = (bernard.Icon as (p: unknown) => unknown)({ name: 'trash-2' });
      expect(out).not.toBeNull();
      expect(rt.calls).toHaveLength(1);
      expect(rt.calls[0].tag).toBe('svg');
      expect(rt.calls[0].attrs.class).toBe('icon');
      expect(rt.calls[0].attrs.dangerouslySetInnerHTML).toBeDefined();
    });

    it('takes `class` as well as `className`, since htm writes the former', async () => {
      const rt = runtime();
      const bernard = await load(rt as unknown as Record<string, unknown>);
      const Icon = bernard.Icon as (p: unknown) => unknown;
      Icon({ name: 'trash-2', class: 'danger' });
      Icon({ name: 'trash-2', className: 'danger' });
      expect(rt.calls[0].attrs.class).toBe('icon danger');
      expect(rt.calls[1].attrs.class).toBe('icon danger');
    });

    /**
     * The one decision that must not diverge between the two spellings.
     *
     * Hidden from assistive tech unless titled — an icon beside its own text
     * announces as a stutter, and an icon-ONLY control with neither is
     * unreachable. Asserted on BOTH renderers from one loop, because written
     * twice is how one copy loses it.
     */
    it('applies the same a11y rule as the string spelling', async () => {
      const rt = runtime();
      const bernard = await load(rt as unknown as Record<string, unknown>);
      const Icon = bernard.Icon as (p: unknown) => unknown;
      const icon = bernard.icon as (n: string, o?: unknown) => string;

      Icon({ name: 'trash-2' });
      expect(rt.calls[0].attrs['aria-hidden']).toBe('true');
      expect(rt.calls[0].attrs['aria-label']).toBeUndefined();
      expect(icon('trash-2')).toContain('aria-hidden="true"');

      Icon({ name: 'trash-2', title: 'Delete reading' });
      expect(rt.calls[1].attrs.role).toBe('img');
      expect(rt.calls[1].attrs['aria-label']).toBe('Delete reading');
      expect(rt.calls[1].attrs['aria-hidden']).toBeUndefined();
      expect(icon('trash-2', { title: 'Delete reading' })).toContain('aria-label="Delete reading"');
    });

    it('degrades to null rather than throwing, on both missing halves', async () => {
      // An unknown name is a typo `page-validate` catches at authoring time,
      // and no runtime means a plain HTML page — where null is the correct
      // answer, not an error.
      const rt = runtime();
      const withRuntime = await load(rt as unknown as Record<string, unknown>);
      expect((withRuntime.Icon as (p: unknown) => unknown)({ name: 'dustbin' })).toBeNull();

      const plain = await load({});
      expect((plain.Icon as (p: unknown) => unknown)({ name: 'trash-2' })).toBeNull();
    });

    it('resolves the runtime at call time, not at load', async () => {
      // `sdk.js` and `ui.js` are two classic scripts with no guaranteed
      // order, so a reference captured when the SDK evaluates may be
      // undefined forever. A component renders long after both have run.
      const window: Record<string, unknown> = {};
      const bernard = await load(window);
      expect((bernard.Icon as (p: unknown) => unknown)({ name: 'trash-2' })).toBeNull();

      const rt = runtime();
      window.htmPreact = rt.htmPreact;
      expect((bernard.Icon as (p: unknown) => unknown)({ name: 'trash-2' })).not.toBeNull();
    });
  });
});
