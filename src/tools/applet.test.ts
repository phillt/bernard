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
