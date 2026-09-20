import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from './__tests__/temp-home.js';
import type { ToolProfile } from './tool-profiles.js';
import type { PermissionRule } from './tool-permissions.js';

/**
 * Removing an MCP server sweeps everything keyed to its tools (#377).
 *
 * Real stores and a real filesystem throughout, deliberately: the bug was that
 * `removeMCPServer` is a pure `mcp.json` filter and both call sites paired it
 * with nothing at all, so a test that asserted "the row is gone" passed for the
 * whole life of the feature while 193 tool profiles accumulated on disk. Only
 * "the file is not there" can fail on that.
 */
useTempHome('bernard-mcp-lifecycle');

let m: {
  removeMCPServerEverywhere: typeof import('./mcp-lifecycle.js').removeMCPServerEverywhere;
  describeMCPRemoval: typeof import('./mcp-lifecycle.js').describeMCPRemoval;
  sweptNothing: typeof import('./mcp-lifecycle.js').sweptNothing;
  orphanedMCPServers: typeof import('./mcp-lifecycle.js').orphanedMCPServers;
  mcpToolName: typeof import('./mcp-names.js').mcpToolName;
  mcpServerSegment: typeof import('./mcp-names.js').mcpServerSegment;
  mcpProfileKey: typeof import('./mcp-names.js').mcpProfileKey;
  ToolProfileStore: typeof import('./tool-profiles.js').ToolProfileStore;
  SpecialistStore: typeof import('./specialists.js').SpecialistStore;
  paths: typeof import('./paths.js');
  saveActiveSettings: typeof import('./profiles.js').saveActiveSettings;
  getActiveSettings: typeof import('./profiles.js').getActiveSettings;
  loadProfiles: typeof import('./profiles.js').loadProfiles;
  saveAppGrants: typeof import('./apps/app-grants.js').saveAppGrants;
  loadAppGrants: typeof import('./apps/app-grants.js').loadAppGrants;
  createProfile: typeof import('./profiles.js').createProfile;
  loadActiveProfileRules: typeof import('./profiles.js').loadActiveProfileRules;
};

beforeEach(async () => {
  vi.resetModules();
  m = {
    ...(await import('./mcp-lifecycle.js')),
    ...(await import('./mcp-names.js')),
    ToolProfileStore: (await import('./tool-profiles.js')).ToolProfileStore,
    SpecialistStore: (await import('./specialists.js')).SpecialistStore,
    paths: await import('./paths.js'),
    ...(await import('./profiles.js')),
    ...(await import('./apps/app-grants.js')),
  } as typeof m;
});

/** Writes `mcp.json` with the given stdio server keys. */
function seedConfig(...keys: string[]): void {
  fs.mkdirSync(path.dirname(m.paths.MCP_CONFIG_PATH), { recursive: true });
  const mcpServers = Object.fromEntries(keys.map((k) => [k, { command: 'npx', args: [k] }]));
  fs.writeFileSync(m.paths.MCP_CONFIG_PATH, JSON.stringify({ mcpServers }, null, 2));
}

function configKeys(): string[] {
  if (!fs.existsSync(m.paths.MCP_CONFIG_PATH)) return [];
  const raw = JSON.parse(fs.readFileSync(m.paths.MCP_CONFIG_PATH, 'utf-8')) as {
    mcpServers: Record<string, unknown>;
  };
  return Object.keys(raw.mcpServers);
}

/** Writes a profile straight to disk, so a fixture can set fields no writer does. */
function seedProfile(toolKey: string, extra: Partial<ToolProfile> = {}): void {
  const store = new m.ToolProfileStore({ seed: false });
  store.save({
    toolName: toolKey,
    guidelines: [],
    goodExamples: [],
    badExamples: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    errorCount: 0,
    successCount: 1,
    ...extra,
  });
}

function profileKeysOnDisk(): string[] {
  return new m.ToolProfileStore({ seed: false })
    .listAll()
    .map((p) => p.toolName)
    .sort();
}

function rule(tool: string, specifier?: string): PermissionRule {
  return { effect: 'allow', tool, _v: 2, ...(specifier ? { specifier } : {}) };
}

describe('removeMCPServerEverywhere', () => {
  it('removes the config row and every profile the server minted a name for', () => {
    seedConfig('playwright', 'browsermcp');
    const click = m.mcpToolName('playwright', 'browser_click');
    seedProfile(m.mcpProfileKey(click), { category: 'mcp.playwright' });
    seedProfile(`delegate_${m.mcpServerSegment('playwright')}`, {
      category: 'mcp-delegate.playwright',
    });
    // The pre-#413 delegate spelling, under the raw key — on disk on every
    // install that ran before namespacing.
    seedProfile('delegate_playwright');
    // A different server, and a Bernard built-in. Neither may move.
    seedProfile(m.mcpProfileKey(m.mcpToolName('browsermcp', 'browser_click')), {
      category: 'mcp.browsermcp',
    });
    seedProfile('shell.git');

    const result = m.removeMCPServerEverywhere('playwright');

    expect(result.existed).toBe(true);
    expect(configKeys()).toEqual(['browsermcp']);
    expect(result.profilesRemoved.sort()).toEqual(
      [
        m.mcpProfileKey(click),
        `delegate_${m.mcpServerSegment('playwright')}`,
        'delegate_playwright',
      ].sort(),
    );
    expect(profileKeysOnDisk()).toEqual(
      [m.mcpProfileKey(m.mcpToolName('browsermcp', 'browser_click')), 'shell.git'].sort(),
    );
  });

  it('sweeps a server that is already out of the config', () => {
    // The retroactive case, and the reason the sweep is not gated on the row:
    // every install predating this carries debris from servers removed the old
    // way, and a gated sweep could never reach it. `bernard remove-mcp <key>`
    // IS the cleanup command, so it has to work on a key with no row.
    seedConfig('playwright');
    seedProfile(m.mcpProfileKey(m.mcpToolName('browsermcp', 'browser_type')), {
      category: 'mcp.browsermcp',
    });

    const result = m.removeMCPServerEverywhere('browsermcp');

    expect(result.existed).toBe(false);
    expect(result.profilesRemoved).toHaveLength(1);
    expect(profileKeysOnDisk()).toEqual([]);
    expect(configKeys()).toEqual(['playwright']);
  });

  it('attributes a profile by its stored category when the key cannot say', () => {
    // `ensureSeeded` is the only writer of `category`, and the record-methods
    // call `getOrCreate` without one — so a profile can reach disk carrying the
    // link in the field and not in the key. Both are consulted for that reason.
    seedConfig('legacy-server');
    seedProfile('a-hand-written-key', { category: 'mcp.legacy-server' });

    const result = m.removeMCPServerEverywhere('legacy-server');

    expect(result.profilesRemoved).toEqual(['a-hand-written-key']);
  });

  it('leaves a bare unattributable profile alone', () => {
    // The 62-of-144 population (71 namespaced and 11 delegate rows are both
    // attributable and both swept). A bare name carries no server, and two
    // configured servers exported this one, so deleting it is a coin toss with
    // a live server's learned history on the table.
    seedConfig('playwright', 'browsermcp');
    seedProfile('browser_click');
    seedProfile('get_figma_data');

    const result = m.removeMCPServerEverywhere('playwright');

    expect(result.profilesRemoved).toEqual([]);
    expect(profileKeysOnDisk()).toEqual(['browser_click', 'get_figma_data']);
  });
});

describe('legacy ancestors', () => {
  it('takes the pre-#413 ancestor with its only successor', () => {
    // Without this the cascade is WORSE than doing nothing: `list()` hides an
    // ancestor only while something supersedes it, so deleting the successor
    // alone un-hides it — back into `bernard tool-profiles`, and back into the
    // system prompt, where `filterLiveProfiles` waves a bare uncategorised key
    // through because it cannot be told from a built-in.
    seedConfig('playwright');
    const key = m.mcpProfileKey(m.mcpToolName('playwright', 'browser_click'));
    seedProfile('browser_click', { errorCount: 3 });
    seedProfile(key, { category: 'mcp.playwright', supersedes: 'browser_click' });

    const result = m.removeMCPServerEverywhere('playwright');

    expect(result.legacyRemoved).toEqual(['browser_click']);
    expect(result.legacyKept).toEqual([]);
    expect(profileKeysOnDisk()).toEqual([]);
  });

  it('keeps an ancestor a surviving server still claims, and names the claimant', () => {
    // Measured, not hypothetical: four legacy keys on the reference install are
    // each claimed by both `playwright` and `browsermcp`, because both export
    // them. This is `buildMCPAliasIndex`'s tombstone with the inputs swapped —
    // two claimants make the ancestor unremovable rather than unresolvable.
    seedConfig('playwright', 'browsermcp');
    seedProfile('browser_click');
    const pw = m.mcpProfileKey(m.mcpToolName('playwright', 'browser_click'));
    const bm = m.mcpProfileKey(m.mcpToolName('browsermcp', 'browser_click'));
    seedProfile(pw, { category: 'mcp.playwright', supersedes: 'browser_click' });
    seedProfile(bm, { category: 'mcp.browsermcp', supersedes: 'browser_click' });

    const result = m.removeMCPServerEverywhere('playwright');

    expect(result.legacyRemoved).toEqual([]);
    expect(result.legacyKept).toEqual([{ name: 'browser_click', claimedBy: bm }]);
    expect(profileKeysOnDisk()).toEqual([bm, 'browser_click'].sort());
  });

  it('ignores a claim on an ancestor that is not on disk', () => {
    seedConfig('playwright');
    const key = m.mcpProfileKey(m.mcpToolName('playwright', 'browser_click'));
    seedProfile(key, { category: 'mcp.playwright', supersedes: 'browser_click' });

    const result = m.removeMCPServerEverywhere('playwright');

    expect(result.legacyRemoved).toEqual([]);
    expect(result.legacyKept).toEqual([]);
  });
});

describe('permission grants', () => {
  it('drops the user rules for this server and keeps everyone else in order', () => {
    seedConfig('playwright', 'browsermcp');
    const click = m.mcpToolName('playwright', 'browser_click');
    const other = m.mcpToolName('browsermcp', 'browser_click');
    m.saveActiveSettings({
      toolPermissions: [
        rule('shell', 'git *'),
        rule(click, '*'),
        rule(`delegate_${m.mcpServerSegment('playwright')}`),
        rule(other, '*'),
        rule('web_read'),
      ],
    });

    const result = m.removeMCPServerEverywhere('playwright');

    expect(result.rulesRemoved).toEqual([
      { label: `${click} *`, profile: 'default' },
      { label: `delegate_${m.mcpServerSegment('playwright')} (any args)`, profile: 'default' },
    ]);
    const kept = m.getActiveSettings(m.loadProfiles().file).toolPermissions ?? [];
    // Order is what the engine scans, so it must survive a removal intact.
    expect((kept as PermissionRule[]).map((r) => r.tool)).toEqual(['shell', other, 'web_read']);
  });

  it('drops per-app rules too, app by app', () => {
    seedConfig('playwright');
    const click = m.mcpToolName('playwright', 'browser_click');
    m.saveAppGrants('demo', [rule(click, '*'), rule('shell', 'ls')]);
    m.saveAppGrants('other', [rule('web_read')]);

    const result = m.removeMCPServerEverywhere('playwright');

    expect(result.rulesRemoved).toEqual([{ label: `${click} *`, profile: 'default', app: 'demo' }]);
    // The app has to survive into the line, or the report says a per-app grant
    // was one of the user's own.
    expect(m.describeMCPRemoval('playwright', result)).toContain(
      `  App "demo" rule removed: ${click} *`,
    );
    expect(m.loadAppGrants('demo')?.map((r) => r.tool)).toEqual(['shell']);
    expect(m.loadAppGrants('other')?.map((r) => r.tool)).toEqual(['web_read']);
  });

  it('drops the entry outright when an app loses its last rule', () => {
    // `[]` removes the key rather than leaving an empty one for a future app to
    // inherit by id collision — `deleteApplet`'s rule.
    seedConfig('playwright');
    m.saveAppGrants('demo', [rule(m.mcpToolName('playwright', 'browser_click'), '*')]);

    m.removeMCPServerEverywhere('playwright');

    expect(m.loadAppGrants('demo')).toBeNull();
    expect(m.getActiveSettings(m.loadProfiles().file).appToolGrants).toEqual({});
  });

  it('sweeps every profile, because mcp.json is global and grants are not', () => {
    // The asymmetry this crosses profiles for: one `mcp.json` row removed for
    // everyone, grants stored per profile. Swept only in the active one they
    // survive where `/tool-permissions` cannot show them — and re-arm on
    // re-add, since `mcpServerSegment` hashes the server name alone.
    seedConfig('playwright');
    const click = m.mcpToolName('playwright', 'browser_click');
    m.saveActiveSettings({ toolPermissions: [rule(click, '*'), rule('shell', 'ls')] });
    m.createProfile('Work', {
      toolPermissions: [rule(click, '*'), rule('web_read')],
      appToolGrants: { demo: [rule(click), rule('shell', 'ls')] },
    });

    const result = m.removeMCPServerEverywhere('playwright');

    const work = Object.values(m.loadProfiles().file.profiles).find((p) => p.name === 'Work')!;
    expect(work.settings.toolPermissions).toEqual([rule('web_read')]);
    expect(work.settings.appToolGrants).toEqual({ demo: [rule('shell', 'ls')] });
    // Every dropped rule names the profile it came from, so a report of a
    // non-active profile cannot read as one about the active one.
    expect(
      result.rulesRemoved.map((r) => `${r.profile}${r.app ? '/' + r.app : ''}`).sort(),
    ).toEqual(['default', work.id, `${work.id}/demo`].sort());
    // The active profile is still swept, and is still the active one.
    expect(m.getActiveSettings(m.loadProfiles().file).toolPermissions).toEqual([
      rule('shell', 'ls'),
    ]);
  });

  it('names a non-active profile in the report and leaves the active one unqualified', () => {
    seedConfig('playwright');
    const click = m.mcpToolName('playwright', 'browser_click');
    m.saveActiveSettings({ toolPermissions: [rule(click, '*')] });
    const work = m.createProfile('Work', { toolPermissions: [rule(click, '*')] });

    const lines = m.describeMCPRemoval('playwright', m.removeMCPServerEverywhere('playwright'));

    expect(lines).toContain(`  Permission rule removed: ${click} *`);
    expect(lines).toContain(`  Permission rule removed (profile "${work.id}"): ${click} *`);
  });

  it('cannot be resurrected by the next grant the REPL writes', () => {
    // The live bug the sweep had on its own. `config.toolPermissions` is an
    // in-memory array the gates read through a thunk, and `App.tsx`'s writers
    // used to compose the new list from it — so one "always allow" answered
    // after a removal wrote every swept rule back, silently and permanently.
    // The writers now compose from `loadActiveProfileRules`, which is what this
    // replays; `saveAppGrants` never had the bug because it re-reads on every
    // write, and that is the shape copied.
    seedConfig('playwright');
    const click = m.mcpToolName('playwright', 'browser_click');
    m.saveActiveSettings({ toolPermissions: [rule(click, '*'), rule('shell', 'ls')] });

    m.removeMCPServerEverywhere('playwright');

    // `persistPermissionRule`'s append-and-save, verbatim.
    const updated = [...m.loadActiveProfileRules(), rule('web_read')];
    m.saveActiveSettings({ toolPermissions: updated });

    expect(
      (m.getActiveSettings(m.loadProfiles().file).toolPermissions as PermissionRule[]).map(
        (r) => r.tool,
      ),
    ).toEqual(['shell', 'web_read']);
  });

  it('leaves the settings untouched when nothing matched', () => {
    // A no-op sweep must not rewrite `profiles.json`: the write is what would
    // migrate an unrelated hand-edited field through the sanitizer.
    //
    // Non-canonical spacing, for the reason `profiles.test.ts` gives at its own
    // copy: a re-serialize of an unchanged object is byte-identical, so a
    // comparison of a file Bernard wrote cannot see the write at all.
    seedConfig('playwright');
    m.saveActiveSettings({ toolPermissions: [rule('shell', 'git *')] });
    const scruffy = JSON.stringify(
      JSON.parse(fs.readFileSync(m.paths.PROFILES_PATH, 'utf-8')),
      null,
      4,
    );
    fs.writeFileSync(m.paths.PROFILES_PATH, scruffy);

    const result = m.removeMCPServerEverywhere('playwright');

    expect(result.rulesRemoved).toEqual([]);
    expect(fs.readFileSync(m.paths.PROFILES_PATH, 'utf-8')).toBe(scruffy);
  });
});

describe('specialists', () => {
  function seedSpecialist(id: string, targetTools: string[] | undefined): void {
    const store = new m.SpecialistStore({ seed: false });
    store.createFull({
      id,
      name: id,
      description: 'test',
      systemPrompt: 'test',
      kind: 'tool-wrapper',
      ...(targetTools ? { targetTools } : {}),
    });
  }

  it('reports a fully orphaned specialist and changes nothing about it', () => {
    // #377 sketches a confirm-and-delete flow; this deliberately does not
    // build one. A deletion is not recoverable and the CLI path is scripted
    // with nobody watching, so the report IS the behaviour — which is the
    // issue's own recommendation for the headless case, taken everywhere.
    seedConfig('playwright');
    const click = m.mcpToolName('playwright', 'browser_click');
    const type = m.mcpToolName('playwright', 'browser_type');
    seedSpecialist('browser-driver', [click, type]);

    const result = m.removeMCPServerEverywhere('playwright');

    expect(result.specialists).toEqual([
      { id: 'browser-driver', lost: [click, type], orphaned: true, isProtected: false },
    ]);
    // The record is the assertion that matters: a report that quietly edited
    // would pass every check above.
    expect(new m.SpecialistStore({ seed: false }).get('browser-driver')?.targetTools).toEqual([
      click,
      type,
    ]);
  });

  it('reports a partial dependency as degraded, not orphaned', () => {
    seedConfig('playwright');
    const click = m.mcpToolName('playwright', 'browser_click');
    seedSpecialist('mixed', [click, 'shell', 'web_read']);

    const result = m.removeMCPServerEverywhere('playwright');

    expect(result.specialists).toEqual([
      { id: 'mixed', lost: [click], orphaned: false, isProtected: false },
    ]);
  });

  it('marks a bundled specialist protected rather than failing the removal', () => {
    // `assertCanDeleteSpecialist` throws for a bundled record, so a cascade
    // that tried to delete one would fail the whole removal over a record it
    // was never allowed to touch.
    seedConfig('playwright');
    const store = new m.SpecialistStore({ seed: true });
    const bundled = store.list().find((s) => s.id === 'shell-wrapper');
    expect(bundled).toBeDefined();
    fs.writeFileSync(
      path.join(m.paths.SPECIALISTS_DIR, 'shell-wrapper.json'),
      JSON.stringify({ ...bundled, targetTools: [m.mcpToolName('playwright', 'x')] }),
    );

    const result = m.removeMCPServerEverywhere('playwright');

    expect(result.specialists).toEqual([
      {
        id: 'shell-wrapper',
        lost: [m.mcpToolName('playwright', 'x')],
        orphaned: true,
        isProtected: true,
      },
    ]);
  });

  it('does not read an absent or deny-all fence as a dependency', () => {
    // Absent means "everything the surface allows" and `[]` is deny-all (#511).
    // Neither names this server, and reporting them would make every removal
    // shout about every specialist on the install.
    seedConfig('playwright');
    seedSpecialist('wide', undefined);
    seedSpecialist('fenced-shut', []);

    expect(m.removeMCPServerEverywhere('playwright').specialists).toEqual([]);
  });
});

describe('reporting', () => {
  it('says only that the server is gone when nothing was left behind', () => {
    seedConfig('playwright');
    const result = m.removeMCPServerEverywhere('playwright');
    expect(m.sweptNothing(result)).toBe(true);
    expect(m.describeMCPRemoval('playwright', result)).toEqual([
      'MCP server "playwright" removed. Restart Bernard for changes to take effect.',
    ]);
  });

  it('names the kept ancestor with the thing that would remove it', () => {
    seedConfig('playwright', 'browsermcp');
    seedProfile('browser_click');
    const bm = m.mcpProfileKey(m.mcpToolName('browsermcp', 'browser_click'));
    seedProfile(m.mcpProfileKey(m.mcpToolName('playwright', 'browser_click')), {
      supersedes: 'browser_click',
    });
    seedProfile(bm, { supersedes: 'browser_click' });

    const lines = m.describeMCPRemoval('playwright', m.removeMCPServerEverywhere('playwright'));

    expect(lines.join('\n')).toContain(
      `Kept legacy profile "browser_click" — still claimed by ${bm}`,
    );
  });

  it('says a specialist was left alone, so the report cannot read as an edit', () => {
    seedConfig('playwright');
    const click = m.mcpToolName('playwright', 'browser_click');
    new m.SpecialistStore({ seed: false }).createFull({
      id: 'driver',
      name: 'driver',
      description: 'test',
      systemPrompt: 'test',
      kind: 'tool-wrapper',
      targetTools: [click],
    });

    const lines = m.describeMCPRemoval('playwright', m.removeMCPServerEverywhere('playwright'));

    expect(lines.join('\n')).toContain('has no tools left');
    expect(lines.join('\n')).toContain('Nothing was changed');
  });

  it('cannot keep an ancestor without also having removed something', () => {
    // The implication `sweptNothing`'s `legacyKept` term rests on, asserted
    // rather than covered: an ancestor is only ever kept because a doomed
    // profile claimed it, and a doomed profile on disk is always unlinked. The
    // term is insurance against that ceasing to hold, so this is what would
    // notice.
    seedConfig('playwright', 'browsermcp');
    seedProfile('browser_click');
    for (const server of ['playwright', 'browsermcp']) {
      seedProfile(m.mcpProfileKey(m.mcpToolName(server, 'browser_click')), {
        supersedes: 'browser_click',
      });
    }

    const result = m.removeMCPServerEverywhere('playwright');

    expect(result.legacyKept).toHaveLength(1);
    expect(result.profilesRemoved.length).toBeGreaterThan(0);
    expect(m.sweptNothing(result)).toBe(false);
  });

  it('says the row was absent rather than claiming a removal', () => {
    seedConfig('playwright');
    seedProfile('a', { category: 'mcp.gone' });
    const lines = m.describeMCPRemoval('gone', m.removeMCPServerEverywhere('gone'));
    expect(lines[0]).toContain('was not configured');
    expect(lines[0]).not.toContain('not found');
  });

  it('reads an unknown key with nothing behind it as a typo, and names the real ones', () => {
    // The third case, and the reason there are three: "swept what it left
    // behind" is untrue of a name nothing was ever stored under, and the
    // configured keys are what `removeMCPServer`'s throw used to supply. The
    // caller here is frequently a model inventing a name.
    seedConfig('playwright', 'beeper');
    const result = m.removeMCPServerEverywhere('playwrite');
    expect(m.sweptNothing(result)).toBe(true);
    expect(m.describeMCPRemoval('playwrite', result)[0]).toBe(
      'MCP server "playwrite" not found, and nothing on disk belongs to it. Valid keys: playwright, beeper',
    );
  });
});

describe('orphanedMCPServers', () => {
  it('names servers that own profiles but have no config row', () => {
    // The standing report behind `bernard tool-profiles`. The key carries only
    // a hash of the server name, so the stored category is the one place a
    // removed server's name survives in a form worth printing.
    seedConfig('playwright');
    seedProfile('a', { category: 'mcp.browsermcp' });
    // `figma` is reachable ONLY through its delegate category. With delegation
    // on, the delegate profile is the one that accumulates calls while the
    // per-tool ones may never be written, so this is the likelier shape — and
    // it is the one a reader skims past when both branches are exercised by
    // the same server.
    seedProfile('b', { category: 'mcp-delegate.figma' });
    seedProfile('c', { category: 'mcp.playwright' });
    seedProfile('d', { category: 'mcp-delegate.playwright' });
    seedProfile('e', { category: 'git' });
    seedProfile('f');

    const store = new m.ToolProfileStore({ seed: false });
    expect(m.orphanedMCPServers(store.listAll())).toEqual(['browsermcp', 'figma']);
  });

  it('is silent when every server is still configured', () => {
    seedConfig('playwright');
    seedProfile('a', { category: 'mcp.playwright' });
    expect(m.orphanedMCPServers(new m.ToolProfileStore({ seed: false }).listAll())).toEqual([]);
  });
});
