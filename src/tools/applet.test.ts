import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';

async function load() {
  vi.resetModules();
  const { createAppletTool } = await import('./applet.js');
  const { AppRegistry } = await import('../apps/registry.js');
  return { tool: createAppletTool(new AppRegistry({ seed: false })), AppRegistry };
}

const CREATE = {
  action: 'create' as const,
  id: 'notes',
  name: 'Notes',
  page: '<h1>Notes</h1>',
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
