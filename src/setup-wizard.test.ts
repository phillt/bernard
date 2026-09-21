import { describe, it, expect } from 'vitest';
import {
  PROVIDERS_DONE,
  SETUP_MODE_ROWS,
  buildDefaultProviderSpec,
  buildKeyEntrySpec,
  buildModeSpec,
  buildProviderHubSpec,
  buildWelcomeSpec,
  providerFromHubRow,
  buildSettingsSpec,
  provenanceNote,
  settingsPatch,
  type SetupContext,
} from './setup-wizard.js';
import { nextLabelFor } from './ui/overlays/wizard-types.js';
import { WIZARD_FIELDS } from './profiles-wizard-data.js';
import { TOOL_MODES, UNRESTRICTED } from './tool-modes.js';
import { THEMES } from './theme.js';
import type { ProfileSettings } from './profiles.js';

/**
 * A fully-populated context, the way the real flow builds one: every field has
 * an effective value, because a step that opens on nothing puts its cursor on
 * row one and the reader's Enter then reads as a choice.
 */
function ctx(over: Partial<SetupContext> = {}): SetupContext {
  const current: Record<string, unknown> = {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    activeLineupId: 'anthropic',
    coordinatorMode: 'auto',
    remoteMessages: 'ask',
    modelMode: 'balanced',
    subagentPac: true,
    promptRewriter: true,
    recallFilter: true,
    memoryConsolidation: true,
    specialistRecall: true,
    scratchSubjectThreshold: 0.3,
    toolMode: 'read-only',
    skipPermissions: false,
    confirmMode: 'auto',
    conciseMode: false,
    responseStyle: 'default',
    toolDetails: false,
    theme: 'bernard',
    voiceTts: false,
    voiceNormalizer: true,
    voiceBackend: 'auto',
    voiceRate: 175,
    voiceWarmupMs: 400,
    autoCreateSpecialists: false,
    autoCreateApplets: false,
    autoOpenApplets: true,
    autoStyleApplets: true,
    autoReviewApplets: true,
    appletPlanning: true,
    autoCreateThreshold: 0.8,
    autoUpdate: false,
    maxConcurrentAgents: 4,
    maxSteps: 25,
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
  };
  return {
    current: current as Partial<ProfileSettings>,
    explicit: new Set(),
    providers: [
      { name: 'anthropic', hasKey: true, custom: false },
      { name: 'openai', hasKey: false, custom: false },
      { name: 'ollama', hasKey: true, custom: true },
    ],
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    lineups: [
      { id: 'anthropic', name: 'Anthropic' },
      { id: 'xai', name: 'xAI' },
    ],
    env: {},
    ...over,
  };
}

/** Accepting every question: the answer each step opened with. */
function acceptAll(steps: { initial: string | string[] }[]): Array<string | string[]> {
  return steps.map((s) => s.initial);
}

describe('buildSettingsSpec', () => {
  it('asks about every declared field except the ones stage A settles', () => {
    const { spec } = buildSettingsSpec(ctx(), 'expert');
    const asked = spec.steps.map((s) => s.id);
    const expected = WIZARD_FIELDS.map((f) => f.key).filter((k) => k !== 'provider');
    expect(asked).toEqual(expected);
  });

  it('opens every step on a real value', () => {
    // The guard for a class rather than an instance: a field the flow forgot to
    // populate opens a choice step on no row, the cursor falls to row one, and
    // an accepting Enter silently writes a value the user never chose. That is
    // invisible in a walkthrough and permanent on disk.
    const { spec } = buildSettingsSpec(ctx(), 'expert');
    const blank = spec.steps.filter((s) => s.initial === '' || s.initial === undefined);
    // NO exceptions. There was one — `voiceVoice`, blank because blank was its
    // real value — and it left this assertion carrying a carve-out that had to
    // be read before it could be trusted. Dropping that question from the walk
    // (it could not be answered from the screen) leaves the rule flat.
    expect(blank.map((s) => s.id)).toEqual([]);
  });

  it('drops a list with nothing to choose from rather than asking an empty question', () => {
    const { spec } = buildSettingsSpec(ctx({ models: [], lineups: [] }), 'expert');
    expect(spec.steps.map((s) => s.id)).not.toContain('model');
    expect(spec.steps.map((s) => s.id)).not.toContain('activeLineupId');
  });

  it('carries the group title as its own field, so a flat walk still reads as sections', () => {
    const { spec } = buildSettingsSpec(ctx(), 'expert');
    const step = spec.steps.find((s) => s.id === 'toolMode');
    expect(step?.section).toBe('Tool safety');
    // Not baked into the question — the renderer styles the two differently, and
    // a delimiter prefix would break on any question containing an em dash.
    expect(step?.question).toBe('Tool mode');
  });
});

describe('the quick tier', () => {
  /** The section names a spec's own steps declare, in walk order. */
  function sectionsOf(spec: { steps: { section?: string }[] }): string[] {
    const seen: string[] = [];
    for (const step of spec.steps) {
      if (step.section !== undefined && !seen.includes(step.section)) seen.push(step.section);
    }
    return seen;
  }

  it('asks only the fields that declare it', () => {
    const { spec } = buildSettingsSpec(ctx(), 'quick');
    expect(spec.steps.map((s) => s.id)).toEqual(
      WIZARD_FIELDS.filter((f) => f.tier === 'quick').map((f) => f.key),
    );
  });

  it('is a subset of what the expert walk asks, never a different set', () => {
    // The acceptance item: expert-only is fine, unreachable-from-either is the
    // regression. Asserted as containment rather than by counting, because a
    // count passes while the two sets drift apart.
    const quick = buildSettingsSpec(ctx(), 'quick').spec.steps.map((s) => s.id);
    const expert = buildSettingsSpec(ctx(), 'expert').spec.steps.map((s) => s.id);
    for (const id of quick) expect(expert, id).toContain(id);
    expect(quick.length).toBeLessThan(expert.length);
  });

  it('builds the rail from the FILTERED list, not from the whole registry', () => {
    // The failure this catches is a rail that promises sections the walk never
    // reaches — "Memory & context" listed as still to come on a walk that asks
    // nothing in it. The hub is where it shows, because the settings spec's own
    // rail is derived from its own steps and is filtered for free.
    const quickAfter = buildProviderHubSpec(ctx(), 'quick').railContext?.after ?? [];
    const expertAfter = buildProviderHubSpec(ctx(), 'expert').railContext?.after ?? [];
    expect(quickAfter).toEqual(sectionsOf(buildSettingsSpec(ctx(), 'quick').spec));
    expect(expertAfter).toEqual(sectionsOf(buildSettingsSpec(ctx(), 'expert').spec));
    expect(quickAfter.length).toBeLessThan(expertAfter.length);
    for (const name of quickAfter) expect(expertAfter, name).toContain(name);
  });

  it('says on the screen that the rest kept their defaults', () => {
    // A path whose edge the reader cannot see is a dead end. The expert walk
    // has nothing to disclose and must not carry the sentence.
    expect(buildSettingsSpec(ctx(), 'quick').spec.intro).toContain('--expert');
    expect(buildSettingsSpec(ctx(), 'expert').spec.intro).not.toContain('--expert');
  });
});

describe('the mode screen', () => {
  it('counts the questions each row actually costs, rather than saying a number', () => {
    // A hand-typed "3 questions" is a second copy of the registry, and the copy
    // that goes stale is the one on the screen.
    const c = ctx();
    const { spec } = buildModeSpec(c);
    const field = spec.steps[0].field;
    expect(field.kind).toBe('choice');
    if (field.kind !== 'choice') return;
    const quick = buildSettingsSpec(c, 'quick').spec.steps.length;
    const expert = buildSettingsSpec(c, 'expert').spec.steps.length;
    expect(field.trailing?.[SETUP_MODE_ROWS.quick]).toEqual({ text: `${quick} questions` });
    expect(field.trailing?.[SETUP_MODE_ROWS.expert]).toEqual({ text: `${expert} questions` });
    // Guard the guard: identical counts would satisfy the two assertions above
    // while saying nothing about the choice.
    expect(quick).toBeLessThan(expert);
  });

  it('follows the catalog rather than a fixed number', () => {
    // The full row's count moves with what can be asked — a list with nothing
    // to choose from is dropped, so a machine whose catalog could not be read
    // is honestly offered a shorter walk.
    const field = buildModeSpec(ctx({ models: [], lineups: [] })).spec.steps[0].field;
    if (field.kind !== 'choice') return;
    const full = buildSettingsSpec(ctx({ models: [], lineups: [] }), 'expert').spec.steps.length;
    expect(field.trailing?.[SETUP_MODE_ROWS.expert]).toEqual({ text: `${full} questions` });
  });

  it('opens on quick, which is what makes a first run short', () => {
    expect(buildModeSpec(ctx()).spec.steps[0].initial).toBe(SETUP_MODE_ROWS.quick);
    // …and re-opens on whatever was in force, so Back does not silently change
    // the answer the reader already gave.
    expect(buildModeSpec(ctx(), 'expert').spec.steps[0].initial).toBe(SETUP_MODE_ROWS.expert);
  });

  it('decodes a row back to its tier, and treats anything else as quick', () => {
    const { decode } = buildModeSpec(ctx());
    expect(decode([SETUP_MODE_ROWS.quick])).toBe('quick');
    expect(decode([SETUP_MODE_ROWS.expert])).toBe('expert');
    // An answer matching no row means the reader never decided; the short walk
    // is the one it is safe to fall back to, since nothing it skips is written.
    expect(decode(['something else'])).toBe('quick');
  });

  it('shares the welcome’s rail row rather than adding one of its own', () => {
    // A single hinge screen with a row to itself makes the journey read as a
    // step longer than it is.
    expect(buildModeSpec(ctx()).spec.steps[0].section).toBe('Welcome');
    expect(buildWelcomeSpec().steps[0].section).toBe('Welcome');
  });

  it('names every section setup can cover, since nothing has been chosen yet', () => {
    // Before the answer there is no tier, so the honest thing to show is the
    // superset — and the rail shortening straight afterwards is the clearest
    // confirmation of what was just picked.
    const after = buildModeSpec(ctx()).spec.railContext?.after ?? [];
    expect(after).toEqual(buildWelcomeSpec().railContext?.after);
    expect(after).toContain('Providers');
    expect(after).toContain('Memory & context');
  });
});

describe('settingsPatch — only what changed is written', () => {
  it('writes nothing when every answer is the one it opened with', () => {
    // The env-shadowing guard. `loadConfig` resolves `prefs ?? env ?? default`,
    // so writing back a value nobody touched would freeze whatever a BERNARD_*
    // variable happened to hold and leave the variable dead forever.
    const { spec, steps } = buildSettingsSpec(ctx(), 'expert');
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    expect(settingsPatch(steps, answers)).toEqual({});
  });

  it('writes exactly the fields that moved', () => {
    const { spec, steps } = buildSettingsSpec(ctx(), 'expert');
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    const themeAt = spec.steps.findIndex((s) => s.id === 'theme');
    const stepsAt = spec.steps.findIndex((s) => s.id === 'maxSteps');
    answers[themeAt] = 'ocean';
    answers[stepsAt] = '40';
    expect(settingsPatch(steps, answers)).toEqual({ theme: 'ocean', maxSteps: 40 });
  });

  it('decodes a boolean row, not the label', () => {
    const { spec, steps } = buildSettingsSpec(ctx(), 'expert');
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    const at = spec.steps.findIndex((s) => s.id === 'conciseMode');
    expect(spec.steps[at].initial).toBe('Off');
    answers[at] = 'On';
    expect(settingsPatch(steps, answers)).toEqual({ conciseMode: true });
  });

  it('decodes a list row back to its value, not its label', () => {
    const { spec, steps } = buildSettingsSpec(ctx(), 'expert');
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    const at = spec.steps.findIndex((s) => s.id === 'coordinatorMode');
    // The label a reader picks and the value written to disk are deliberately
    // different strings — `Always on` is the row, `on` is the setting.
    answers[at] = 'Always on';
    expect(settingsPatch(steps, answers)).toEqual({ coordinatorMode: 'on' });
  });

  it('ignores an answer that matches no row', () => {
    const { spec, steps } = buildSettingsSpec(ctx(), 'expert');
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    answers[spec.steps.findIndex((s) => s.id === 'theme')] = 'not-a-theme';
    expect(settingsPatch(steps, answers)).toEqual({});
  });

  it('rejects a bad number rather than writing NaN', () => {
    const { spec, steps } = buildSettingsSpec(ctx(), 'expert');
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    answers[spec.steps.findIndex((s) => s.id === 'maxSteps')] = 'abc';
    expect(settingsPatch(steps, answers)).toEqual({});
  });
});

describe('tool mode folds skipPermissions in', () => {
  // Read off the shared table rather than written out here. These cases pinned
  // the LABELS — 'Read-only', '⚠ Unrestricted' — and so broke when the rows were
  // reworded, which is a test asserting the copy while claiming to assert the
  // decode. What is being checked is that a row maps onto two settings keys;
  // which words are on the row is `tool-modes.test.ts`'s business.
  const rowFor = (value: string) => TOOL_MODES.find((m) => m.value === value)!.label;

  function toolModeStep(c: SetupContext) {
    const { spec, steps } = buildSettingsSpec(c, 'expert');
    const at = spec.steps.findIndex((s) => s.id === 'toolMode');
    return { step: spec.steps[at], steps, at, spec };
  }

  it('opens on "unrestricted" when skipPermissions is on', () => {
    const c = ctx();
    (c.current as Record<string, unknown>).skipPermissions = true;
    expect(toolModeStep(c).step.initial).toBe(rowFor(UNRESTRICTED));
  });

  it('sets all three keys when unrestricted is chosen', () => {
    const { spec, steps, at } = toolModeStep(ctx());
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    answers[at] = rowFor(UNRESTRICTED);
    expect(settingsPatch(steps, answers)).toEqual({
      toolMode: 'write',
      skipPermissions: true,
      // NOT `off`, though that is what this row means. The level is inert while
      // `skipPermissions` is set, and `/tool-permissions` re-arms the
      // safeguards by writing that one key — so `off` here would hand someone
      // who turned them back on a session that still never asks.
      confirmMode: 'auto',
    });
  });

  it('clears skipPermissions when moving back off unrestricted', () => {
    // Writing only the key that changed would leave `skipPermissions: true`
    // standing under `toolMode: 'write'` — a mode that is set and not in force.
    const c = ctx();
    (c.current as Record<string, unknown>).skipPermissions = true;
    const { spec, steps, at } = toolModeStep(c);
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    answers[at] = rowFor('read-only');
    expect(settingsPatch(steps, answers)).toEqual({
      toolMode: 'read-only',
      skipPermissions: false,
      confirmMode: 'auto',
    });
  });

  it('opens on nothing when the stored settings match no row', () => {
    // `write` with the confirm level off is never-asking WITHOUT removing the
    // deny rules and write scopes — reachable from `/agent-options` and from
    // `BERNARD_CONFIRM_MODE`, and a state no row can honestly wear. A step that
    // ticked its nearest neighbour would make a bare Enter an escalation, so
    // the wizard's "never invents the answer it opens on" rule applies.
    const c = ctx();
    (c.current as Record<string, unknown>).toolMode = 'write';
    (c.current as Record<string, unknown>).confirmMode = 'off';
    expect(toolModeStep(c).step.initial).toBe('');
  });

  it('leaves a stored confirm level alone when the row is not changed', () => {
    // NOTE the mechanism, which changed: this used to pass because `strict`
    // preselected a row and accepting it emitted nothing. It now passes
    // because no row is preselected at all, so the answer is `''` and matches
    // none. Same outcome, different reason — the case below is what pins the
    // reason, since this one would keep passing if the preselection came back.
    const c = ctx();
    (c.current as Record<string, unknown>).toolMode = 'write';
    (c.current as Record<string, unknown>).confirmMode = 'strict';
    const { spec, steps } = toolModeStep(c);
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    expect(settingsPatch(steps, answers)).not.toHaveProperty('confirmMode');
  });

  it.each([
    ['write', 'strict'],
    ['write', 'off'],
    ['read-only', 'strict'],
    ['read-only', 'off'],
  ])('opens UNTICKED for %s + %s, which no row represents', (toolMode, confirmMode) => {
    // The state the step opens on, not just what it emits. Every one of these
    // is a posture a user can reach from `/agent-options`, and a row ticked
    // here would make a bare Enter a silent settings change — writes lost one
    // way, the confirm level the other. `confirmMode` is armed under BOTH
    // modes: `runBlockGate` and `runGate` are independent, and `runGate` never
    // reads `toolMode`.
    const c = ctx();
    (c.current as Record<string, unknown>).toolMode = toolMode;
    (c.current as Record<string, unknown>).confirmMode = confirmMode;
    (c.current as Record<string, unknown>).skipPermissions = false;
    expect(toolModeStep(c).step.initial).toBe('');
  });

  it('still opens ON the row for every state that has one', () => {
    // Guard the guard: the four cases above pass trivially if the step opened
    // unticked for everything.
    for (const [toolMode, skipPermissions] of [
      ['read-only', false],
      ['write', false],
      ['write', true],
    ] as const) {
      const c = ctx();
      (c.current as Record<string, unknown>).toolMode = toolMode;
      (c.current as Record<string, unknown>).confirmMode = 'auto';
      (c.current as Record<string, unknown>).skipPermissions = skipPermissions;
      expect(toolModeStep(c).step.initial, `${toolMode}/${skipPermissions}`).not.toBe('');
    }
  });
});

describe('every list step carries its values', () => {
  it('emits one value per choice, in the same order', () => {
    // The renderer sees only labels by design — the caller owns the mapping —
    // so `values` is how a step that previews a row the cursor is merely
    // passing over can act on it (#447). The ALIGNMENT is the whole contract,
    // and index-aligned arrays are the kind of thing that drifts silently.
    const { spec } = buildSettingsSpec(ctx(), 'expert');
    const lists = spec.steps.filter((s) => s.field.kind === 'choice');
    expect(lists.length).toBeGreaterThan(5);
    for (const step of lists) {
      const field = step.field as { choices: string[]; values?: readonly string[] };
      // Boolean and hatch-bearing steps build their rows elsewhere; what must
      // never happen is a `values` that exists and disagrees.
      if (field.values === undefined) continue;
      expect(field.values, step.id).toHaveLength(field.choices.length);
    }
  });

  it('gives the theme step values that are theme ids', () => {
    // The step that previews. Asserted against `THEMES` rather than against the
    // labels, because for this one field they are identical — which is exactly
    // the coincidence the renderer must not lean on.
    const { spec } = buildSettingsSpec(ctx(), 'expert');
    const step = spec.steps.find((s) => s.id === 'theme')!;
    expect(step.preview).toBe('theme');
    const field = step.field as { values?: readonly string[] };
    expect([...(field.values ?? [])]).toEqual(Object.keys(THEMES));
  });
});

describe('the recommendation rides on the row it recommends', () => {
  /** The choice step this field builds, whatever else the settings spec holds. */
  function stepFor(key: string, c = ctx()) {
    const { spec } = buildSettingsSpec(c, 'expert');
    const step = spec.steps.find((s) => s.id === key)!;
    expect(step, key).toBeDefined();
    return step;
  }

  it('marks the row whose value is in force by default', () => {
    const step = stepFor('coordinatorMode');
    expect(step.field.kind).toBe('choice');
    if (step.field.kind !== 'choice') return;
    // Keyed by LABEL and carried in `trailing`, never spliced into the label
    // itself: the label is the answer vocabulary, and a decoder that had to
    // strip the decoration back off would be a second copy of the formatting.
    expect(step.field.trailing).toEqual({ Auto: { text: '(recommended)' } });
    expect(step.field.choices).toContain('Auto');
  });

  it('marks a boolean row too', () => {
    const step = stepFor('promptRewriter');
    if (step.field.kind !== 'choice') return;
    expect(step.field.trailing).toEqual({ On: { text: '(recommended)' } });
  });

  it('says nothing once the reader has chosen for themselves', () => {
    // The defaults live as module-private constants with no key-to-value table,
    // so the recommendation is derivable exactly while it is still in force.
    // Claiming one against a stored answer would be inventing it.
    const step = stepFor('coordinatorMode', ctx({ explicit: new Set(['coordinatorMode']) }));
    if (step.field.kind !== 'choice') return;
    expect(step.field.trailing).toBeUndefined();
  });

  it('says nothing when an environment variable is deciding', () => {
    const step = stepFor('coordinatorMode', ctx({ env: { BERNARD_COORDINATOR_MODE: 'auto' } }));
    if (step.field.kind !== 'choice') return;
    expect(step.field.trailing).toBeUndefined();
  });

  it('counts a covered key as the reader having answered', () => {
    // Tool mode decides `skipPermissions` too, so a profile storing only that
    // key has still answered this question — reading the field's own key alone
    // would call the `unrestricted` row a recommendation.
    const c = ctx({ explicit: new Set(['skipPermissions']) });
    (c.current as Record<string, unknown>).skipPermissions = true;
    const step = stepFor('toolMode', c);
    if (step.field.kind !== 'choice') return;
    expect(step.field.trailing).toBeUndefined();
  });
});

describe('provenanceNote', () => {
  const field = WIZARD_FIELDS.find((f) => f.key === 'modelMode')!;

  it('names the environment variable a value is coming from', () => {
    // The only way a reader can see, while looking at the question, that
    // answering it differently takes a variable out of play for good.
    const note = provenanceNote(field, ctx({ env: { BERNARD_MODEL_MODE: 'balanced' } }));
    expect(note).toContain('BERNARD_MODEL_MODE');
  });

  it('says a value is the profile’s when the profile sets it', () => {
    const note = provenanceNote(
      field,
      ctx({ explicit: new Set(['modelMode']), env: { BERNARD_MODEL_MODE: 'balanced' } }),
    );
    expect(note).toContain('Saved in this profile');
    expect(note).not.toContain('BERNARD_MODEL_MODE');
  });

  it('says nothing about an untouched value on a page that has rows', () => {
    // The recommendation moved onto the row it recommends. A sentence under the
    // list saying one of the options is the good one leaves the reader to work
    // out which — and `modelMode` is a list, so its note is now empty.
    expect(provenanceNote(field, ctx())).toBe('');
  });

  it('keeps the sentence where there is no row to carry it', () => {
    // A numeric step opens with a buffer, not a list, so the only place left to
    // say it is the line above.
    const numeric = WIZARD_FIELDS.find((f) => f.field.kind === 'int')!;
    expect(provenanceNote(numeric, ctx())).toBe('Recommended.');
  });

  it('never repeats the value, which the rows already show', () => {
    // The rows carry a `✓` on the one in force and a text step opens with it in
    // the buffer, so naming it again put the same fact on screen twice — and a
    // sentence that has to point at what is already there is a sign the screen
    // was not obvious enough, not a fix for it.
    for (const c of [
      ctx(),
      ctx({ explicit: new Set(['modelMode']) }),
      ctx({ env: { BERNARD_MODEL_MODE: 'balanced' } }),
    ]) {
      const note = provenanceNote(field, c);
      expect(note).not.toContain('Currently');
      expect(note).not.toContain('balanced');
    }
  });

  it('still says where a value came from when it did not come from us', () => {
    // Guard the guard: dropping the value must not take the provenance with it.
    // A stored answer and an inherited variable are both things the reader may
    // want to go and change somewhere else.
    expect(provenanceNote(field, ctx({ explicit: new Set(['modelMode']) }))).toContain(
      'Saved in this profile',
    );
    expect(provenanceNote(field, ctx({ env: { BERNARD_MODEL_MODE: 'balanced' } }))).toContain(
      'BERNARD_MODEL_MODE',
    );
  });

  it('says a value is absent, which no row can show', () => {
    // The one fact the rows cannot carry: a blank buffer looks the same whether
    // the value is empty or never set.
    //
    // Driven through a context that OMITS the field, and the field is arbitrary
    // — which is the honest shape now. This used to lean on `voiceVoice` being
    // genuinely unset, and lost its subject when that question left the walk;
    // with the voice details gone too, every field the registry still asks
    // about resolves to a value, so this branch is defensive rather than
    // routine. A test that needs a particular field to stay empty is one
    // waiting to be broken by someone populating it.
    const field = WIZARD_FIELDS.find((f) => f.key === 'maxSteps')!;
    const without = ctx();
    delete (without.current as Record<string, unknown>).maxSteps;
    expect(provenanceNote(field, without)).toBe('Not set.');
  });
});

describe('the provider hub', () => {
  it('is one list, not a page per provider', () => {
    // A page each asked about three providers in a row when almost everyone
    // wants one, gave no view of the set, and made "which am I actually using"
    // a thing you had to remember across screens. Here the state is the screen.
    const spec = buildProviderHubSpec(ctx(), 'expert');
    expect(spec.steps).toHaveLength(1);
    const field = spec.steps[0].field;
    expect(field.kind).toBe('choice');
    if (field.kind !== 'choice') return;
    expect(field.choices).toHaveLength(3);
    expect(field.actions).toEqual([PROVIDERS_DONE]);
  });

  it('says which key is in place, not merely that one is', () => {
    // A tick cannot tell you WHICH key is there, which is the question after a
    // rotation or with several accounts. The SUFFIX, because provider keys
    // share a scheme-and-project prefix.
    const c: SetupContext = {
      ...ctx(),
      providers: [
        { name: 'anthropic', hasKey: true, custom: false, keyHint: 'ter2' },
        { name: 'openai', hasKey: false, custom: false },
      ],
    };
    const field = buildProviderHubSpec(c, 'expert').steps[0].field;
    if (field.kind !== 'choice') return;
    // The LABEL is the provider and nothing else — it is the answer vocabulary,
    // and a decoder that had to strip a decorated suffix would be a second copy
    // of formatting that changes with the terminal width.
    expect(field.choices).toEqual(['anthropic', 'openai']);
    // Asterisks rather than middle dots: the leader dots that right-align the
    // cell are `·`, so a `·`-masked key ran straight out of the alignment.
    expect(field.trailing?.['anthropic']).toEqual({ text: '****ter2', tick: true });
    expect(field.trailing?.['anthropic']?.text).not.toContain('·');
    expect(field.trailing?.['openai']).toEqual({ text: 'no key' });
  });

  it('never ends the walk from a row that names a provider', () => {
    const c = ctx();
    const field = buildProviderHubSpec(c, 'expert').steps[0].field;
    if (field.kind !== 'choice') return;
    for (const row of field.choices) expect(providerFromHubRow(c, row)).not.toBeNull();
    expect(providerFromHubRow(c, PROVIDERS_DONE)).toBeNull();
  });

  it('matches a row back to its provider by prefix, not by rebuilding the label', () => {
    // The tick and the key hint are display. A decoder that re-derived the whole
    // decorated row would be a second copy of the formatting to keep in step.
    const c = ctx();
    expect(providerFromHubRow(c, 'ollama  (custom)  ✓ key set ****abcd')).toBe('ollama');
  });

  it('resolves on the pick, with no check-your-answers screen', () => {
    // The review is for a BATCH of answers. A hub whose rows are things to do
    // has none, and a summary reading "Providers — anthropic" is unactionable.
    expect(buildProviderHubSpec(ctx(), 'expert').skipReview).toBe(true);
    expect(buildWelcomeSpec().skipReview).toBe(true);
    expect(buildKeyEntrySpec(ctx(), 'anthropic', 'expert').spec.skipReview).toBe(true);
  });
});

describe('the key entry page', () => {
  it('words itself for what is typed, and never as a second "back"', () => {
    // The page already draws `← Back`. This button read "Back to providers",
    // so it drew two controls a reader could only tell apart by trying one.
    const label = (provider: string, typed: string): string =>
      nextLabelFor(buildKeyEntrySpec(ctx(), provider, 'expert').spec.steps[0], typed, 'fallback');
    for (const provider of ['anthropic', 'openai']) {
      expect(label(provider, 'sk-typed')).toBe('Save key');
      expect(label(provider, '')).not.toMatch(/back/i);
    }
    // Empty means different things depending on whether a key is already there.
    expect(label('anthropic', '')).toBe('Keep the stored key');
    expect(label('openai', '')).toBe('Skip for now');
  });

  it('treats blank as "leave this provider alone", which Esc also does', () => {
    // So the page can never be a dead end.
    for (const provider of ['anthropic', 'openai']) {
      expect(buildKeyEntrySpec(ctx(), provider, 'expert').spec.steps[0].optional).toBe(true);
    }
  });

  it('trims what it returns, and returns nothing for a blank', () => {
    const { decode } = buildKeyEntrySpec(ctx(), 'anthropic', 'expert');
    expect(decode(['  sk-test  '])).toBe('sk-test');
    expect(decode(['   '])).toBe('');
  });
});

/** `ctx`'s `...over` replaces `current` wholesale, so this merges instead. */
function withModel(models: string[], model: string): SetupContext {
  const c = ctx({ models });
  return { ...c, current: { ...c.current, model } };
}

describe('the model step and a catalog that does not list what is in use', () => {
  it('offers the model in force back, rather than opening on no row', () => {
    // CLAUDE.md records both directions: `grok-3-mini` dispatches and is in no
    // snapshot. Dropped, the step opens on nothing and a reader who takes the
    // page at face value trades a working model for the catalog's first entry.
    const { spec } = buildSettingsSpec(
      withModel(['listed-a', 'listed-b'], 'unlisted-but-working'),
      'expert',
    );
    const step = spec.steps.find((s) => s.id === 'model')!;
    const choices = (step.field as { choices: string[] }).choices;
    expect(choices[0]).toContain('unlisted-but-working');
    expect(step.initial).toBe(choices[0]);
  });

  it('adds nothing when the catalog already lists it', () => {
    // Guard the guard: an unconditional row would duplicate the model on every
    // ordinary install.
    const { spec } = buildSettingsSpec(withModel(['m1', 'm2'], 'm1'), 'expert');
    const choices = (spec.steps.find((s) => s.id === 'model')!.field as { choices: string[] })
      .choices;
    expect(choices).toEqual(['m1', 'm2']);
  });

  it('asks nothing at all when the catalog could not be read', () => {
    // An empty list is "we do not know", not "here is your one option" — a
    // one-row page is a screen that costs a keystroke and decides nothing.
    const { spec } = buildSettingsSpec(withModel([], 'whatever'), 'expert');
    expect(spec.steps.find((s) => s.id === 'model')).toBeUndefined();
  });
});

describe('a question that another answer can make inert', () => {
  it("carries the unrestricted row's consequence onto the screen", () => {
    // `toolModePolicy` short-circuits on `skipPermissions` before every other
    // rule, so picking unrestricted makes the confirm-mode answer dead — and
    // the two are asked on separate screens with nothing else connecting them.
    // The warning existed in the registry and rendered nowhere.
    const { spec } = buildSettingsSpec(ctx(), 'expert');
    const step = spec.steps.find((s) => s.id === 'toolMode')!;
    const field = step.field as { choices: string[]; notes?: Record<string, string> };
    const unrestricted = TOOL_MODES.find((m) => m.value === UNRESTRICTED)!.label;
    // The CLAIM, not the sentence: the note has to say that confirming stops
    // happening, and the wording has since been shortened to fit the one row
    // the wizard reserves for it.
    expect(field.notes?.[unrestricted]).toMatch(/confirmed/i);
  });

  it('no longer asks the question the warning was needed for', () => {
    // That warning existed because `confirmMode` was a separate step: it could
    // be answered into a state the previous screen had already made inert. The
    // merge (#447) removes the step, so the note on the unrestricted row above
    // is the whole of what is left to say.
    const { spec } = buildSettingsSpec(ctx(), 'expert');
    expect(spec.steps.find((s) => s.id === 'confirmMode')).toBeUndefined();
  });

  it('adds no notes to a step whose options declare none', () => {
    // Guard the guard: an always-present `notes` map would satisfy the first
    // case while telling the renderer every row has something to say.
    const { spec } = buildSettingsSpec(ctx(), 'expert');
    const step = spec.steps.find((s) => s.id === 'theme')!;
    expect((step.field as { notes?: unknown }).notes).toBeUndefined();
  });
});

describe('buildDefaultProviderSpec', () => {
  /** Two keyed providers, so the question is worth asking. */
  function twoKeyed(): SetupContext {
    const c = ctx();
    return {
      ...c,
      providers: [
        { name: 'anthropic', hasKey: true, custom: false },
        { name: 'openai', hasKey: true, custom: false },
        { name: 'xai', hasKey: false, custom: false },
      ],
    };
  }

  it('is skipped when the answer is forced', () => {
    // One keyed provider and the choice is not a choice; a screen whose answer
    // is forced costs a keystroke and teaches nothing.
    const oneKeyed: SetupContext = {
      ...ctx(),
      providers: [
        { name: 'anthropic', hasKey: true, custom: false },
        { name: 'openai', hasKey: false, custom: false },
      ],
    };
    expect(buildDefaultProviderSpec(oneKeyed, 'expert')).toBeNull();
    expect(buildDefaultProviderSpec(twoKeyed(), 'expert')).not.toBeNull();
  });

  it('greys a keyless provider and says why, rather than hiding it', () => {
    // Hidden, the row answers no question: a provider missing from the list
    // looks unsupported, where a greyed one with a reason says what to do.
    const stage = buildDefaultProviderSpec(twoKeyed(), 'expert')!;
    const field = stage.spec.steps[0].field;
    expect(field.kind).toBe('choice');
    if (field.kind !== 'choice') return;
    expect(field.choices).toHaveLength(3);
    expect(field.unavailable?.['xai']).toContain('no key');
    expect(field.unavailable?.['anthropic']).toBeUndefined();
  });

  it('carries no key-status badge on the row itself', () => {
    // The badge read as a selection: `✓` already means "this is the one", and
    // the cursor marker means "this is where you are". Status is the greying.
    const stage = buildDefaultProviderSpec(twoKeyed(), 'expert')!;
    const field = stage.spec.steps[0].field;
    if (field.kind !== 'choice') return;
    for (const row of field.choices) expect(row).not.toContain('key set');
  });

  it('opens on the provider already in use', () => {
    expect(buildDefaultProviderSpec(twoKeyed(), 'expert')!.spec.steps[0].initial).toBe('anthropic');
  });

  it('decodes a row back to the bare provider name', () => {
    const stage = buildDefaultProviderSpec(twoKeyed(), 'expert')!;
    expect(stage.decode(['openai'])).toBe('openai');
  });

  it('commits on Continue rather than ending at a one-answer review', () => {
    // A review over one answer is the page you just left, restated without the
    // blurbs and greyed rows that made the choice legible — a keystroke to
    // confirm something nobody had stopped seeing. The flow cannot see this:
    // `runSetupFlow` hands out a spec and takes a `WizardResult` back, so the
    // review is entirely a renderer concern and every flow test passes either
    // way.
    expect(buildDefaultProviderSpec(twoKeyed(), 'expert')!.spec.skipReview).toBe(true);
  });

  it('does not skip the review on the stage that has a batch to check', () => {
    // Guard the guard: skipping everywhere would satisfy the assertion above
    // while removing the check-your-answers screen a long walk exists for.
    expect(buildSettingsSpec(ctx(), 'expert').spec.skipReview).not.toBe(true);
  });
});
