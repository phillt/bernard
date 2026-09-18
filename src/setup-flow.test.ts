import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { useTempHome } from './__tests__/temp-home.js';
import type { WizardAnswer, WizardResult, WizardSpec } from './ui/overlays/wizard-types.js';
import { PROVIDERS_DONE, SETUP_MODE_ROWS } from './setup-wizard.js';
import { WIZARD_FIELDS, type SetupTier } from './profiles-wizard-data.js';

/**
 * The setup flow against a real, empty `BERNARD_HOME` (#447).
 *
 * `setup-wizard.test.ts` covers the questions and the decode rules in isolation;
 * this covers what actually lands on disk, which is where the failure that
 * matters lives. Two properties in particular cannot be observed anywhere else:
 * that a walk which changes nothing writes nothing, and that a key is stored
 * before the settings stage is even built.
 *
 * `verify: false` throughout — the probe makes a real provider call, and a test
 * that reaches the network is a test that fails for reasons about the network.
 */

const getHome = useTempHome('bernard-setup-flow');

beforeEach(() => {
  // `loadConfig` bridges every stored key into `process.env[<PROVIDER>_API_KEY]`
  // so the SDKs can read it — and `process.env` is not reset between tests, so a
  // key saved by an earlier case is still visible to `getProviderKeyStatus` in
  // the next one, inside a brand-new home. Passes alone, fails in the file.
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY']) {
    delete process.env[name];
  }
});

/**
 * Drives the provider hub, which is a LOOP rather than a linear run of pages.
 *
 * `keys` maps provider name to the key to type for it; every named provider is
 * visited once and then the hub is left. Written as a stateful answerer rather
 * than a list of answers because the flow decides how many times to show each
 * spec, and a fixture that assumed a fixed sequence would encode that decision.
 */
function drive(
  keys: Record<string, string> = {},
  settings: Record<string, WizardAnswer> = {},
  /**
   * Which row to take on the mode screen (#582). `expert` by default, because
   * these cases are about the settings machinery and a quick walk asks three
   * questions — the quick path has its own cases below.
   */
  tier: SetupTier = 'expert',
) {
  const pending = new Set(Object.keys(keys));
  const seen: string[][] = [];
  const answer = (spec: WizardSpec): Promise<WizardResult> => {
    seen.push(spec.steps.map((s) => s.id));
    const answers = spec.steps.map((step) => {
      if (step.id === 'mode') return SETUP_MODE_ROWS[tier];
      if (step.id === 'providers') {
        const next = [...pending][0];
        if (next === undefined) return PROVIDERS_DONE;
        pending.delete(next);
        const rows = step.field.kind === 'choice' ? step.field.choices : [];
        return rows.find((r) => r.startsWith(next)) ?? PROVIDERS_DONE;
      }
      if (step.id.startsWith('key:')) return keys[step.id.slice(4)] ?? '';
      return settings[step.id] ?? step.initial ?? '';
    });
    return Promise.resolve({ cancelled: false, answers } satisfies WizardResult);
  };
  return { answer, seen };
}

function profilesJson(): Record<string, unknown> {
  const path = `${getHome()}/bernard/profiles.json`;
  if (!fs.existsSync(path)) return {};
  const parsed = JSON.parse(fs.readFileSync(path, 'utf-8')) as {
    activeProfileId: string;
    profiles: Record<string, { settings: Record<string, unknown> }>;
  };
  return parsed.profiles[parsed.activeProfileId]?.settings ?? {};
}

async function flow() {
  return await import('./setup-flow.js');
}

describe('runSetupFlow on an empty home', () => {
  it('stores a key and the provider, and writes nothing else', async () => {
    const { runSetupFlow } = await flow();
    const driver = drive({ anthropic: 'sk-test-key' });
    const outcome = await runSetupFlow({ verify: false, requestWizard: driver.answer });

    expect(outcome.status).toBe('saved');
    if (outcome.status !== 'saved') return;
    expect(outcome.keysStored).toEqual(['anthropic']);
    // The env-shadowing guard, end to end: every question was accepted as shown,
    // so the profile gains the provider and nothing more. A field left alone
    // keeps inheriting from BERNARD_* or from the built-in default.
    expect(outcome.changed).toEqual([]);
    expect(Object.keys(profilesJson()).sort()).toEqual(['provider']);

    const keys = JSON.parse(fs.readFileSync(`${getHome()}/bernard/keys.json`, 'utf-8')) as Record<
      string,
      string
    >;
    expect(keys.anthropic).toBe('sk-test-key');
  });

  it('sets up more than one provider in a single pass', async () => {
    // Bernard is not a one-provider product: a lineup mixes them per tier and a
    // specialist can pin one, so a second key is ordinary use.
    const { runSetupFlow } = await flow();
    const driver = drive({ anthropic: 'sk-ant', openai: 'sk-oai' });
    const outcome = await runSetupFlow({ verify: false, requestWizard: driver.answer });
    expect(outcome.status).toBe('saved');
    if (outcome.status !== 'saved') return;
    expect(outcome.keysStored.sort()).toEqual(['anthropic', 'openai']);
  });

  it('rebuilds the hub after each key, so it describes what is on disk now', async () => {
    // The hub is the state of the screen. Built once it would still say "no key"
    // for a provider whose key you had just typed two screens earlier.
    const { runSetupFlow } = await flow();
    const hubTrailing: Array<Record<string, { text: string; tick?: boolean }> | undefined> = [];
    const hubRows: string[][] = [];
    await runSetupFlow({
      verify: false,
      requestWizard: (spec) => {
        const step = spec.steps[0];
        if (step.id === 'providers' && step.field.kind === 'choice') {
          hubRows.push(step.field.choices);
          hubTrailing.push(step.field.trailing);
          const anthropic = step.field.choices.find((r) => r.startsWith('anthropic'));
          const first = hubRows.length === 1;
          return Promise.resolve({
            cancelled: false,
            answers: [first ? (anthropic ?? PROVIDERS_DONE) : PROVIDERS_DONE],
          } satisfies WizardResult);
        }
        return Promise.resolve({
          cancelled: false,
          answers: spec.steps.map((st) =>
            st.id.startsWith('key:') ? 'sk-test-key' : (st.initial ?? ''),
          ),
        } satisfies WizardResult);
      },
    });
    expect(hubRows).toHaveLength(2);
    expect(hubTrailing[0]?.['anthropic']).toEqual({ text: 'no key' });
    expect(hubTrailing[1]?.['anthropic']?.tick).toBe(true);
  });

  it('leaves an environment variable in force when its question is accepted', async () => {
    // The hazard this flow is shaped around. `loadConfig` resolves
    // `prefs ?? env ?? default`, so writing back a value nobody touched would
    // freeze whatever BERNARD_MAX_STEPS happened to hold and leave the variable
    // dead for good — a setting changed forever by a walk-through.
    const previous = process.env.BERNARD_MAX_STEPS;
    process.env.BERNARD_MAX_STEPS = '99';
    try {
      const { runSetupFlow } = await flow();
      let settingsSpec: WizardSpec | undefined;
      const driver = drive({ anthropic: 'sk-test-key' });
      const outcome = await runSetupFlow({
        verify: false,
        requestWizard: (spec) => {
          if (spec.steps.some((s) => s.id === 'maxSteps')) settingsSpec = spec;
          return driver.answer(spec);
        },
      });
      // The step SHOWS the live value, so the walk is honest…
      expect(settingsSpec?.steps.find((s) => s.id === 'maxSteps')?.initial).toBe('99');
      expect(settingsSpec?.steps.find((s) => s.id === 'maxSteps')?.hint).toContain(
        'BERNARD_MAX_STEPS',
      );
      // …and accepting it writes nothing, so the variable still decides.
      expect(outcome.status).toBe('saved');
      expect(profilesJson().maxSteps).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BERNARD_MAX_STEPS;
      else process.env.BERNARD_MAX_STEPS = previous;
    }
  });

  it('writes only the settings that were changed', async () => {
    const { runSetupFlow } = await flow();
    const driver = drive({ anthropic: 'sk-test-key' }, { theme: 'ocean', maxSteps: '40' });
    const outcome = await runSetupFlow({ verify: false, requestWizard: driver.answer });

    expect(outcome.status).toBe('saved');
    if (outcome.status !== 'saved') return;
    expect(outcome.changed.sort()).toEqual(['maxSteps', 'theme']);
    const settings = profilesJson();
    expect(settings.theme).toBe('ocean');
    expect(settings.maxSteps).toBe(40);
    // Everything else stayed out of the file rather than being frozen at
    // whatever it happened to resolve to during the walk.
    expect(Object.keys(settings).sort()).toEqual(['maxSteps', 'provider', 'theme']);
  });

  it('keeps the key when the settings stage is abandoned', async () => {
    const { runSetupFlow } = await flow();
    const driver = drive({ anthropic: 'sk-test-key' });
    const outcome = await runSetupFlow({
      verify: false,
      requestWizard: (spec) =>
        spec.title === 'Settings'
          ? Promise.resolve({ cancelled: true, answered: [] } satisfies WizardResult)
          : driver.answer(spec),
    });

    expect(outcome).toEqual({ status: 'cancelled', stage: 'settings' });
    // The keys are persisted as they are entered — progress worth keeping, and
    // what makes `loadConfig` work at all for the stages after them.
    expect(fs.existsSync(`${getHome()}/bernard/keys.json`)).toBe(true);
  });

  it('writes nothing at all when the hub is dismissed', async () => {
    // Esc on the HUB leaves setup; the hub is the screen you are on.
    const { runSetupFlow } = await flow();
    const outcome = await runSetupFlow({
      verify: false,
      requestWizard: (spec) =>
        Promise.resolve(
          spec.steps[0].id === 'welcome'
            ? ({ cancelled: false, answers: [''] } satisfies WizardResult)
            : ({ cancelled: true, answered: [] } satisfies WizardResult),
        ),
    });
    expect(outcome).toEqual({ status: 'cancelled', stage: 'provider' });
    expect(fs.existsSync(`${getHome()}/bernard/keys.json`)).toBe(false);
    expect(profilesJson()).toEqual({});
  });

  it('returns to the hub when a key page is dismissed, rather than leaving setup', async () => {
    // Esc inside a key page only leaves that page: it is opened FROM the hub,
    // and dismissing it should put you back where you came from.
    const { runSetupFlow } = await flow();
    let opened = 0;
    const outcome = await runSetupFlow({
      verify: false,
      requestWizard: (spec) => {
        const step = spec.steps[0];
        if (step.id.startsWith('key:')) {
          opened += 1;
          return Promise.resolve({ cancelled: true, answered: [] } satisfies WizardResult);
        }
        if (step.id === 'providers' && step.field.kind === 'choice') {
          const row = step.field.choices.find((r) => r.startsWith('anthropic'));
          return Promise.resolve({
            cancelled: false,
            answers: [opened === 0 ? (row ?? PROVIDERS_DONE) : PROVIDERS_DONE],
          } satisfies WizardResult);
        }
        return Promise.resolve({
          cancelled: false,
          answers: spec.steps.map((st) => st.initial ?? ''),
        } satisfies WizardResult);
      },
    });
    expect(opened).toBe(1);
    // Dismissing the key page did not abandon setup — it came back to the hub,
    // which then moved on. With no key entered anywhere, that is `no-key`.
    expect(outcome).toEqual({ status: 'no-key' });
  });

  it('builds the settings stage even though the home started with no key', async () => {
    // The reason the stages are separate: `loadConfig()` throws without a key,
    // so the model list — and the probe — only become possible after one.
    const { runSetupFlow } = await flow();
    const driver = drive({ anthropic: 'sk-test-key' });
    await runSetupFlow({ verify: false, requestWizard: driver.answer });
    const settings = driver.seen.find((ids) => ids.includes('toolMode'));
    expect(settings).toContain('model');
    expect(settings).not.toContain('provider');
    expect(driver.seen[0]).toEqual(['welcome']);
    // The mode screen sits between the welcome and the hub, because every stage
    // from the hub onwards paints a rail naming the sections still to come.
    expect(driver.seen[1]).toEqual(['mode']);
    expect(driver.seen[2]).toEqual(['providers']);
  });

  it('opens every question on something Enter can accept', async () => {
    // Both halves were found by walking the real thing, and neither is visible
    // from a hand-written context.
    //
    //  - A CHOICE step with no initial puts the cursor on row one, and Enter
    //    writes that row as though it had been chosen (`activeLineupId`).
    //  - A NUMERIC step with no initial is refused by its own range check, so
    //    the walk cannot get past it at all without setting a value (`voiceRate`).
    const { runSetupFlow } = await flow();
    const specs: WizardSpec[] = [];
    const driver = drive({ anthropic: 'sk-test-key' });
    await runSetupFlow({
      verify: false,
      requestWizard: (spec) => {
        specs.push(spec);
        return driver.answer(spec);
      },
    });

    const settings = specs.find((s) => s.steps.some((st) => st.id === 'toolMode'))!;
    const blankChoices = settings.steps
      .filter((s) => s.field.kind === 'choice' && !s.initial)
      .map((s) => s.id);
    expect(blankChoices).toEqual([]);

    const stuck = settings.steps
      .filter((s) => s.field.kind === 'text' && !s.initial && s.optional !== true)
      .map((s) => s.id);
    expect(stuck).toEqual([]);
  });

  it('stops rather than walking the settings with no key at all', async () => {
    // Leaving the hub with nothing entered means nothing can be configured, and
    // walking the settings questions to arrive at "no API key is stored" wastes the
    // session.
    const { runSetupFlow, describeOutcome } = await flow();
    const driver = drive();
    const outcome = await runSetupFlow({ verify: false, requestWizard: driver.answer });
    expect(outcome).toEqual({ status: 'no-key' });
    expect(driver.seen.some((ids) => ids.includes('toolMode'))).toBe(false);
    expect(describeOutcome(outcome).join('\n')).toContain('No API key was entered');
  });

  it('does not ask which provider is default when only one has a key', async () => {
    // A question whose answer is forced is a screen that costs a keystroke.
    const { runSetupFlow } = await flow();
    const driver = drive({ anthropic: 'sk-test-key' });
    await runSetupFlow({ verify: false, requestWizard: driver.answer });
    expect(driver.seen.flat()).not.toContain('provider');
  });

  it('asks which provider is default once a second one has a key', async () => {
    const { runSetupFlow } = await flow();
    const driver = drive({ anthropic: 'sk-ant', openai: 'sk-oai' });
    await runSetupFlow({ verify: false, requestWizard: driver.answer });
    expect(driver.seen.flat()).toContain('provider');
  });

  it('walks Back across every stage boundary', async () => {
    // Setup is several wizards because the model list needs a provider first,
    // but it is one journey — and a straight run of awaits has no way back
    // across a seam, which is why Back had quietly disappeared from four of five
    // screens. `mode` is the newest seam (#582) and is walked back through here
    // rather than in a case of its own, so the assertion stays about the
    // machine rather than about one stage.
    const { runSetupFlow } = await flow();
    const seen: string[][] = [];
    const backFrom = new Set(['mode', 'providers', 'model']);
    const driver = drive({ anthropic: 'sk-test-key' });
    await runSetupFlow({
      verify: false,
      requestWizard: (spec) => {
        seen.push(spec.steps.map((s) => s.id));
        const first = spec.steps[0].id;
        // Go back once out of the hub and once out of the settings, then let the
        // ordinary driver carry the run to the end.
        if (backFrom.has(first)) {
          backFrom.delete(first);
          return Promise.resolve({
            cancelled: true,
            answered: [],
            back: true,
          } satisfies WizardResult);
        }
        return driver.answer(spec);
      },
    });

    const firsts = seen.map((ids) => ids[0]);
    // welcome → mode → (back) → welcome → mode → hub → (back) → mode → hub → …
    // → settings → (back) → … Each of the three is reached at least twice,
    // which is what "Back returned to it" means from the outside.
    expect(firsts.filter((id) => id === 'welcome').length).toBeGreaterThanOrEqual(2);
    expect(firsts.filter((id) => id === 'mode').length).toBeGreaterThanOrEqual(2);
    expect(firsts.filter((id) => id === 'providers').length).toBeGreaterThanOrEqual(2);
    expect(firsts.filter((id) => id === 'model').length).toBeGreaterThanOrEqual(2);
  });

  it('asks three settings questions on the quick path, and writes nothing', async () => {
    // The whole of #582 from the outside: a first run can be completed with a
    // small number of questions and a working Bernard. The count is derived
    // from the registry, not written, so promoting a field to the quick tier
    // moves this rather than breaking it.
    const { runSetupFlow } = await flow();
    const driver = drive({ anthropic: 'sk-test-key' }, {}, 'quick');
    const outcome = await runSetupFlow({ verify: false, requestWizard: driver.answer });
    expect(outcome.status).toBe('saved');
    if (outcome.status !== 'saved') return;
    expect(outcome.tier).toBe('quick');

    const asked = driver.seen.find((ids) => ids.includes('toolMode')) ?? [];
    expect(asked).toEqual(WIZARD_FIELDS.filter((f) => f.tier === 'quick').map((f) => f.key));
    // …and the env-shadowing rule still holds on the short walk: accepting
    // every value writes nothing but the provider.
    expect(outcome.changed).toEqual([]);
    expect(Object.keys(profilesJson()).sort()).toEqual(['provider']);
  });

  it('leaves a setting the quick path never asked about inheriting', async () => {
    // The acceptance item that a skipped question must not land in the profile:
    // a written default would shadow BERNARD_MAX_STEPS forever, for a question
    // the reader was never shown.
    const previous = process.env.BERNARD_MAX_STEPS;
    process.env.BERNARD_MAX_STEPS = '99';
    try {
      const { runSetupFlow } = await flow();
      const driver = drive({ anthropic: 'sk-test-key' }, {}, 'quick');
      await runSetupFlow({ verify: false, requestWizard: driver.answer });
      expect(driver.seen.flat()).not.toContain('maxSteps');
      expect(profilesJson().maxSteps).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BERNARD_MAX_STEPS;
      else process.env.BERNARD_MAX_STEPS = previous;
    }
  });

  it('skips the mode screen entirely when the caller already knows the tier', async () => {
    // `bernard setup --expert`. Asking anyway would make the flag a suggestion.
    const { runSetupFlow } = await flow();
    const driver = drive({ anthropic: 'sk-test-key' });
    const outcome = await runSetupFlow({
      verify: false,
      tier: 'expert',
      requestWizard: driver.answer,
    });
    expect(driver.seen.flat()).not.toContain('mode');
    expect(driver.seen[1]).toEqual(['providers']);
    expect(outcome.status).toBe('saved');
    if (outcome.status !== 'saved') return;
    expect(outcome.tier).toBe('expert');
  });

  it('points at the other doors after a quick run, and says nothing after a full one', async () => {
    const { describeOutcome } = await flow();
    const at = (tier: SetupTier) =>
      describeOutcome({
        status: 'saved',
        tier,
        provider: 'anthropic',
        changed: [],
        keysStored: ['anthropic'],
      }).join('\n');
    expect(at('quick')).toContain('bernard setup --expert');
    expect(at('quick')).toContain('/options');
    // The full walk has nothing to disclose: every question was asked.
    expect(at('expert')).not.toContain('--expert');
  });

  it('puts Back out of the hub on the mode screen, not the welcome', async () => {
    // The generic Back walk above cannot see this: with the hub returning to
    // the welcome instead, `mode` is still reached twice — once on the way out
    // and once on the way back in — so only the immediate successor tells the
    // two apart. Which matters because the mode screen is the one thing a
    // reader stepping back out of the providers stage is likely to be after.
    const { runSetupFlow } = await flow();
    const seen: string[] = [];
    let backed = false;
    const driver = drive({ anthropic: 'sk-test-key' });
    await runSetupFlow({
      verify: false,
      requestWizard: (spec) => {
        seen.push(spec.steps[0].id);
        if (!backed && spec.steps[0].id === 'providers') {
          backed = true;
          return Promise.resolve({ cancelled: true, answered: [], back: true } as WizardResult);
        }
        return driver.answer(spec);
      },
    });
    const hubAt = seen.indexOf('providers');
    expect(hubAt).toBeGreaterThan(-1);
    expect(seen[hubAt + 1]).toBe('mode');
  });

  it('has nowhere to go back to when the caller supplied the tier', async () => {
    // Guard the guard: `--expert` skips the mode screen, so Back out of the hub
    // must reach the welcome rather than a stage that was never shown.
    const { runSetupFlow } = await flow();
    const seen: string[] = [];
    let backed = false;
    const driver = drive({ anthropic: 'sk-test-key' });
    await runSetupFlow({
      verify: false,
      tier: 'expert',
      requestWizard: (spec) => {
        seen.push(spec.steps[0].id);
        if (!backed && spec.steps[0].id === 'providers') {
          backed = true;
          return Promise.resolve({ cancelled: true, answered: [], back: true } as WizardResult);
        }
        return driver.answer(spec);
      },
    });
    const hubAt = seen.indexOf('providers');
    expect(seen[hubAt + 1]).toBe('welcome');
  });

  it('re-derives the model when the provider changes, and leaves it alone otherwise', async () => {
    const { runSetupFlow } = await flow();
    await runSetupFlow({
      verify: false,
      requestWizard: drive({ anthropic: 'sk-test-key' }).answer,
    });
    expect(profilesJson().model).toBeUndefined();

    // A stored model belongs to the provider that was active when it was
    // chosen; carrying it across a switch asks one vendor for another's id.
    const driver = drive({ openai: 'sk-openai' });
    const second = await runSetupFlow({
      verify: false,
      requestWizard: (spec) => {
        const step = spec.steps[0];
        if (step.id === 'provider' && step.field.kind === 'choice') {
          const row = step.field.choices.find((c) => c.includes('openai'));
          return Promise.resolve({
            cancelled: false,
            answers: [row ?? step.initial ?? ''],
          } satisfies WizardResult);
        }
        return driver.answer(spec);
      },
    });
    expect(second.status).toBe('saved');
    expect(profilesJson().provider).toBe('openai');
    expect(typeof profilesJson().model).toBe('string');
  });
});

describe('describeOutcome', () => {
  it('says plainly when nothing changed', async () => {
    const { describeOutcome } = await flow();
    const lines = describeOutcome({
      status: 'saved',
      tier: 'expert',
      provider: 'anthropic',
      changed: [],
      keysStored: [],
    });
    expect(lines.join('\n')).toContain('no changes');
  });

  it('gives the remedy for the category that actually failed', async () => {
    // The first cut said "fix the model with /model" whatever went wrong, which
    // sends a user with a rejected key after the one thing that was not wrong.
    const { describeOutcome } = await flow();
    const at = (category: 'auth' | 'not_found' | 'rate_limit') =>
      describeOutcome({
        status: 'saved',
        tier: 'expert',
        provider: 'anthropic',
        changed: [],
        keysStored: ['anthropic'],
        probe: {
          provider: 'anthropic',
          model: 'claude-opus-5',
          ok: false,
          category,
          message: 'nope',
          latencyMs: 9,
        },
      }).join('\n');
    expect(at('auth')).toContain('paste a new one');
    expect(at('auth')).not.toContain('/model');
    expect(at('not_found')).toContain('/model');
    expect(at('rate_limit')).toContain('quota');
  });

  it('ends a borrowed provider message in exactly one full stop', async () => {
    const { describeOutcome } = await flow();
    const lines = describeOutcome({
      status: 'saved',
      tier: 'expert',
      provider: 'anthropic',
      changed: [],
      keysStored: ['anthropic'],
      probe: {
        provider: 'anthropic',
        model: 'claude-opus-5',
        ok: false,
        category: 'auth',
        message: 'API key is invalid.',
        latencyMs: 9,
      },
    }).join('\n');
    expect(lines).toContain('API key is invalid.');
    expect(lines).not.toContain('invalid..');
  });

  it('names the model that could not be reached, and what to do', async () => {
    const { describeOutcome } = await flow();
    const lines = describeOutcome({
      status: 'saved',
      tier: 'expert',
      provider: 'anthropic',
      changed: [],
      keysStored: ['anthropic'],
      probe: {
        provider: 'anthropic',
        model: 'claude-opus-4',
        ok: false,
        category: 'not_found',
        message: 'model not found',
        latencyMs: 12,
      },
    }).join('\n');
    // The #447 acceptance item: a failure has to name the model, not just fail.
    expect(lines).toContain('claude-opus-4');
    expect(lines).toContain('/lineup');
    expect(lines).toContain('not_found');
  });
});

/**
 * The optional key check, wired from the flow side (#447).
 *
 * The leaf's own tests cover the status table and the endpoint arithmetic; what
 * only this side can answer is which endpoint a given PROVIDER resolves to, and
 * that a check is never a gate on saving. Getting the first wrong means mailing
 * somebody's secret to a host that never issued it, so it is asserted against
 * the URL the runner really fetches rather than against the resolver.
 */
describe('the key page carries an optional check', () => {
  /** Run the flow far enough to capture the key page it builds for `provider`. */
  async function keyStep(provider: string, keys: Record<string, string> = {}) {
    const { runSetupFlow } = await flow();
    const driver = drive({ [provider]: keys[provider] ?? '' });
    let captured: WizardSpec['steps'][number] | undefined;
    await runSetupFlow({
      verify: false,
      requestWizard: (spec) => {
        const step = spec.steps.find((s) => s.id === `key:${provider}`);
        if (step !== undefined) captured = step;
        return driver.answer(spec);
      },
    });
    return captured;
  }

  /** A fetch that records where it was sent and answers 200. */
  function recordingFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = ((url: URL | string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it('sends a built-in provider its own vendor host', async () => {
    const step = await keyStep('anthropic');
    expect(step?.check).toBeDefined();
    const { calls, impl } = recordingFetch();
    vi.stubGlobal('fetch', impl);
    try {
      const verdict = await step!.check!.run('sk-ant-test', new AbortController().signal);
      expect(calls[0].url).toBe('https://api.anthropic.com/v1/models');
      // The header shape is per SDK, and it is what a wrong resolution would
      // get wrong silently — an Anthropic key sent as a bearer token reads as
      // invalid rather than as misrouted.
      expect(Object.keys(calls[0].init.headers as Record<string, string>)).toContain('x-api-key');
      expect(verdict.tone).toBe('ok');
      // …and the reader is told where their secret went.
      expect(verdict.message).toContain('api.anthropic.com');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends a custom provider its OWN gateway, not the SDK vendor', async () => {
    // The defect this exists to prevent: a custom provider wraps one of the
    // three SDKs, so keying the endpoint off the SDK — or off the provider name
    // — would POST a key minted for a private gateway to a vendor that never
    // issued it.
    const { saveCustomProvider } = await import('./custom-providers.js');
    saveCustomProvider({
      name: 'gateway',
      sdk: 'anthropic',
      baseURL: 'http://localhost:11434/v1',
      defaultModel: 'llama3.2',
    });
    const step = await keyStep('gateway');
    const { calls, impl } = recordingFetch();
    vi.stubGlobal('fetch', impl);
    try {
      await step!.check!.run('sk-local', new AbortController().signal);
      expect(calls[0].url).toBe('http://localhost:11434/v1/models');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never writes a key, whatever the verdict', async () => {
    // Testing is not saving. A reader who tests a key and then backs out must
    // leave nothing behind.
    const step = await keyStep('anthropic');
    const { impl } = recordingFetch();
    vi.stubGlobal('fetch', impl);
    try {
      await step!.check!.run('sk-ant-typed-but-not-saved', new AbortController().signal);
      const keysPath = `${getHome()}/bernard/keys.json`;
      const stored = fs.existsSync(keysPath) ? fs.readFileSync(keysPath, 'utf-8') : '';
      expect(stored).not.toContain('sk-ant-typed-but-not-saved');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says so rather than probing when there is no key to test', async () => {
    const step = await keyStep('anthropic');
    const { calls, impl } = recordingFetch();
    vi.stubGlobal('fetch', impl);
    try {
      const verdict = await step!.check!.run('', new AbortController().signal);
      expect(verdict.tone).toBe('unknown');
      expect(calls).toHaveLength(0);
      // Says what to DO. The leaf refuses an empty key too, with wording that
      // describes its own job ("no key to check"); on this page the reader has
      // an empty field in front of them and a next action.
      expect(verdict.message).toContain('paste one first');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
