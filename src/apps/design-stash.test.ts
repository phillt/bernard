import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';
import { claimDesign, resetStashedDesigns, stashDesign } from './design-stash.js';
import type { AppletDesign } from './design-model.js';

const DESIGN: AppletDesign = {
  architect: {
    singleJob: 'log a reading',
    actions: [
      {
        id: 'log',
        intent: 'create',
        importance: 'primary',
        frequency: 'high',
        risk: 'low',
        reversible: true,
      },
    ],
  },
};

describe('the design stash', () => {
  beforeEach(() => resetStashedDesigns());

  it('hands back exactly what was stashed', () => {
    // The whole reason the model does not retype it: what is stored is the
    // object the planners produced, not a transcription of it.
    expect(claimDesign(stashDesign(DESIGN))).toEqual(DESIGN);
  });

  it('claims once, because a design belongs to one applet', () => {
    // Leaving it would let a second `create` reusing the id attach somebody
    // else's plan — the incoherent record the model exists to prevent.
    const id = stashDesign(DESIGN);
    expect(claimDesign(id)).toEqual(DESIGN);
    expect(claimDesign(id)).toBeUndefined();
  });

  it('answers undefined for a missing or absent id, rather than guessing', () => {
    // A model that forgets the id loses the record and keeps the applet,
    // which is the right way round. Guessing "the most recent design" is how
    // applet B ends up carrying applet A's plan.
    stashDesign(DESIGN);
    expect(claimDesign(undefined)).toBeUndefined();
    expect(claimDesign('plan-nope')).toBeUndefined();
  });

  it('mints distinct ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => stashDesign(DESIGN)));
    expect(ids.size).toBe(20);
  });

  it('is bounded, evicting the oldest', () => {
    // Nothing else evicts, and the cron daemon and applet host hold a process
    // open for days.
    const ids = Array.from({ length: 12 }, () => stashDesign(DESIGN));
    expect(claimDesign(ids[0])).toBeUndefined();
    expect(claimDesign(ids[11])).toEqual(DESIGN);
  });
});

/**
 * The fix for the finding that motivated the model: the plan was produced,
 * truncated twice on its way to the page-writer, and then dropped. Nothing
 * persisted it, and `create` had nowhere to accept it.
 */
describe('a created applet keeps the design it was planned from', () => {
  useTempHome('bernard-design-persist');

  const PAGE = [
    '<link rel="stylesheet" href="/__bernard/tokens.css" />',
    '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
    '<script src="/__bernard/applet.js"></script>',
    '<main><button id="go">Go</button></main>',
    "<script>document.getElementById('go').addEventListener('click', () => bernard.invoke('log'));</script>",
  ].join('\n');

  async function load() {
    vi.resetModules();
    const { createAppletTool } = await import('../tools/applet.js');
    const { AppRegistry } = await import('./registry.js');
    const { AppletBriefStore } = await import('./brief-store.js');
    const stash = await import('./design-stash.js');
    stash.resetStashedDesigns();
    return {
      tool: createAppletTool(new AppRegistry({ seed: false })),
      briefs: new AppletBriefStore(),
      stash,
    };
  }

  const create = (over: Record<string, unknown> = {}) => ({
    action: 'create' as const,
    id: 'readings',
    name: 'Readings',
    description: 'Logs a reading.',
    page: PAGE,
    actions: {
      log: {
        dispatch: { kind: 'agent' as const, specialistId: 'web-wrapper', instructions: 'Log it.' },
      },
    },
    ...over,
  });

  it('stores it against the applet when the plan id comes back', async () => {
    const { tool, briefs, stash } = await load();
    const planId = stash.stashDesign(DESIGN);

    await tool.execute(create({ planId }), {} as never);

    // Read back off DISK through the store, not from the stash — the point is
    // that it outlives the turn, which is what it did not do before.
    expect(briefs.read('readings').design).toEqual(DESIGN);
  });

  it('creates the applet anyway when the id is forgotten', async () => {
    // A warning-shaped failure, deliberately: losing the record must never
    // cost the applet.
    const { tool, briefs } = await load();
    const out = await tool.execute(create(), {} as never);
    expect(String(out)).toContain('created');
    expect(briefs.read('readings').design).toBeUndefined();
  });

  it('lands the design and the intent together', async () => {
    // Both are "what this applet is for". An applet whose brief half-landed
    // is one whose next editor trusts the half that did.
    const { tool, briefs, stash } = await load();
    const planId = stash.stashDesign(DESIGN);
    await tool.execute(
      create({ planId, intent: { goal: 'keep track of my readings' } }),
      {} as never,
    );
    const brief = briefs.read('readings');
    expect(brief.design).toEqual(DESIGN);
    expect(brief.intent.goal).toBe('keep track of my readings');
  });

  it('survives a design the schema no longer recognises', async () => {
    // The file is plain JSON under `DATA_DIR` and hand-editable between runs.
    // A design that stops parsing is dropped rather than taking the brief
    // down: it is context, not authority.
    const { tool, briefs } = await load();
    await tool.execute(create({ intent: { goal: 'x' } }), {} as never);
    const fs = await import('node:fs');
    const paths = await import('../paths.js');
    const path = await import('node:path');
    const file = path.join(paths.APPLET_BRIEFS_DIR, 'readings.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...raw, design: { architect: 'not an object' } }));

    const brief = briefs.read('readings');
    expect(brief.design).toBeUndefined();
    expect(brief.intent.goal).toBe('x');
  });
});
