import { describe, it, expect } from 'vitest';
import {
  PROVIDERS_DONE,
  buildDefaultProviderSpec,
  buildKeyEntrySpec,
  buildProviderHubSpec,
  buildWelcomeSpec,
  providerFromHubRow,
  buildSettingsSpec,
  provenanceNote,
  settingsPatch,
  type SetupContext,
} from './setup-wizard.js';
import { WIZARD_FIELDS } from './profiles-wizard-data.js';
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
    referenceLookup: true,
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
    voiceVoice: '',
    voiceRate: 175,
    voiceWarmupMs: 400,
    autoCreateSpecialists: false,
    autoCreateApplets: false,
    autoOpenApplets: true,
    autoStyleApplets: true,
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
    const { spec } = buildSettingsSpec(ctx());
    const asked = spec.steps.map((s) => s.id);
    const expected = WIZARD_FIELDS.map((f) => f.key).filter((k) => k !== 'provider');
    expect(asked).toEqual(expected);
  });

  it('opens every step on a real value', () => {
    // The guard for a class rather than an instance: a field the flow forgot to
    // populate opens a choice step on no row, the cursor falls to row one, and
    // an accepting Enter silently writes a value the user never chose. That is
    // invisible in a walkthrough and permanent on disk.
    const { spec } = buildSettingsSpec(ctx());
    const blank = spec.steps.filter((s) => s.initial === '' || s.initial === undefined);
    expect(blank.map((s) => s.id)).toEqual(['voiceVoice']);
    // …and that one is blank because blank is its real value: no voice name set.
    expect(spec.steps.find((s) => s.id === 'voiceVoice')?.optional).toBe(true);
  });

  it('drops a list with nothing to choose from rather than asking an empty question', () => {
    const { spec } = buildSettingsSpec(ctx({ models: [], lineups: [] }));
    expect(spec.steps.map((s) => s.id)).not.toContain('model');
    expect(spec.steps.map((s) => s.id)).not.toContain('activeLineupId');
  });

  it('carries the group title as its own field, so a flat walk still reads as sections', () => {
    const { spec } = buildSettingsSpec(ctx());
    const step = spec.steps.find((s) => s.id === 'toolMode');
    expect(step?.section).toBe('Tool safety');
    // Not baked into the question — the renderer styles the two differently, and
    // a delimiter prefix would break on any question containing an em dash.
    expect(step?.question).toBe('Tool mode');
  });
});

describe('settingsPatch — only what changed is written', () => {
  it('writes nothing when every answer is the one it opened with', () => {
    // The env-shadowing guard. `loadConfig` resolves `prefs ?? env ?? default`,
    // so writing back a value nobody touched would freeze whatever a BERNARD_*
    // variable happened to hold and leave the variable dead forever.
    const { spec, steps } = buildSettingsSpec(ctx());
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    expect(settingsPatch(steps, answers)).toEqual({});
  });

  it('writes exactly the fields that moved', () => {
    const { spec, steps } = buildSettingsSpec(ctx());
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    const themeAt = spec.steps.findIndex((s) => s.id === 'theme');
    const stepsAt = spec.steps.findIndex((s) => s.id === 'maxSteps');
    answers[themeAt] = 'ocean';
    answers[stepsAt] = '40';
    expect(settingsPatch(steps, answers)).toEqual({ theme: 'ocean', maxSteps: 40 });
  });

  it('decodes a boolean row, not the label', () => {
    const { spec, steps } = buildSettingsSpec(ctx());
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    const at = spec.steps.findIndex((s) => s.id === 'conciseMode');
    expect(spec.steps[at].initial).toBe('Off');
    answers[at] = 'On';
    expect(settingsPatch(steps, answers)).toEqual({ conciseMode: true });
  });

  it('decodes a list row back to its value, not its label', () => {
    const { spec, steps } = buildSettingsSpec(ctx());
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    const at = spec.steps.findIndex((s) => s.id === 'coordinatorMode');
    answers[at] = 'On';
    expect(settingsPatch(steps, answers)).toEqual({ coordinatorMode: 'on' });
  });

  it('ignores an answer that matches no row', () => {
    const { spec, steps } = buildSettingsSpec(ctx());
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    answers[spec.steps.findIndex((s) => s.id === 'theme')] = 'not-a-theme';
    expect(settingsPatch(steps, answers)).toEqual({});
  });

  it('rejects a bad number rather than writing NaN', () => {
    const { spec, steps } = buildSettingsSpec(ctx());
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    answers[spec.steps.findIndex((s) => s.id === 'maxSteps')] = 'abc';
    expect(settingsPatch(steps, answers)).toEqual({});
  });
});

describe('tool mode folds skipPermissions in', () => {
  function toolModeStep(c: SetupContext) {
    const { spec, steps } = buildSettingsSpec(c);
    const at = spec.steps.findIndex((s) => s.id === 'toolMode');
    return { step: spec.steps[at], steps, at, spec };
  }

  it('opens on "unrestricted" when skipPermissions is on', () => {
    const c = ctx();
    (c.current as Record<string, unknown>).skipPermissions = true;
    expect(toolModeStep(c).step.initial).toContain('Unrestricted');
  });

  it('sets both keys when unrestricted is chosen', () => {
    const { spec, steps, at } = toolModeStep(ctx());
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    answers[at] = '⚠ Unrestricted (no permission checks)';
    expect(settingsPatch(steps, answers)).toEqual({ toolMode: 'write', skipPermissions: true });
  });

  it('clears skipPermissions when moving back off unrestricted', () => {
    // Writing only the key that changed would leave `skipPermissions: true`
    // standing under `toolMode: 'write'` — a mode that is set and not in force.
    const c = ctx();
    (c.current as Record<string, unknown>).skipPermissions = true;
    const { spec, steps, at } = toolModeStep(c);
    const answers = acceptAll(spec.steps.map((s) => ({ initial: s.initial ?? '' })));
    answers[at] = 'Read-only (least privilege)';
    expect(settingsPatch(steps, answers)).toEqual({
      toolMode: 'read-only',
      skipPermissions: false,
    });
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

  it('calls an untouched value recommended', () => {
    // "Default" says where the value came from, which the reader can already
    // see; "recommended" answers the question they are actually asking.
    expect(provenanceNote(field, ctx())).toBe('Recommended.');
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
    const voice = WIZARD_FIELDS.find((f) => f.key === 'voiceVoice')!;
    expect(provenanceNote(voice, ctx())).toBe('Not set.');
  });
});

describe('the provider hub', () => {
  it('is one list, not a page per provider', () => {
    // A page each asked about three providers in a row when almost everyone
    // wants one, gave no view of the set, and made "which am I actually using"
    // a thing you had to remember across screens. Here the state is the screen.
    const spec = buildProviderHubSpec(ctx());
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
    const field = buildProviderHubSpec(c).steps[0].field;
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
    const field = buildProviderHubSpec(c).steps[0].field;
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
    expect(buildProviderHubSpec(ctx()).skipReview).toBe(true);
    expect(buildWelcomeSpec().skipReview).toBe(true);
    expect(buildKeyEntrySpec(ctx(), 'anthropic').spec.skipReview).toBe(true);
  });
});

describe('the key entry page', () => {
  it('words itself for whether that provider already has a key', () => {
    const withKey = buildKeyEntrySpec(ctx(), 'anthropic').spec.steps[0];
    const without = buildKeyEntrySpec(ctx(), 'openai').spec.steps[0];
    expect(withKey.nextLabel).toBe('Keep the stored key');
    expect(without.nextLabel).toBe('Back to providers');
    // Blank always means "leave this provider as it is", which is also what Esc
    // does — so it can never be a dead end.
    expect(withKey.optional).toBe(true);
    expect(without.optional).toBe(true);
  });

  it('trims what it returns, and returns nothing for a blank', () => {
    const { decode } = buildKeyEntrySpec(ctx(), 'anthropic');
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
    const { spec } = buildSettingsSpec(withModel(['listed-a', 'listed-b'], 'unlisted-but-working'));
    const step = spec.steps.find((s) => s.id === 'model')!;
    const choices = (step.field as { choices: string[] }).choices;
    expect(choices[0]).toContain('unlisted-but-working');
    expect(step.initial).toBe(choices[0]);
  });

  it('adds nothing when the catalog already lists it', () => {
    // Guard the guard: an unconditional row would duplicate the model on every
    // ordinary install.
    const { spec } = buildSettingsSpec(withModel(['m1', 'm2'], 'm1'));
    const choices = (spec.steps.find((s) => s.id === 'model')!.field as { choices: string[] })
      .choices;
    expect(choices).toEqual(['m1', 'm2']);
  });

  it('asks nothing at all when the catalog could not be read', () => {
    // An empty list is "we do not know", not "here is your one option" — a
    // one-row page is a screen that costs a keystroke and decides nothing.
    const { spec } = buildSettingsSpec(withModel([], 'whatever'));
    expect(spec.steps.find((s) => s.id === 'model')).toBeUndefined();
  });
});

describe('a question that another answer can make inert', () => {
  it("carries the unrestricted row's consequence onto the screen", () => {
    // `toolModePolicy` short-circuits on `skipPermissions` before every other
    // rule, so picking unrestricted makes the confirm-mode answer dead — and
    // the two are asked on separate screens with nothing else connecting them.
    // The warning existed in the registry and rendered nowhere.
    const { spec } = buildSettingsSpec(ctx());
    const step = spec.steps.find((s) => s.id === 'toolMode')!;
    const field = step.field as { choices: string[]; notes?: Record<string, string> };
    const unrestricted = field.choices.find((c) => c.includes('Unrestricted'))!;
    expect(field.notes?.[unrestricted]).toMatch(/confirm-mode answer stops applying/);
  });

  it('says it on the confirm-mode question too, which is asked first', () => {
    const { spec } = buildSettingsSpec(ctx());
    const step = spec.steps.find((s) => s.id === 'confirmMode')!;
    expect(step.hint).toMatch(/unrestricted/i);
  });

  it('adds no notes to a step whose options declare none', () => {
    // Guard the guard: an always-present `notes` map would satisfy the first
    // case while telling the renderer every row has something to say.
    const { spec } = buildSettingsSpec(ctx());
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
    expect(buildDefaultProviderSpec(oneKeyed)).toBeNull();
    expect(buildDefaultProviderSpec(twoKeyed())).not.toBeNull();
  });

  it('greys a keyless provider and says why, rather than hiding it', () => {
    // Hidden, the row answers no question: a provider missing from the list
    // looks unsupported, where a greyed one with a reason says what to do.
    const stage = buildDefaultProviderSpec(twoKeyed())!;
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
    const stage = buildDefaultProviderSpec(twoKeyed())!;
    const field = stage.spec.steps[0].field;
    if (field.kind !== 'choice') return;
    for (const row of field.choices) expect(row).not.toContain('key set');
  });

  it('opens on the provider already in use', () => {
    expect(buildDefaultProviderSpec(twoKeyed())!.spec.steps[0].initial).toBe('anthropic');
  });

  it('decodes a row back to the bare provider name', () => {
    const stage = buildDefaultProviderSpec(twoKeyed())!;
    expect(stage.decode(['openai'])).toBe('openai');
  });

  it('commits on Continue rather than ending at a one-answer review', () => {
    // A review over one answer is the page you just left, restated without the
    // blurbs and greyed rows that made the choice legible — a keystroke to
    // confirm something nobody had stopped seeing. The flow cannot see this:
    // `runSetupFlow` hands out a spec and takes a `WizardResult` back, so the
    // review is entirely a renderer concern and every flow test passes either
    // way.
    expect(buildDefaultProviderSpec(twoKeyed())!.spec.skipReview).toBe(true);
  });

  it('does not skip the review on the stage that has a batch to check', () => {
    // Guard the guard: skipping everywhere would satisfy the assertion above
    // while removing the check-your-answers screen 35 questions exist for.
    expect(buildSettingsSpec(ctx()).spec.skipReview).not.toBe(true);
  });
});
