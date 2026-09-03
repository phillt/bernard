import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';

async function load() {
  vi.resetModules();
  const { createAppletTool } = await import('./applet.js');
  const { AppRegistry } = await import('../apps/registry.js');
  return { tool: createAppletTool(new AppRegistry({ seed: false })), AppRegistry };
}

/** A page that satisfies the contract — the three links plus the client. */
const PAGE = [
  '<title>Notes</title>',
  '<link rel="stylesheet" href="/__bernard/tokens.css" />',
  '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
  '<script src="/__bernard/applet.js"></script>',
  '<main><button id="go">Go</button></main>',
  "<script>document.getElementById('go').addEventListener('click', () => bernard.invoke('summarise'));</script>",
].join('\n');

const CREATE = {
  action: 'create' as const,
  id: 'notes',
  name: 'Notes',
  page: PAGE,
  actions: {
    summarise: {
      dispatch: { kind: 'agent' as const, specialistId: 'web-wrapper', instructions: 'Summarise.' },
    },
  },
};

describe('the applet tool', () => {
  useTempHome('bernard-applet-tool');

  it('creates an applet with a page', async () => {
    const { tool, AppRegistry } = await load();
    const out = await tool.execute(CREATE, {} as never);
    expect(out).toContain('created');
    expect(new AppRegistry({ seed: false }).listIds()).toContain('notes');
  });

  /**
   * The authority split. `toolAllowlist`, `toolMode` and `confirmMode` decide
   * what the agent behind a button may DO, and a model must not write them —
   * the same argument `app-grants.ts` makes about itself. The schema has no
   * such field, so this asserts the resulting record rather than a refusal.
   */
  it('creates actions with no tools and read-only mode', async () => {
    const { tool, AppRegistry } = await load();
    await tool.execute(CREATE, {} as never);
    const app = new AppRegistry({ seed: false }).get('notes');
    expect(app.ok).toBe(true);
    if (app.ok) {
      expect(app.manifest.actions.summarise.toolAllowlist).toEqual([]);
      expect(app.manifest.actions.summarise.toolMode).toBe('read-only');
    }
  });

  /**
   * Two layers, and this asserts the inner one. In production the AI SDK
   * parses against the `.strict()` action schema first and rejects an
   * unrecognised key outright — but a direct `execute` (this test, and any
   * future non-SDK caller) skips that, so the builder must not read the field
   * either. It builds actions from named fields only; anything else is dropped
   * rather than trusted.
   */
  it('never lets an authority field through, even bypassing the schema', async () => {
    const { tool, AppRegistry } = await load();
    await tool.execute(
      {
        ...CREATE,
        actions: {
          summarise: { ...CREATE.actions.summarise, toolAllowlist: ['shell'], toolMode: 'write' },
        },
      } as never,
      {} as never,
    );
    const app = new AppRegistry({ seed: false }).get('notes');
    if (app.ok) {
      expect(app.manifest.actions.summarise.toolAllowlist).toEqual([]);
      expect(app.manifest.actions.summarise.toolMode).toBe('read-only');
    }
  });

  // An edit must never silently revoke a grant the user made at the CLI — nor
  // widen one, which it structurally cannot.
  it('carries authority fields through an update', async () => {
    const { tool, AppRegistry } = await load();
    await tool.execute(CREATE, {} as never);
    const registry = new AppRegistry({ seed: false });
    const { appAllow } = await import('../apps/app-cli.js');
    appAllow('notes', 'summarise', ['web_search'], { write: true });

    await tool.execute(
      { ...CREATE, action: 'update', description: 'now with a description' },
      {} as never,
    );
    const app = registry.get('notes');
    if (app.ok) {
      expect(app.manifest.actions.summarise.toolAllowlist).toEqual(['web_search']);
      expect(app.manifest.actions.summarise.toolMode).toBe('write');
      expect(app.manifest.description).toBe('now with a description');
    }
  });

  it('rejects a bad id and a bad action name', async () => {
    const { tool } = await load();
    expect(await tool.execute({ ...CREATE, id: 'Not An Id' }, {} as never)).toContain('Error');
    expect(
      await tool.execute(
        { ...CREATE, actions: { 'Bad Name': CREATE.actions.summarise } } as never,
        {} as never,
      ),
    ).toContain('Error');
  });

  // Deleting sweeps six stores including bound specialists. It is
  // `bernard app delete`, and an unknown action must say so rather than
  // returning undefined — which `detectResultFailure` reads as a success.
  it('has no delete action, and says where it is', async () => {
    const { tool } = await load();
    const out = await tool.execute({ action: 'delete', id: 'notes' } as never, {} as never);
    expect(out).toContain('Error');
    expect(out).toContain('bernard app delete');
  });
});

/**
 * The authority split (#453) is enforced twice — the `.strict()` action schema
 * refuses an authority field at parse, and `buildManifest` builds each action
 * field by field rather than spreading. Both are omissions, and an omission is
 * what a future edit re-opens by accident: adding `toolAllowlist` to the tool's
 * own schema "so an applet can manage its own tools" would compile, pass every
 * other test, and hand a model the escalation `app-grants.ts` exists to prevent.
 *
 * So the set lives in `manifest.ts` beside the schema that declares it, and the
 * assertion walks the ADVERTISED schema — what the model can actually name —
 * rather than trusting `buildManifest`'s field list to stay closed.
 */
describe('the applet tool cannot author authority', () => {
  useTempHome('bernard-applet-authority');

  it('advertises no authority field on an action', async () => {
    const { createAppletTool } = await import('./applet.js');
    const { AUTHORITY_ACTION_FIELDS } = await import('../apps/manifest.js');
    const tool = createAppletTool();
    // parameters → actions (record) → the action object's own shape.
    const params = tool.parameters as unknown as {
      shape: { actions: { unwrap: () => { valueSchema: { shape: Record<string, unknown> } } } };
    };
    const actionShape = params.shape.actions.unwrap().valueSchema.shape;
    for (const field of AUTHORITY_ACTION_FIELDS) {
      expect(Object.keys(actionShape)).not.toContain(field);
    }
    // The set is non-empty, or the loop above proves nothing.
    expect(AUTHORITY_ACTION_FIELDS.length).toBeGreaterThan(0);
  });

  it('refuses an authority field rather than dropping it silently', async () => {
    const { createAppletTool } = await import('./applet.js');
    const { AppRegistry } = await import('../apps/registry.js');
    const tool = createAppletTool(new AppRegistry({ seed: false }));
    const parsed = tool.parameters.safeParse({
      ...CREATE,
      actions: {
        summarise: {
          dispatch: {
            kind: 'agent',
            specialistId: 'web-wrapper',
            instructions: 'Summarise.',
          },
          toolAllowlist: ['shell'],
        },
      },
    });
    // `.strict()` is what makes this a rejection and not a quiet drop — a drop
    // would read as an applet that was granted `shell` and was not.
    expect(parsed.success).toBe(false);
  });

  it('has no delete action', async () => {
    const { createAppletTool } = await import('./applet.js');
    const tool = createAppletTool();
    const parsed = tool.parameters.safeParse({ action: 'delete', id: 'notes' });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The write path refuses a page that cannot work.
 *
 * Serving `/__bernard/applet.js` makes the protocol impossible to get wrong;
 * it does not make a generated page use it, and unlike `style-src` the CSP
 * cannot force the issue — inline script has to stay legal. So this is where
 * the 403, the unstyled page and the missing install prompt are actually
 * prevented.
 */
describe('the applet tool refuses a page that would not work', () => {
  useTempHome('bernard-applet-page');

  const bad = (page: string) => ({ ...CREATE, page });

  it('refuses a bare page, naming every problem at once', async () => {
    const { tool } = await load();
    const out = await tool.execute(bad('<h1>Notes</h1>'), {} as never);
    expect(out).toContain('Error:');
    expect(out).toContain('/__bernard/tokens.css');
    expect(out).toContain('/__bernard/manifest.webmanifest');
    expect(out).toContain('/__bernard/applet.js');
  });

  it('refuses a hand-rolled invoke — the exact shape that 403d', async () => {
    const { tool } = await load();
    const out = await tool.execute(
      bad(`${PAGE}\n<script>fetch('/__bernard/invoke', {method:'POST'})</script>`),
      {} as never,
    );
    expect(out).toContain('Error:');
    expect(out).toContain('bernard.invoke');
  });

  it('writes nothing when it refuses', async () => {
    // A refusal that half-created the applet would be worse than the defect.
    const { tool, AppRegistry } = await load();
    await tool.execute(bad('<h1>Notes</h1>'), {} as never);
    expect(new AppRegistry({ seed: false }).listIds()).not.toContain('notes');
  });

  it('scaffolds a working page when none is given', async () => {
    // Every refusal above needs a remedy reachable in one call, or the gate is
    // an obstruction.
    const { tool, AppRegistry } = await load();
    const { page: _dropped, ...noPage } = CREATE;
    const out = await tool.execute(noPage as never, {} as never);
    expect(out).toContain('created');
    const html = new AppRegistry({ seed: false }).readAsset('notes', 'index.html');
    expect(html).toContain('/__bernard/applet.js');
    // Dispatched through one `run(action, …)` helper, so the action reaches
    // `bernard.invoke` as a variable — which is also why the validator's
    // literal-action check cannot cover the template, and why the template is
    // instead pinned by passing the validator in `page-validate.test.ts`.
    expect(html).toContain("run('summarise'");
    expect(html).toContain('bernard.invoke(action, args)');
  });

  it('reports a warning without blocking the write', async () => {
    const { tool, AppRegistry } = await load();
    const out = await tool.execute(
      bad(`${PAGE}\n<script>document.getElementById('ghost').focus();</script>`),
      {} as never,
    );
    expect(out).toContain('created');
    expect(out).toContain('Warnings:');
    expect(new AppRegistry({ seed: false }).listIds()).toContain('notes');
  });

  it('returns the page on read, so the description it gives is followable', async () => {
    // `page`'s own description points a model at an existing applet for the
    // shape; until now this branch returned the manifest alone.
    const { tool } = await load();
    await tool.execute(CREATE, {} as never);
    const out = await tool.execute({ action: 'read', id: 'notes' } as never, {} as never);
    expect(out).toContain('--- index.html ---');
    expect(out).toContain('/__bernard/applet.js');
  });
});

/**
 * The `datetime` defect: an action that could never run, written and reported
 * as created, failing as an HTTP 500 at the click.
 */
describe('the applet tool refuses an action that could never run', () => {
  useTempHome('bernard-applet-dispatch');

  const withTool = (tool: string, dispatchArgs: Record<string, unknown> = {}) => ({
    ...CREATE,
    actions: { go: { dispatch: { kind: 'tool' as const, tool, args: dispatchArgs } } },
    page: PAGE.replace("bernard.invoke('summarise')", "bernard.invoke('go')"),
  });

  it('refuses the exact manifest that shipped broken', async () => {
    const { tool, AppRegistry } = await load();
    const out = await tool.execute(withTool('datetime') as never, {} as never);
    expect(out).toContain('Error:');
    expect(out).toContain('datetime');
    // The refusal has to name the way out, or the model just tries again.
    expect(out).toContain('web_search');
    expect(out).toContain('specialistId');
    expect(new AppRegistry({ seed: false }).listIds()).not.toContain('notes');
  });

  it('accepts a tool that actually opted in', async () => {
    const { tool } = await load();
    const out = await tool.execute(
      withTool('web_search', { query: 'bernard' }) as never,
      {} as never,
    );
    expect(out).toContain('created');
  });

  it('refuses a misspelled tool parameter, naming the real ones', async () => {
    const { tool } = await load();
    const out = await tool.execute(withTool('file_write', { pth: '/tmp/x' }) as never, {} as never);
    expect(out).toContain('Error:');
    expect(out).toContain('"pth"');
  });

  it('builds no registry for an agent-backed applet', async () => {
    // The check costs ~76 ms, so it is gated on a tool-backed action being
    // present — the common case must pay nothing.
    const mod = await import('./index.js');
    const spy = vi.spyOn(mod, 'createTools');
    const { tool } = await load();
    await tool.execute(CREATE, {} as never);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('lets an unknown specialist through with a warning, not a refusal', async () => {
    // Deliberately the carve-out: the natural order is create the applet, then
    // create and bind its agent — which is what `agent-builder` does. Refusing
    // would break that sequence, and run time already pre-flights it.
    const { tool, AppRegistry } = await load();
    const out = await tool.execute(CREATE, {} as never);
    expect(out).toContain('created');
    expect(new AppRegistry({ seed: false }).listIds()).toContain('notes');
  });
});
