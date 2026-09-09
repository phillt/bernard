import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from '../__tests__/temp-home.js';

/**
 * `targetTools` must COVER the action a specialist is bound to (#519).
 *
 * `grantedToolNames` hands a dispatch the intersection of the action's
 * `toolAllowlist` and the specialist's `targetTools`, so a tool the action
 * allows and the specialist does not target is simply **absent** — the agent
 * runs with fewer tools than the manifest promises, possibly none, and fails as
 * a bad ANSWER rather than an error. `agent-builder` calls it "the single
 * easiest thing to get wrong", and until now the rule lived only in prose and a
 * bad example.
 *
 * Its own file with a real `BERNARD_HOME`, because the main suite mocks
 * `node:fs` — under that mock the registry cannot resolve anything and the
 * check fails open, so a test there would pass while asserting nothing.
 */
// Called for its `beforeEach`/`afterEach`; the path itself comes from a fresh
// `paths.js` per test, so the returned getter is never read.
useTempHome('spec-bind');

async function load() {
  const { vi } = await import('vitest');
  vi.resetModules();
  const paths = await import('../paths.js');
  const { createSpecialistTool } = await import('./specialist.js');
  return { createSpecialistTool, paths };
}

function writeApp(appsDir: string, toolAllowlist: string[]): void {
  fs.mkdirSync(appsDir, { recursive: true });
  fs.writeFileSync(
    path.join(appsDir, 'notes.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'notes',
      name: 'Notes',
      actions: {
        summarize: {
          description: 'Summarize a note',
          args: {},
          instructions: 'Summarize it.',
          specialistId: 'note-agent',
          toolAllowlist,
        },
      },
    }),
  );
}

/**
 * Edits a saved record on disk, past the tool's own validation.
 *
 * Three tests need this — a binding the gate refuses, a `stepRatio` the schema
 * rejects, and a fence the create schema does not expose at all — and it is
 * the same four lines each time. All three are modelling the same state: a
 * record hand-edited after the fact, which is exactly what the resolver has to
 * survive.
 */
function patchRecord(specialistsDir: string, id: string, patch: Record<string, unknown>): void {
  const file = path.join(specialistsDir, `${id}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
  fs.writeFileSync(file, JSON.stringify({ ...record, ...patch }));
}

describe('binding a specialist to an applet action', () => {
  it('refuses a binding the specialist could never fulfil', async () => {
    const { createSpecialistTool, paths } = await load();
    writeApp(paths.APPS_DIR, ['web_search', 'file_read_lines']);
    const tool = createSpecialistTool();

    await tool.execute(
      {
        action: 'create',
        id: 'note-agent',
        name: 'Note Agent',
        description: 'x',
        systemPrompt: 'x',
        kind: 'tool-wrapper',
        targetTools: ['web_search'],
      } as never,
      {} as never,
    );
    const result = await tool.execute(
      {
        action: 'update',
        id: 'note-agent',
        boundTo: { appId: 'notes', action: 'summarize' },
      } as never,
      {} as never,
    );

    expect(result).toContain('Error:');
    // The missing tool is NAMED. "coverage gap" is not actionable.
    expect(result).toContain('file_read_lines');
    expect(result).toContain('targetTools');
    // And the record is not bound — a refusal that still writes is worse than
    // no refusal, because the manifest then reads as satisfied.
    const record = JSON.parse(
      fs.readFileSync(path.join(paths.SPECIALISTS_DIR, 'note-agent.json'), 'utf-8'),
    );
    expect(record.boundTo).toBeUndefined();
  });

  it('allows a binding whose specialist covers the allowlist', async () => {
    const { createSpecialistTool, paths } = await load();
    writeApp(paths.APPS_DIR, ['web_search']);
    const tool = createSpecialistTool();
    await tool.execute(
      {
        action: 'create',
        id: 'note-agent',
        name: 'Note Agent',
        description: 'x',
        systemPrompt: 'x',
        kind: 'tool-wrapper',
        targetTools: ['web_search', 'web_read'],
      } as never,
      {} as never,
    );
    const result = await tool.execute(
      {
        action: 'update',
        id: 'note-agent',
        boundTo: { appId: 'notes', action: 'summarize' },
      } as never,
      {} as never,
    );
    expect(result).toContain('updated');
  });

  it('fails OPEN when the app cannot be read, rather than blocking a legitimate bind', async () => {
    // A missing app, an unparseable manifest or an unreadable registry means
    // the check could not run — not that the binding is wrong. Refusing a
    // legitimate bind because a manifest was mid-write is worse than the defect.
    const { createSpecialistTool } = await load();
    const tool = createSpecialistTool();
    await tool.execute(
      {
        action: 'create',
        id: 'note-agent',
        name: 'Note Agent',
        description: 'x',
        systemPrompt: 'x',
        kind: 'tool-wrapper',
        targetTools: ['web_search'],
      } as never,
      {} as never,
    );
    const result = await tool.execute(
      { action: 'update', id: 'note-agent', boundTo: { appId: 'nope', action: 'x' } } as never,
      {} as never,
    );
    expect(result).toContain('updated');
  });

  it('holds on the create-and-bind door too', async () => {
    // `agent-builder` deliberately creates unbound and binds last, but nothing
    // forces that order — so both doors carry the rule.
    const { createSpecialistTool } = await load();
    const { APPS_DIR } = await import('../paths.js');
    writeApp(APPS_DIR, ['shell']);
    const tool = createSpecialistTool();
    const result = await tool.execute(
      {
        action: 'create',
        id: 'note-agent',
        name: 'Note Agent',
        description: 'x',
        systemPrompt: 'x',
        kind: 'tool-wrapper',
        targetTools: ['web_search'],
        boundTo: { appId: 'notes', action: 'summarize' },
      } as never,
      {} as never,
    );
    expect(result).toContain('Error:');
    expect(result).toContain('shell');
  });

  it('inspect reports a coverage gap instead of refusing to describe it', async () => {
    // The binding already exists; refusing to describe it is how the one
    // command that could diagnose it becomes useless.
    const { createSpecialistTool, paths } = await load();
    writeApp(paths.APPS_DIR, ['web_search', 'file_read_lines']);
    const tool = createSpecialistTool();
    await tool.execute(
      {
        action: 'create',
        id: 'note-agent',
        name: 'Note Agent',
        description: 'x',
        systemPrompt: 'x',
        kind: 'tool-wrapper',
        targetTools: ['web_search'],
      } as never,
      {} as never,
    );
    // Bind past the gate by writing the record directly — the state a manifest
    // edited after the fact leaves behind.
    patchRecord(paths.SPECIALISTS_DIR, 'note-agent', {
      boundTo: { appId: 'notes', action: 'summarize' },
    });

    const out = await tool.execute({ action: 'inspect', id: 'note-agent' } as never, {} as never);
    expect(out).toContain('bound to: notes/summarize');
    expect(out).toContain('⚠');
    expect(out).toContain('file_read_lines');
  });
});

describe('inspect shows declared against resolved', () => {
  it('names the steps a ratio actually buys, and the tools it targets', async () => {
    const { createSpecialistTool } = await load();
    const tool = createSpecialistTool(undefined, undefined, {
      maxSteps: 20,
      provider: 'anthropic',
    } as never);
    await tool.execute(
      {
        action: 'create',
        id: 'quick',
        name: 'Quick',
        description: 'x',
        systemPrompt: 'x',
        kind: 'tool-wrapper',
        targetTools: ['web_search'],
        stepRatio: 0.2,
        role: 'function-caller',
      } as never,
      {} as never,
    );
    const out = await tool.execute({ action: 'inspect', id: 'quick' } as never, {} as never);
    // The record only names a fraction; this is the question a record cannot
    // answer about itself.
    expect(out).toContain('stepRatio: 0.2 → 4 steps');
    expect(out).toContain('role: function-caller');
    expect(out).toContain('targetTools: web_search');
  });

  it('uses the dispatching definition, not a re-hardcoded ratio', async () => {
    // `tool-wrapper` and `specialist` share a 0.5 default but not the floor:
    // a wrapper cannot go below two steps, because below that it cannot call a
    // tool and then report. Re-deriving the arithmetic here would report a
    // number the runtime is never going to use.
    const { createSpecialistTool } = await load();
    const tool = createSpecialistTool(undefined, undefined, { maxSteps: 20 } as never);
    await tool.execute(
      {
        action: 'create',
        id: 'tiny',
        name: 'Tiny',
        description: 'x',
        systemPrompt: 'x',
        kind: 'tool-wrapper',
        targetTools: ['shell'],
        stepRatio: 0.01,
      } as never,
      {} as never,
    );
    expect(await tool.execute({ action: 'inspect', id: 'tiny' } as never, {} as never)).toContain(
      'stepRatio: 0.01 → 2 steps',
    );
  });

  it("names each fence by its FIELD, not the viewer's short label", async () => {
    // Two vocabularies, both user-visible, and the table carries both rather
    // than unifying them (#552): this surface prints what you would type into
    // the JSON, while the dispatch-context viewer prints `memory` / `knowledge`
    // / `corpus` under a line that has already said "Scoped to:". Nothing
    // pinned that before the table existed, so a later tidy-up collapsing them
    // would have changed this output silently.
    const { createSpecialistTool, paths } = await load();
    const tool = createSpecialistTool(undefined, undefined, { maxSteps: 20 } as never);
    await tool.execute(
      {
        action: 'create',
        id: 'fenced',
        name: 'Fenced',
        description: 'x',
        systemPrompt: 'x',
      } as never,
      {} as never,
    );
    // Hand-edited, because the create schema deliberately does not expose the
    // fences — an array has no clearing sentinel that is not already meaningful.
    patchRecord(paths.SPECIALISTS_DIR, 'fenced', {
      memoryScope: ['deploy-*'],
      corpusScope: ['handbook'],
    });

    const out = await tool.execute({ action: 'inspect', id: 'fenced' } as never, {} as never);
    expect(out).toContain('memoryScope: deploy-*');
    expect(out).toContain('corpusScope: handbook');
    // An undeclared axis is absent, not rendered as unscoped — `[]` is a real
    // posture here and the two must stay distinguishable.
    expect(out).not.toContain('knowledgeScope:');
  });

  it('says when a declared value is being ignored', async () => {
    // The single most useful thing this command can say, and the thing a second
    // implementation of the resolution would get exactly backwards: it would
    // report the declared value as though it will be honoured.
    const { createSpecialistTool, paths } = await load();
    const tool = createSpecialistTool(undefined, undefined, { maxSteps: 20 } as never);
    await tool.execute(
      {
        action: 'create',
        id: 'broken',
        name: 'Broken',
        description: 'x',
        systemPrompt: 'x',
      } as never,
      {} as never,
    );
    // Written past the tool's own refusal, which is the state a hand-edited
    // record arrives in.
    patchRecord(paths.SPECIALISTS_DIR, 'broken', { stepRatio: 50, strategy: 'coordinator' });

    const out = await tool.execute({ action: 'inspect', id: 'broken' } as never, {} as never);
    expect(out).toContain('declared stepRatio 50 is invalid and is ignored');
    expect(out).toContain('strategy: coordinator — not a known strategy, so it is ignored');
  });
});
