import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';
import { uncoveredTools } from './invocation.js';

describe('uncoveredTools', () => {
  /**
   * The rule `grantedToolNames` enforces silently, stated so it can be
   * checked. An under-declared specialist yields fewer tools than the manifest
   * promises — possibly none — and fails as a bad ANSWER rather than an error.
   */
  it('names what the specialist cannot reach', () => {
    expect(uncoveredTools(['datetime'], [])).toEqual(['datetime']);
    expect(uncoveredTools(['a', 'b'], ['a'])).toEqual(['b']);
    expect(uncoveredTools(['a'], ['a', 'b'])).toEqual([]);
  });

  it('treats an absent targetTools as covering nothing', () => {
    // The observed case: the record simply had no `targetTools` key.
    expect(uncoveredTools(['datetime'], undefined)).toEqual(['datetime']);
  });
});

describe('bernard app allow', () => {
  useTempHome('bernard-app-allow');
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    vi.resetModules();
  });
  afterEach(() => vi.restoreAllMocks());

  async function setup(targets: string[] | null) {
    const output = await import('../output.js');
    vi.spyOn(output, 'printInfo').mockImplementation((m: string) => void lines.push(m));
    vi.spyOn(output, 'printError').mockImplementation((m: string) => void lines.push(m));

    if (targets !== null) {
      const { SpecialistStore } = await import('../specialists.js');
      new SpecialistStore({ seed: false }).createFull({
        id: 'greeter',
        name: 'S',
        description: 'd',
        kind: 'tool-wrapper',
        systemPrompt: 'p',
        guidelines: [],
        targetTools: targets,
      });
    }
    const { AppRegistry } = await import('./registry.js');
    new AppRegistry({ seed: false }).create(
      {
        schemaVersion: 2,
        id: 'notes',
        name: 'Notes',
        actions: {
          summarise: { dispatch: { kind: 'agent', specialistId: 'greeter', instructions: 'x' } },
        },
      },
      { 'index.html': '<p>x</p>' },
    );
    return (await import('./app-cli.js')).appAllow;
  }

  it('warns when the grant lands on a specialist that cannot use it', async () => {
    // This is the failure that shipped: the grant was applied, the specialist
    // could not reach the tool, and nothing said so — the applet just answered
    // that it had no datetime tool.
    const appAllow = await setup([]);
    appAllow('notes', 'summarise', ['datetime']);
    const all = lines.join('\n');
    expect(all).toContain('does not target datetime');
    expect(all).toContain('no tools at all');
  });

  it("still applies the grant — it is the user's to make", async () => {
    const appAllow = await setup([]);
    appAllow('notes', 'summarise', ['datetime']);
    const { AppRegistry } = await import('./registry.js');
    const app = new AppRegistry({ seed: false }).get('notes');
    expect(app.ok && app.manifest.actions.summarise.toolAllowlist).toEqual(['datetime']);
  });

  it('says nothing when the specialist covers the grant', async () => {
    const appAllow = await setup(['datetime']);
    appAllow('notes', 'summarise', ['datetime']);
    // Asserted on the WARNING, not on the phrase: `appAllow` already prints a
    // generic reminder that the grant is an intersection, which contains
    // "does not target" verbatim. Matching that would pass for the wrong
    // reason — and did, when this assertion was first written.
    expect(lines.join('\n')).not.toContain('Warning:');
  });

  it('names the partial case precisely', async () => {
    const appAllow = await setup(['web_search']);
    appAllow('notes', 'summarise', ['web_search', 'web_read']);
    const all = lines.join('\n');
    expect(all).toContain('does not target web_read');
    expect(all).toContain('only web_search');
  });

  it('flags a specialist that does not exist yet without failing', async () => {
    const appAllow = await setup(null);
    appAllow('notes', 'summarise', ['datetime']);
    expect(lines.join('\n')).toContain('does not exist yet');
  });
});

describe('bernard app list', () => {
  useTempHome('bernard-app-list');
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    vi.resetModules();
  });
  afterEach(() => vi.restoreAllMocks());

  async function setup() {
    const output = await import('../output.js');
    vi.spyOn(output, 'printInfo').mockImplementation((m: string) => void lines.push(m));
    const { AppRegistry } = await import('./registry.js');
    // `seed: true` installs the bundled demo, which is the whole point here.
    const registry = new AppRegistry();
    registry.create(
      {
        schemaVersion: 2,
        id: 'mine',
        name: 'Mine',
        description: 'An applet the user made.',
        actions: {
          go: { dispatch: { kind: 'agent', specialistId: 'web-wrapper', instructions: 'x' } },
        },
      },
      { 'index.html': '<p>x</p>' },
    );
    return (await import('./app-cli.js')).appList;
  }

  it("lists only the user's applets by default", async () => {
    // The reported confusion: a seeded example sitting in the same flat list
    // as your own work, with nothing saying which is which.
    const appList = await setup();
    appList();
    const out = lines.join('\n');
    expect(out).toContain('mine');
    expect(out).not.toContain('demo');
  });

  it('shows the description, which is what makes a list of ids readable', async () => {
    const appList = await setup();
    appList();
    expect(lines.join('\n')).toContain('An applet the user made.');
  });

  it('lists only bundled applets with --bundled', async () => {
    const appList = await setup();
    appList({ bundled: true });
    const out = lines.join('\n');
    expect(out).toContain('demo');
    expect(out).not.toContain('mine');
  });

  it('groups both under headers with --all', async () => {
    const appList = await setup();
    appList({ all: true });
    const out = lines.join('\n');
    expect(out).toContain('Yours:');
    expect(out).toContain('Bundled:');
    expect(out.indexOf('mine')).toBeLessThan(out.indexOf('demo'));
  });

  it('points at the bundled ones when the user has none', async () => {
    // Otherwise "No applets installed" is a lie while demo is holding a port.
    const output = await import('../output.js');
    vi.spyOn(output, 'printInfo').mockImplementation((m: string) => void lines.push(m));
    const { AppRegistry } = await import('./registry.js');
    new AppRegistry();
    const { appList } = await import('./app-cli.js');
    appList();
    expect(lines.join('\n')).toContain('--bundled');
  });

  it('derives bundled-ness from what ships, not from the manifest', async () => {
    // A manifest is user-editable, so a record that could declare itself
    // bundled would let a tampered file claim provenance it does not have.
    const { bundledAppIds } = await import('./registry.js');
    expect(bundledAppIds().has('demo')).toBe(true);
    expect(bundledAppIds().has('mine')).toBe(false);
  });
});

describe('app list formatting', () => {
  useTempHome('bernard-app-list-fmt');
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    vi.resetModules();
  });
  afterEach(() => vi.restoreAllMocks());

  it('aligns the action column and wraps a long description', async () => {
    // The reported problem was that the flat form was unreadable — id, name,
    // count and every action run together at one indent.
    const output = await import('../output.js');
    vi.spyOn(output, 'printInfo').mockImplementation((m: string) => void lines.push(m));
    const { AppRegistry } = await import('./registry.js');
    new AppRegistry({ seed: false }).create(
      {
        schemaVersion: 2,
        id: 'wide',
        name: 'Wide',
        description: 'x '.repeat(80).trim(),
        actions: {
          a: { dispatch: { kind: 'agent', specialistId: 's', instructions: 'i' } },
          longer_name: { dispatch: { kind: 'agent', specialistId: 's', instructions: 'i' } },
        },
      },
      { 'index.html': '<p>x</p>' },
    );
    const { appList } = await import('./app-cli.js');
    appList();

    // No line runs away: the description wraps rather than relying on the
    // terminal, which breaks mid-word and destroys the indent.
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);

    // Both action rows put their mode column at the same offset.
    const actionRows = lines.filter((l) => l.includes('wide/'));
    expect(actionRows).toHaveLength(2);
    expect(new Set(actionRows.map((l) => l.indexOf('read-only'))).size).toBe(1);
  });
});

describe('app list does not read as a list of agents', () => {
  useTempHome('bernard-app-list-actions');
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    vi.resetModules();
  });
  afterEach(() => vi.restoreAllMocks());

  it('addresses actions as <app>/<action> and never calls them agents', async () => {
    // A user seeing `greet  agent  read-only  datetime` under a command called
    // `app list` tried `bernard app delete greet`. The bare name read as a
    // top-level entry, and "agent" read as the kind of thing being listed.
    const output = await import('../output.js');
    vi.spyOn(output, 'printInfo').mockImplementation((m: string) => void lines.push(m));
    const { AppRegistry } = await import('./registry.js');
    new AppRegistry({ seed: false }).create(
      {
        schemaVersion: 2,
        id: 'hello-world',
        name: 'Hello World',
        description: 'd',
        actions: {
          greet: { dispatch: { kind: 'agent', specialistId: 's', instructions: 'i' } },
        },
      },
      { 'index.html': '<p>x</p>' },
    );
    const { appList } = await import('./app-cli.js');
    appList();
    const out = lines.join('\n');

    // The addressable form, which is also what `app allow <app> <action>` takes.
    expect(out).toContain('hello-world/greet');
    // Never the bare name on its own, which is what invited `app delete greet`.
    expect(out).not.toMatch(/^\s+greet\s/m);
    // The dispatch kind is not the subject of this command.
    expect(out).not.toContain('agent');
    expect(out).toContain('actions:');
  });
});
