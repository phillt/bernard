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
  description: 'Keeps short notes and summarises them.',
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
      {
        ...CREATE,
        action: 'update',
        description: 'now with a description',
        note: 'added a description',
      },
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

  // Deleting an applet is no longer CLI-only (#456), but it is not an
  // ordinary edit either: it sweeps six stores including any bound agent, so
  // it resolves `high` and the confirm gate asks first. That tiering is
  // asserted in `risk.test.ts` and below; here the contract is only that the
  // action exists and reports honestly on a miss.
  it('refuses to delete an applet that is not there, rather than reporting success', async () => {
    const { tool } = await load();
    const out = await tool.execute({ action: 'delete', id: 'nope' } as never, {} as never);
    // An `Error:` prefix, because `detectResultFailure` reads a bare string as
    // a success with content.
    expect(out).toContain('Error');
    expect(out).toContain('nope');
  });

  it('names the whole sweep when it does delete, including what it keeps', async () => {
    // "Deleted it" is wrong in both directions — it understates the data
    // store and any bound agent, and overstates the port, which is kept so a
    // re-created id gets its origin and browser storage back.
    const { tool, AppRegistry } = await load();
    await tool.execute(CREATE, {} as never);
    const out = await tool.execute({ action: 'delete', id: 'notes' } as never, {} as never);
    expect(out).toContain('data store');
    expect(out).toContain('port assignment is kept');
    expect(new AppRegistry({ seed: false }).listIds()).not.toContain('notes');
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

  /**
   * `delete` is the one action a model may take that destroys user work, so
   * the guard is not that it is absent (#456 added it) but that it cannot run
   * unasked. `medium` would not prompt under the default `confirmMode:
   * 'auto'`, and a static `risk: 'high'` would prompt on `list` too.
   */
  it('resolves delete to high risk, and the looking actions to low', async () => {
    const { createAppletTool } = await import('./applet.js');
    const { riskFromMeta } = await import('../risk.js');
    const { readToolMeta } = await import('../framework/tools/adapter.js');
    const meta = readToolMeta(createAppletTool());
    expect(riskFromMeta(meta, { action: 'delete', id: 'x' })).toBe('high');
    expect(riskFromMeta(meta, { action: 'list' })).toBe('low');
    expect(riskFromMeta(meta, { action: 'read', id: 'x' })).toBe('low');
    // Authoring stays where it was: worth a prompt in strict mode, not in auto.
    expect(riskFromMeta(meta, { action: 'create', id: 'x' })).toBe('medium');
  });

  it('stays unreachable from an applet action, which is the second layer', async () => {
    // The risk tier is what makes a REPL delete ask first. This is what stops
    // an applet's own button reaching the tool at all: `directInvocable` is
    // the opt-in a manifest needs to name a tool, and `applet` does not
    // declare it. Both layers, because the first one has a headless hole by
    // design — nobody is there to confirm.
    const { createAppletTool } = await import('./applet.js');
    const { readToolMeta } = await import('../framework/tools/adapter.js');
    expect(readToolMeta(createAppletTool())?.directInvocable).toBeUndefined();
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
    expect(out).toContain('targetTools');
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

/**
 * The intersection rule, which CLAUDE.md recorded as "the rule with no code
 * behind it" — and which the `datetime` refusal made much easier to hit, by
 * routing every ineligible-tool case into "use a specialist" without saying
 * what a specialist needs.
 *
 * Observed: an action declaring `toolAllowlist: ['datetime']` pointed at a
 * specialist with no `targetTools`. The intersection was empty, so the agent
 * ran with no tools and answered "No datetime tool available" — a bad answer,
 * not an error, which is what made it hard to see.
 *
 * Note the tool cannot set `toolAllowlist` itself: that is the authority split,
 * so an allowlist only ever arrives from `bernard app allow`. The tool's own
 * check therefore covers the CARRY-FORWARD path (an update of an applet that
 * already has grants), and `app-cli.test.ts` covers the producer.
 */
describe('the applet tool enforces the toolAllowlist ∩ targetTools rule', () => {
  useTempHome('bernard-applet-intersection');

  /**
   * Sets up an applet whose action grants `tools`, backed by a specialist
   * targeting `targets`.
   *
   * **Everything after one `vi.resetModules()`, deliberately.** `paths.ts`
   * caches `BERNARD_HOME` at module load, and `useTempHome` hands out a new
   * directory per test — so an import issued BEFORE the reset returns the
   * previous test's module instance, still pointing at the previous test's
   * (now deleted) directory. That writes the specialist somewhere nothing will
   * look, and the assertion then fails only when the file is run as a whole,
   * passing in isolation. Which is exactly how this was found.
   */
  async function setup(specialistId: string, targets: string[] | null, tools: string[]) {
    vi.resetModules();
    const { SpecialistStore } = await import('../specialists.js');
    const { createAppletTool } = await import('./applet.js');
    const { AppRegistry } = await import('../apps/registry.js');
    const { APPS_DIR } = await import('../paths.js');
    const fs = await import('node:fs');
    const path = await import('node:path');

    if (targets !== null) {
      new SpecialistStore({ seed: false }).createFull({
        id: specialistId,
        name: 'S',
        description: 'd',
        kind: 'tool-wrapper',
        systemPrompt: 'p',
        guidelines: [],
        targetTools: targets,
      });
    }

    const tool = createAppletTool(new AppRegistry({ seed: false }));
    await tool.execute(
      {
        ...CREATE,
        actions: {
          summarise: {
            dispatch: { kind: 'agent' as const, specialistId, instructions: 'do it' },
          },
        },
      } as never,
      {} as never,
    );

    // The allowlist can only come from `bernard app allow` — the tool cannot
    // set it — so it is written the way that command writes it.
    const file = path.join(APPS_DIR, 'notes.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      actions: Record<string, Record<string, unknown>>;
    };
    raw.actions.summarise.toolAllowlist = tools;
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');
    return tool;
  }

  const edit = (tool: { execute: (a: unknown, b: unknown) => Promise<string> }) =>
    tool.execute({ action: 'update', id: 'notes', description: 'edited', note: 'edited' }, {});

  it('refuses an update that would leave the action with no tools', async () => {
    const tool = await setup('greeter', [], ['datetime']);
    const out = await edit(tool);
    expect(out).toContain('Error:');
    expect(out).toContain('no tools at all');
    expect(out).toContain("target ['datetime']");
  });

  it('names only the tools that are actually missing', async () => {
    const tool = await setup('partial', ['web_search'], ['web_search', 'web_read']);
    const out = await edit(tool);
    expect(out).toContain('does not target web_read');
    // Names what is missing, and what survives — not a vague "fewer tools".
    expect(out).toContain('only web_search');
  });

  it('accepts a specialist that covers the allowlist', async () => {
    const tool = await setup('covers', ['web_search', 'web_read'], ['web_search']);
    const out = await edit(tool);
    expect(out).toContain('updated');
  });

  it('warns rather than refuses when the specialist does not exist yet', async () => {
    // The carve-out that keeps `agent-builder`'s order possible: write the
    // applet, then build and bind its agent. A specialist created afterwards
    // is picked up on the next invocation — the store is read per dispatch,
    // never cached, so nothing has to be restarted.
    const tool = await setup('not-yet', null, ['datetime']);
    const out = await edit(tool);
    expect(out).toContain('updated');
    expect(out).toContain('does not exist yet');
    expect(out).toContain('datetime');
  });
});

describe('the applet tool requires a description', () => {
  useTempHome('bernard-applet-description');

  it('refuses a create with no description', async () => {
    // Required by the TOOL, not the schema: `bernard app list` shows it, and a
    // list of bare ids is what made a seeded example indistinguishable from
    // the user's own work.
    const { tool, AppRegistry } = await load();
    const { description: _dropped, ...noDescription } = CREATE;
    const out = await tool.execute(noDescription as never, {} as never);
    expect(out).toContain('Error:');
    expect(out).toContain('description');
    expect(new AppRegistry({ seed: false }).listIds()).not.toContain('notes');
  });

  it('keeps the description on the manifest, where the listing reads it', async () => {
    const { tool, AppRegistry } = await load();
    await tool.execute(CREATE, {} as never);
    const app = new AppRegistry({ seed: false }).get('notes');
    expect(app.ok && app.manifest.description).toBe('Keeps short notes and summarises them.');
  });

  it('does not demand one on update, which would block every small edit', async () => {
    const { tool } = await load();
    await tool.execute(CREATE, {} as never);
    const out = await tool.execute(
      { action: 'update', id: 'notes', name: 'Notes v2', note: 'renamed' } as never,
      {} as never,
    );
    expect(out).toContain('updated');
  });
});

describe('a new applet says how to actually grant its tools', () => {
  useTempHome('bernard-applet-grant-hint');

  it('names `app allow`, not `app-grant`', async () => {
    // `app-grant` writes permission RULES, which refine tools an action
    // already has; it cannot add one. Pointing at it meant following the
    // instruction exactly left the button broken — observed as
    // "No datetime tool available" from an applet whose author did everything
    // else right.
    const { tool } = await load();
    const out = await tool.execute(CREATE, {} as never);
    expect(out).toContain('bernard app allow notes summarise --tools');
    expect(out).toContain('cannot add one');
  });

  it('warns when the specialist targets tools the action does not grant', async () => {
    // The action's allowlist is empty at create (the tool cannot set it), so
    // a specialist built to use tools is guaranteed an empty intersection.
    vi.resetModules();
    const { SpecialistStore } = await import('../specialists.js');
    new SpecialistStore({ seed: false }).createFull({
      id: 'greeter',
      name: 'S',
      description: 'd',
      kind: 'tool-wrapper',
      systemPrompt: 'p',
      guidelines: [],
      targetTools: ['datetime'],
    });
    const { createAppletTool } = await import('./applet.js');
    const { AppRegistry } = await import('../apps/registry.js');
    const tool = createAppletTool(new AppRegistry({ seed: false }));
    const out = await tool.execute(
      {
        ...CREATE,
        actions: {
          summarise: {
            dispatch: { kind: 'agent' as const, specialistId: 'greeter', instructions: 'go' },
          },
        },
      } as never,
      {} as never,
    );
    expect(out).toContain('created');
    expect(out).toContain('runs with nothing');
    expect(out).toContain('--tools datetime');
  });

  it('stays quiet for a text-only action, which legitimately needs no tools', async () => {
    vi.resetModules();
    const { SpecialistStore } = await import('../specialists.js');
    new SpecialistStore({ seed: false }).createFull({
      id: 'writer',
      name: 'S',
      description: 'd',
      kind: 'tool-wrapper',
      systemPrompt: 'p',
      guidelines: [],
      targetTools: [],
    });
    const { createAppletTool } = await import('./applet.js');
    const { AppRegistry } = await import('../apps/registry.js');
    const tool = createAppletTool(new AppRegistry({ seed: false }));
    const out = await tool.execute(
      {
        ...CREATE,
        actions: {
          summarise: {
            dispatch: { kind: 'agent' as const, specialistId: 'writer', instructions: 'go' },
          },
        },
      } as never,
      {} as never,
    );
    expect(out).not.toContain('runs with nothing');
  });
});

describe('instructions are not a template', () => {
  useTempHome('bernard-applet-placeholder');

  const withInstructions = (instructions: string) => ({
    ...CREATE,
    actions: {
      summarise: { dispatch: { kind: 'agent' as const, specialistId: 's', instructions } },
    },
  });

  it('warns on {{arg}}, which reaches the model as a literal', async () => {
    // Observed working by luck: an action whose instructions said `{{dob}}`
    // returned the right answer because the model ALSO had the real value in
    // the args block. "Reply with exactly {{dob}}" would print the literal.
    const { tool } = await load();
    const out = await tool.execute(
      withInstructions('The user provided DOB: {{dob}}. Read their sign.') as never,
      {} as never,
    );
    expect(out).toContain('created');
    expect(out).toContain('{{dob}}');
    expect(out).toContain('NOT interpolated');
  });

  it('warns rather than refuses, because the action still works', async () => {
    const { tool, AppRegistry } = await load();
    await tool.execute(withInstructions('Use {{a}} and {{b}}.') as never, {} as never);
    expect(new AppRegistry({ seed: false }).listIds()).toContain('notes');
  });

  it('says nothing for ordinary instructions', async () => {
    const { tool } = await load();
    const out = await tool.execute(
      withInstructions('Summarise the text from the supplied JSON.') as never,
      {} as never,
    );
    expect(out).not.toContain('NOT interpolated');
  });
});

/**
 * Declaring is not granting (#467, #468).
 *
 * The tool may write `permissions` because a declaration is a REQUEST — the
 * user is shown it and allows or denies it. That is the opposite polarity from
 * the authority fields above, and both halves need pinning: the tool must be
 * able to ask, and asking must reach no header.
 */
describe('the applet tool declares permissions but grants none', () => {
  useTempHome('bernard-applet-permissions');

  const withPermissions = {
    ...CREATE,
    permissions: {
      imgSrc: { origins: ['https://cdn.example.com'], reason: 'so each headline has a thumbnail' },
      sandbox: { tokens: ['links' as const], reason: 'so you can open a story' },
    },
  };

  it('writes a declaration and stamps the manifest v3', async () => {
    const { createAppletTool } = await import('./applet.js');
    const { AppRegistry } = await import('../apps/registry.js');
    const store = new AppRegistry({ seed: false });
    await createAppletTool(store).execute(withPermissions, {} as never);
    const app = store.get('notes');
    expect(app.ok).toBe(true);
    if (!app.ok) return;
    expect(app.manifest.schemaVersion).toBe(3);
    expect(app.manifest.permissions?.imgSrc?.origins).toEqual(['https://cdn.example.com']);
  });

  it('leaves an applet that declares nothing on v2', async () => {
    // The version union means an older binary rejects the whole app rather
    // than the field it does not know, so a gratuitous bump would cost every
    // existing applet its readability to pay for a field it does not use.
    const { createAppletTool } = await import('./applet.js');
    const { AppRegistry } = await import('../apps/registry.js');
    const store = new AppRegistry({ seed: false });
    // A distinct id: `create` refuses a duplicate, and reading the applet the
    // previous test wrote would assert nothing about this one.
    await createAppletTool(store).execute({ ...CREATE, id: 'plain' }, {} as never);
    const app = store.get('plain');
    expect(app.ok && app.manifest.schemaVersion).toBe(2);
  });

  it('carries a declaration through an update that does not mention it', async () => {
    // An edit to the page is not a withdrawal of a request the user may not
    // have answered yet.
    const { createAppletTool } = await import('./applet.js');
    const { AppRegistry } = await import('../apps/registry.js');
    const store = new AppRegistry({ seed: false });
    const tool = createAppletTool(store);
    await tool.execute(withPermissions, {} as never);
    await tool.execute(
      { action: 'update', id: 'notes', page: PAGE, note: 'new page' },
      {} as never,
    );
    const app = store.get('notes');
    expect(app.ok && app.manifest.permissions?.imgSrc?.origins).toEqual([
      'https://cdn.example.com',
    ]);
  });

  it('grants nothing by declaring — the served header is unchanged', async () => {
    // The single assertion the whole three-channel design rests on.
    const { createAppletTool } = await import('./applet.js');
    const { AppRegistry } = await import('../apps/registry.js');
    const { loadAppCspGrant } = await import('../apps/app-csp-grants.js');
    const { cspFor } = await import('../host/csp.js');
    await createAppletTool(new AppRegistry({ seed: false })).execute(withPermissions, {} as never);
    expect(loadAppCspGrant('notes')).toBeNull();
    expect(cspFor(loadAppCspGrant('notes'))).toBe(cspFor());
  });

  it('refuses an origin the user could never grant', async () => {
    const { createAppletTool } = await import('./applet.js');
    const { AppRegistry } = await import('../apps/registry.js');
    const out = await createAppletTool(new AppRegistry({ seed: false })).execute(
      { ...CREATE, permissions: { imgSrc: { origins: ['https:/'] } } },
      {} as never,
    );
    expect(out).toMatch(/Error/);
  });

  it('advertises no grant field alongside the request', async () => {
    // `permissions` is what the model may ask with; nothing here may set what
    // the user answered.
    const { createAppletTool } = await import('./applet.js');
    const shape = (createAppletTool().parameters as unknown as { shape: Record<string, unknown> })
      .shape;
    expect(Object.keys(shape)).toContain('permissions');
    for (const grantField of ['cspGrants', 'appCspGrants', 'allowOrigins', 'sandboxTokens']) {
      expect(Object.keys(shape)).not.toContain(grantField);
    }
  });
});

/**
 * The consent hand-off (#467, #468).
 *
 * These pin the direction the mechanism fails in. A grant is written only when
 * a user answered; every other path — no callback at all, an empty answer —
 * leaves the applet built and the browser still blocking.
 */
describe('the applet tool asks before anything is granted', () => {
  useTempHome('bernard-applet-consent');

  // `useTempHome` is per-describe, so the registry persists between tests here
  // and `create` refuses a duplicate id. One id per test, or a later assertion
  // reads the applet an earlier test wrote.
  const WITH = (id: string) => ({
    ...CREATE,
    id,
    permissions: { imgSrc: { origins: ['https://cdn.example.com'], reason: 'thumbnails' } },
  });

  async function tools() {
    const { createAppletTool } = await import('./applet.js');
    const { AppRegistry } = await import('../apps/registry.js');
    const grants = await import('../apps/app-csp-grants.js');
    return { createAppletTool, AppRegistry, grants };
  }

  it('writes the grant the user allowed', async () => {
    const { createAppletTool, AppRegistry, grants } = await tools();
    const consent = vi.fn(async (req: { pending: unknown[] }) => req.pending as never);
    const out = await createAppletTool(new AppRegistry({ seed: false }), consent).execute(
      WITH('allowed'),
      {} as never,
    );
    expect(consent).toHaveBeenCalledOnce();
    expect(grants.loadAppCspGrant('allowed')).toEqual({ imgSrc: ['https://cdn.example.com'] });
    expect(out).toContain('The user allowed');
  });

  it('grants nothing when the user denies, and tells the model so', async () => {
    // Denying is a normal outcome, not a build failure: the applet exists and
    // the model is told, so the page can degrade rather than show dead frames.
    const { createAppletTool, AppRegistry, grants } = await tools();
    const out = await createAppletTool(new AppRegistry({ seed: false }), async () => []).execute(
      WITH('denied'),
      {} as never,
    );
    expect(grants.loadAppCspGrant('denied')).toBeNull();
    expect(out).toContain('created');
    expect(out).toContain('did NOT allow');
  });

  it('grants nothing when there is nobody to ask', async () => {
    // The fail-closed path, and the one a forgotten call site lands on: no
    // callback means no consent, never implied consent.
    const { createAppletTool, AppRegistry, grants } = await tools();
    const out = await createAppletTool(new AppRegistry({ seed: false })).execute(
      WITH('headless'),
      {} as never,
    );
    expect(grants.loadAppCspGrant('headless')).toBeNull();
    expect(out).toContain('nobody was present to ask');
  });

  it('does not ask at all when the applet declared nothing', async () => {
    const { createAppletTool, AppRegistry } = await tools();
    const consent = vi.fn(async () => []);
    await createAppletTool(new AppRegistry({ seed: false }), consent).execute(
      { ...CREATE, id: 'nodeclare' },
      {} as never,
    );
    expect(consent).not.toHaveBeenCalled();
  });

  it('does not re-ask on an update for something already granted', async () => {
    const { createAppletTool, AppRegistry } = await tools();
    const store = new AppRegistry({ seed: false });
    const consent = vi.fn(async (req: { pending: unknown[] }) => req.pending as never);
    const tool = createAppletTool(store, consent);
    await tool.execute(WITH('reask'), {} as never);
    const out = await tool.execute(
      { action: 'update', id: 'reask', page: PAGE, note: 'new page' },
      {} as never,
    );
    expect(consent).toHaveBeenCalledOnce();
    expect(out).toContain('already permitted');
  });
});

/**
 * The four grantable directives are named in three places — the table in
 * `csp-grant.ts`, the manifest's declaration schema, and the tool's own
 * advertised schema — and nothing but this test ties them together.
 *
 * Drift fails in the safe direction (a directive becomes un-requestable rather
 * than over-granted), so this is maintenance hygiene rather than a security
 * guard. It is the habit the codebase already keeps for `WRITE_PATH_TOOLS`,
 * `FILE_TOOLS` and `AUTHORITY_ACTION_FIELDS`: an enumeration is written down
 * once and a test asserts the copies agree.
 */
describe('the grantable directives agree across every schema that names them', () => {
  it('matches the table, the manifest schema and the tool schema', async () => {
    const { GRANTABLE_DIRECTIVES } = await import('../host/csp-grant.js');
    const { AppPermissionsSchema } = await import('../apps/manifest.js');
    const { createAppletTool } = await import('./applet.js');

    const expected = [...GRANTABLE_DIRECTIVES].sort();
    const manifestKeys = Object.keys(AppPermissionsSchema.shape)
      .filter((k) => k !== 'sandbox')
      .sort();

    const params = createAppletTool().parameters as unknown as {
      shape: { permissions: { unwrap: () => { shape: Record<string, unknown> } } };
    };
    const toolKeys = Object.keys(params.shape.permissions.unwrap().shape)
      .filter((k) => k !== 'sandbox')
      .sort();

    expect(manifestKeys).toEqual(expected);
    expect(toolKeys).toEqual(expected);
  });
});

/**
 * The design pass on create (`applet-styler` routing).
 *
 * `loadConfig` throws under a temp home with no provider key, which is exactly
 * the branch `styleNote` catches — so the config module is mocked here rather
 * than leaving every assertion to pass for the wrong reason. `autoOpenApplets`
 * is forced off in the same mock: it is the next line to run, and a test that
 * spawns a browser is a test that fails on someone else's machine.
 */
async function loadWithStyler(
  styler?: ReturnType<typeof vi.fn>,
  config: { autoStyleApplets?: boolean } = {},
) {
  vi.resetModules();
  vi.doMock('../config.js', () => ({
    loadConfig: () => ({
      autoStyleApplets: config.autoStyleApplets ?? true,
      autoOpenApplets: false,
    }),
  }));
  const { createAppletTool } = await import('./applet.js');
  const { AppRegistry } = await import('../apps/registry.js');
  return {
    tool: createAppletTool(new AppRegistry({ seed: false }), undefined, styler as never),
    AppRegistry,
  };
}

describe('the design pass on create', () => {
  useTempHome('bernard-applet-style');

  it('hands a new applet to the styler and reports what it did', async () => {
    const styler = vi.fn(async () => ({ styled: true, summary: 'Rewrote the layout.' }));
    const { tool } = await loadWithStyler(styler);

    const out = await tool.execute({ ...CREATE, id: 'styled-ok' }, {} as never);

    expect(styler).toHaveBeenCalledTimes(1);
    expect(styler.mock.calls[0][0]).toEqual({
      id: 'styled-ok',
      name: 'Notes',
      description: 'Keeps short notes and summarises them.',
      actions: ['summarise'],
    });
    expect(out).toContain('Styled it: Rewrote the layout.');
  });

  it('does not style when the flag is off', async () => {
    const styler = vi.fn(async () => ({ styled: true }));
    const { tool } = await loadWithStyler(styler, { autoStyleApplets: false });

    const out = await tool.execute({ ...CREATE, id: 'flag-off' }, {} as never);

    expect(styler).not.toHaveBeenCalled();
    expect(out).toContain('created');
    expect(out).not.toContain('Styled');
  });

  it('does not style when no styler was supplied — the createTools instance', async () => {
    const { tool } = await loadWithStyler(undefined);

    const out = await tool.execute({ ...CREATE, id: 'no-styler' }, {} as never);

    expect(out).toContain('created');
    expect(out).not.toContain('Styled');
  });

  it('a styling failure never fails the create, and is named', async () => {
    // The applet is already on disk when the pass runs. Reporting the failure
    // as a tool error would tell the model to retry a write that succeeded.
    const styler = vi.fn(async () => ({ styled: false, reason: 'pool_exhausted' }));
    const { tool, AppRegistry } = await loadWithStyler(styler);

    const out = await tool.execute({ ...CREATE, id: 'style-failed' }, {} as never);

    expect(out.startsWith('Error:')).toBe(false);
    expect(out).toContain('created');
    expect(out).toContain('pool_exhausted');
    expect(new AppRegistry({ seed: false }).listIds()).toContain('style-failed');
  });

  it('a thrown styler never fails the create either', async () => {
    const styler = vi.fn(async () => {
      throw new Error('boom');
    });
    const { tool, AppRegistry } = await loadWithStyler(styler);

    const out = await tool.execute({ ...CREATE, id: 'style-threw' }, {} as never);

    // `makeAppletStyler` catches, but the tool must not depend on that: a
    // second producer of this callback would be free to throw.
    expect(out.startsWith('Error:')).toBe(false);
    expect(new AppRegistry({ seed: false }).listIds()).toContain('style-threw');
  });

  it('styles before opening the browser', async () => {
    // Ordering is the whole reason this hook is inside `run()` rather than a
    // wrapper around the tool: styling after the open shows the scaffold and
    // makes the user refresh.
    const order: string[] = [];
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({ autoStyleApplets: true, autoOpenApplets: true }),
    }));
    vi.doMock('../apps/open.js', () => ({
      openApplet: async () => {
        order.push('open');
        return { url: 'http://127.0.0.1:1', opened: false, started: false };
      },
    }));
    const { createAppletTool } = await import('./applet.js');
    const { AppRegistry } = await import('../apps/registry.js');
    const styler = vi.fn(async () => {
      order.push('style');
      return { styled: true };
    });
    const tool = createAppletTool(new AppRegistry({ seed: false }), undefined, styler as never);

    await tool.execute({ ...CREATE, id: 'order-check' }, {} as never);

    expect(order).toEqual(['style', 'open']);
  });

  it('update never styles — a supplied page is the page that was meant', async () => {
    const styler = vi.fn(async () => ({ styled: true }));
    const { tool } = await loadWithStyler(styler);
    await tool.execute({ ...CREATE, id: 'no-restyle' }, {} as never);
    styler.mockClear();

    await tool.execute(
      { action: 'update', id: 'no-restyle', page: PAGE, note: 'new page' } as never,
      {} as never,
    );

    expect(styler).not.toHaveBeenCalled();
  });
});

describe('the style action', () => {
  useTempHome('bernard-applet-style-action');

  it('restyles an existing applet, ignoring the auto flag', async () => {
    // The flag governs what happens without being asked. This IS the ask.
    const styler = vi.fn(async () => ({ styled: true, summary: 'Tightened the form.' }));
    const { tool } = await loadWithStyler(styler, { autoStyleApplets: false });
    await tool.execute({ ...CREATE, id: 'restyle-me' }, {} as never);

    const out = await tool.execute({ action: 'style', id: 'restyle-me' } as never, {} as never);

    expect(styler).toHaveBeenCalledTimes(1);
    expect(out).toContain('Restyled "Notes" (restyle-me).');
    expect(out).toContain('Tightened the form.');
  });

  it('reports a refusal as an error, since nothing else was asked for', async () => {
    const styler = vi.fn(async () => ({ styled: false, reason: 'no_api_key' }));
    const { tool } = await loadWithStyler(styler);
    await tool.execute({ ...CREATE, id: 'style-refused' }, {} as never);

    const out = await tool.execute({ action: 'style', id: 'style-refused' } as never, {} as never);

    expect(out).toContain('Error:');
    expect(out).toContain('no_api_key');
    expect(out).toContain('unchanged');
  });

  it('says plainly that the pass is unavailable rather than reporting a failure', async () => {
    const { tool } = await loadWithStyler(undefined);
    await tool.execute({ ...CREATE, id: 'style-unavailable' }, {} as never);

    const out = await tool.execute(
      { action: 'style', id: 'style-unavailable' } as never,
      {} as never,
    );

    expect(out).toContain('not available here');
  });

  it('refuses an unknown applet', async () => {
    const { tool } = await loadWithStyler(vi.fn(async () => ({ styled: true })));

    const out = await tool.execute({ action: 'style', id: 'nope' } as never, {} as never);

    expect(out.startsWith('Error:')).toBe(true);
  });
});

/**
 * The design brief (#463): intent on create, a note on every update.
 *
 * `loadWithStyler` already owns the config mock and explains why it is needed
 * (`loadConfig` throws under a temp home with no provider key); this adds only
 * the store the assertions read back through.
 */
async function loadWithBrief() {
  const loaded = await loadWithStyler(undefined, { autoStyleApplets: false });
  return { ...loaded, brief: await import('../apps/brief-store.js') };
}

describe('the design brief', () => {
  useTempHome('bernard-applet-brief-tool');

  it('writes the intent with the applet on create', async () => {
    const { tool, brief } = await loadWithBrief();

    await tool.execute(
      { ...CREATE, id: 'with-intent', intent: { goal: 'send shifts', friction: 'copying' } },
      {} as never,
    );

    expect(new brief.AppletBriefStore().read('with-intent').intent).toEqual({
      goal: 'send shifts',
      friction: 'copying',
    });
  });

  it('refuses an update with no note, and names the field', async () => {
    // Required by the TOOL, like `description` on create: a brief written only
    // when convenient is written once and then drifts.
    const { tool } = await loadWithBrief();
    await tool.execute({ ...CREATE, id: 'needs-note' }, {} as never);

    const out = await tool.execute(
      { action: 'update', id: 'needs-note', page: PAGE } as never,
      {} as never,
    );

    expect(out).toContain('Error:');
    expect(out).toContain('note');
  });

  it('records the note on a successful update', async () => {
    const { tool, brief } = await loadWithBrief();
    await tool.execute({ ...CREATE, id: 'noted-update' }, {} as never);

    await tool.execute(
      {
        action: 'update',
        id: 'noted-update',
        page: PAGE,
        note: 'dropped the second column, too cramped',
      } as never,
      {} as never,
    );

    expect(new brief.AppletBriefStore().read('noted-update').notes.map((n) => n.text)).toEqual([
      'dropped the second column, too cramped',
    ]);
  });

  it('returns the brief from `read`, and only when there is one', async () => {
    // `read` is the only place the brief loads: whoever calls it is about to
    // edit, which is exactly when knowing what was already tried is worth the
    // tokens.
    const { tool } = await loadWithBrief();
    await tool.execute({ ...CREATE, id: 'readable' }, {} as never);

    const before = await tool.execute({ action: 'read', id: 'readable' } as never, {} as never);
    expect(before).not.toContain('design brief');

    await tool.execute(
      { action: 'brief', id: 'readable', intent: { goal: 'stay on top of shifts' } } as never,
      {} as never,
    );
    const after = await tool.execute({ action: 'read', id: 'readable' } as never, {} as never);

    expect(after).toContain('--- design brief ---');
    expect(after).toContain('stay on top of shifts');
  });

  it('reads the brief back through the `brief` action, and says when empty', async () => {
    const { tool } = await loadWithBrief();
    await tool.execute({ ...CREATE, id: 'brief-rw' }, {} as never);

    expect(await tool.execute({ action: 'brief', id: 'brief-rw' } as never, {} as never)).toContain(
      'no design brief yet',
    );

    await tool.execute(
      { action: 'brief', id: 'brief-rw', note: 'chose an agent action' } as never,
      {} as never,
    );

    expect(await tool.execute({ action: 'brief', id: 'brief-rw' } as never, {} as never)).toContain(
      'chose an agent action',
    );
  });

  it('lets a wrong intent field be corrected, not just added to', async () => {
    const { tool, brief } = await loadWithBrief();
    await tool.execute(
      { ...CREATE, id: 'correctable', intent: { goal: 'wrong', who: 'me' } },
      {} as never,
    );

    await tool.execute(
      { action: 'brief', id: 'correctable', intent: { goal: 'right', who: '' } } as never,
      {} as never,
    );

    expect(new brief.AppletBriefStore().read('correctable').intent).toEqual({ goal: 'right' });
  });

  it('refuses a brief for an applet that does not exist', async () => {
    const { tool } = await loadWithBrief();
    const out = await tool.execute({ action: 'brief', id: 'ghost' } as never, {} as never);
    expect(out.startsWith('Error:')).toBe(true);
  });
});
