/**
 * @module setup-flow
 *
 * Running the setup wizard, once, wherever it is hosted (#447).
 *
 * The flow is the same in all three places it is reached from — first run,
 * `bernard setup`, and `/setup` — so it is written once over an injected
 * `requestWizard`. The REPL passes its real overlay bridge; the standalone host
 * (`src/ui/SetupHost.tsx`) passes a minimal one. Only who renders differs. That
 * is the `apps/manage.ts` (returns) versus `app-cli.ts` (prints) split, applied
 * to a flow rather than an operation.
 *
 * `src/setup-wizard.ts` owns the questions and stays pure; this module owns the
 * I/O — reading what is installed, persisting answers, and probing that the
 * result can actually make a call.
 *
 * ## It must survive having no API key
 *
 * `loadConfig()` throws when the active provider has no key, and the whole point
 * of a first run is that there is none. So nothing here calls it until stage A
 * has stored one: the installation is read through `getProviderKeyStatus()` and
 * `loadPreferences()`, the `voice-test` precedent. That constraint is also why
 * there are two stages rather than one — stage B is built after a key exists,
 * which is the same moment the model list becomes knowable.
 */

import {
  getProviderApiKey,
  getProviderKeyStatus,
  getStoredKeyHint,
  saveProviderKey,
  loadPreferences,
  loadConfig,
  getDefaultModel,
  type BernardConfig,
} from './config.js';
import { loadCustomProviders, SUPPORTED_SDKS } from './custom-providers.js';
import { checkProviderKey, keyCheckEndpoint, tidyKey } from './provider-key-check.js';
import { saveActiveSettings, type ProfileSettings } from './profiles.js';
import { getCatalogForProvider } from './providers/catalog.js';
import type { BuiltinProvider, SupportedSdk } from './providers/types.js';
import { listLineups, loadLineups, resolveActiveLineup } from './lineups.js';
import { resolveSiteModel } from './model-policy.js';
import { validateModel, type ModelProbeResult } from './model-validate.js';
import type { ToolErrorType } from './framework/tools/types.js';
import { WIZARD_FIELDS } from './profiles-wizard-data.js';
import {
  buildDefaultProviderSpec,
  buildKeyEntrySpec,
  buildProviderHubSpec,
  buildSettingsSpec,
  buildWelcomeSpec,
  providerFromHubRow,
  settingsPatch,
  type SetupContext,
  type SetupProvider,
} from './setup-wizard.js';
import { BERNARD_BANNER, TAGLINE } from './output.js';
import type { WizardAnswer, WizardResult, WizardSpec } from './ui/overlays/wizard-types.js';
import { debugLog } from './logger.js';

export interface SetupFlowDeps {
  requestWizard: (spec: WizardSpec, signal?: AbortSignal) => Promise<WizardResult>;
  signal?: AbortSignal;
  /**
   * Probe the resolved `main` model after saving. On by default — a setup flow
   * that says "you're set up" without having made one call is the failure #447
   * was filed about. Off in tests, which must not hit a provider.
   */
  verify?: boolean;
  /**
   * Progress, for a host that can show it. The probe is a real network call and
   * takes seconds; without this the last frame is the last question and the flow
   * looks hung.
   *
   * Reported from HERE rather than guessed by the host, because only this module
   * knows whether a probe is about to happen — a host that announced one
   * unconditionally would say it was checking while `verify: false` skipped it.
   */
  onProgress?: (message: string) => void;
}

export type SetupOutcome =
  /** Could not be walked at all — no interactive terminal to walk it in. */
  | { status: 'unavailable'; reason: string }
  /** Walked, but every key page was left blank, so there is nothing to configure. */
  | { status: 'no-key' }
  | { status: 'cancelled'; stage: 'provider' | 'settings' }
  | {
      status: 'saved';
      provider: string;
      /** Settings actually written. Empty when the user accepted every value. */
      changed: Array<keyof ProfileSettings>;
      /** Providers whose key was entered or replaced on this run. */
      keysStored: string[];
      /** Absent when verification was skipped or could not run. */
      probe?: ModelProbeResult;
      /** Why no probe, when there is none. */
      probeSkipped?: string;
    };

/** How much of a stored key to show, so a reader can tell which one is in place. */
const KEY_HINT_CHARS = 4;

/** The providers offerable right now: the three built-ins plus any custom ones. */
function readProviders(): SetupProvider[] {
  const custom = loadCustomProviders();
  return getProviderKeyStatus().map((s) => {
    const keyHint = getStoredKeyHint(s.provider, KEY_HINT_CHARS);
    return {
      name: s.provider,
      hasKey: s.hasKey,
      custom: Object.hasOwn(custom, s.provider),
      ...(keyHint === undefined ? {} : { keyHint }),
    };
  });
}

/**
 * Where a key for this provider would be checked — the SDK, and the host.
 *
 * Resolved from the provider's own configuration, never from its NAME. A custom
 * provider wraps one of the three SDKs at somebody else's endpoint, and a CLI
 * `--provider-base-url` re-points a built-in the same way; keying off the name
 * would POST a key minted for a private gateway to the vendor that never issued
 * it. `null` for a provider we cannot place, which is what makes the control
 * absent rather than wrong.
 */
function keyCheckTarget(
  provider: string,
  config: BernardConfig | null,
): { sdk: SupportedSdk; baseURL?: string } | null {
  const custom = loadCustomProviders()[provider];
  if (custom !== undefined) return { sdk: custom.sdk, baseURL: custom.baseURL };
  if (!SUPPORTED_SDKS.includes(provider as SupportedSdk)) return null;
  // The override names one provider — whichever this process was started
  // against — so it applies here only when that is the one being checked.
  const baseURL = config?.provider === provider ? config.providerBaseUrl : undefined;
  return { sdk: provider as SupportedSdk, baseURL };
}

/**
 * The optional check behind the key page's `Test key` control.
 *
 * Never required, and never a gate: the verdict is shown and then forgotten, so
 * Save works identically whether the key was tested, failed the test, or the
 * network was down. That is the whole contract of `WizardStep.check`.
 *
 * An EMPTY buffer tests the key already stored, which is the question a reader
 * with a key in place actually has ("is the one I have still good?"). The
 * fallback lives here rather than in the pure module because only this side can
 * read `keys.json`.
 */
function keyCheckFor(provider: string, config: BernardConfig | null) {
  const target = keyCheckTarget(provider, config);
  if (target === null) return undefined;
  const host = keyCheckEndpoint(target.sdk, target.baseURL).host;
  return {
    label: 'Test key',
    // Same width as the label, so the footer cannot jiggle between states.
    busyLabel: 'Testing…',
    run: async (typed: string, signal: AbortSignal) => {
      // Read at RUN time, not at build time: a key saved on an earlier pass
      // through the hub is exactly the one a reader is most likely to re-check.
      const stored = tryLoadConfig();
      const key =
        tidyKey(typed) || (stored === null ? '' : (getProviderApiKey(stored, provider) ?? ''));
      if (key.length === 0) {
        return { tone: 'unknown' as const, message: 'No key to test — paste one first.' };
      }
      const verdict = await checkProviderKey({
        sdk: target.sdk,
        baseURL: target.baseURL,
        key,
        signal,
      });
      // Naming the host is the reader's only chance to see where their secret
      // went, and for a custom provider it is what proves the endpoint resolved
      // to their gateway rather than to the vendor.
      return { ...verdict, message: `${verdict.message} (${host})` };
    },
  };
}

/** Model ids to offer for a provider. Empty for a custom one — we have no catalog. */
function readModels(provider: string): string[] {
  try {
    return getCatalogForProvider(provider as BuiltinProvider).map((e) => e.model);
  } catch {
    return [];
  }
}

/**
 * The effective value of every setting, and which of them the profile sets
 * explicitly.
 *
 * `config` is the resolved view (profile over environment over default) and is
 * what each step opens on; `prefs` says which of those the profile owns, which
 * is only used to word the provenance note. `autoUpdate` is read from `prefs`
 * because it is the one wizard field that is not a `BernardConfig` key — and a
 * field with no effective value would open a choice step on no row, where the
 * cursor's default landing would read as an accepted value and be written.
 */
function readCurrent(config: BernardConfig | null): {
  current: Partial<ProfileSettings>;
  explicit: Set<keyof ProfileSettings>;
} {
  const prefs = loadPreferences();
  const current: Record<string, unknown> = {};
  const explicit = new Set<keyof ProfileSettings>();
  const source = (config ?? {}) as unknown as Record<string, unknown>;
  const stored = prefs as unknown as Record<string, unknown>;

  for (const field of WIZARD_FIELDS) {
    const key = field.key as string;
    const fromProfile = stored[key];
    if (fromProfile !== undefined) explicit.add(field.key);
    const effective = source[key] ?? fromProfile;
    if (effective !== undefined) current[key] = effective;
  }
  // Not a `BernardConfig` key, so the loop above can only ever see the stored
  // value. `false` is what `startupUpdateCheck(!!prefs.autoUpdate)` already
  // treats an absent one as.
  current.autoUpdate = prefs.autoUpdate ?? false;
  // Tool mode's third row. Same reason: an absent value must still be a value.
  current.skipPermissions = (source.skipPermissions as boolean | undefined) ?? false;
  return { current: current as Partial<ProfileSettings>, explicit };
}

/** The lineup in force right now, even when nothing has named one. */
function resolvedLineupId(config: BernardConfig | null, provider: string): string | undefined {
  try {
    return resolveActiveLineup(loadLineups(), config?.activeLineupId, provider).id;
  } catch {
    return undefined;
  }
}

/** Best-effort resolved config. `null` while no provider has a key. */
function tryLoadConfig(): BernardConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

function buildContext(config: BernardConfig | null, provider: string): SetupContext {
  const { current, explicit } = readCurrent(config);
  return {
    current: {
      ...current,
      provider,
      // `activeLineupId` is unset on most installs and the lineup in force is
      // then derived — `resolveActiveLineup` falls back to the one named after
      // the provider. Leaving it unset would open a CHOICE step on no row, and
      // the cursor's default landing would be written as though it had been
      // chosen. Resolving it means the step opens on the lineup actually in use
      // and accepting it writes nothing.
      activeLineupId: current.activeLineupId ?? resolvedLineupId(config, provider),
    },
    explicit,
    providers: readProviders(),
    models: readModels(provider),
    lineups: listLineups().map((l) => ({ id: l.id, name: l.name })),
    env: process.env,
  };
}

/**
 * Walk setup and persist the result.
 *
 * Stage A is persisted before stage B is even built, deliberately: a stored key
 * is progress worth keeping even if the user abandons the settings walk, and it
 * is what makes `loadConfig()` — and therefore the model list and the
 * verification probe — possible at all.
 */
/**
 * The line above the card, added once here rather than by each spec builder.
 *
 * Setup is five wizards and one journey, so the masthead is a property of the
 * FLOW: a builder that forgot it would put an unsigned screen in the middle of
 * a signed sequence, and there would be nothing to notice. `ask_user` builds no
 * spec through here and so stays unsigned, which is the point of the field
 * being opt-in.
 */
function signed(spec: WizardSpec): WizardSpec {
  return { ...spec, masthead: { intro: 'Welcome to', banner: BERNARD_BANNER, tagline: TAGLINE } };
}

export async function runSetupFlow(deps: SetupFlowDeps): Promise<SetupOutcome> {
  const startingConfig = tryLoadConfig();
  const startingProvider = String(
    startingConfig?.provider ?? loadPreferences().provider ?? readProviders()[0]?.name ?? '',
  );

  // ---- The stages, as a machine rather than a straight line -----------------
  //
  // Setup cannot be one wizard (the model list needs a provider first) but it is
  // one journey, and a straight run of `await`s has no way back across a seam —
  // which is why Back had quietly disappeared from four of the five screens.
  // Each stage says where Back goes, and `backExits` on the spec is what makes
  // the overlay offer it there at all.
  const keysStored: string[] = [];
  let stage: 'welcome' | 'providers' | 'default' | 'settings' = 'welcome';
  let provider = startingProvider;
  let askedDefault = false;
  let settingsStage!: ReturnType<typeof buildSettingsSpec>;
  let settingsAnswers!: readonly WizardAnswer[];

  stages: for (;;) {
    switch (stage) {
      case 'welcome': {
        // Nothing precedes it, so no `backExits` and no Back control.
        const welcome = await deps.requestWizard(signed(buildWelcomeSpec()), deps.signal);
        if (welcome.cancelled) return { status: 'cancelled', stage: 'provider' };
        stage = 'providers';
        break;
      }

      case 'providers': {
        // A LOOP, not a page per provider: the hub is the state, picking a row
        // edits that provider's key, and the hub is REBUILT each pass so its
        // ticks and key hints describe what is on disk now rather than when the
        // wizard opened.
        //
        // Every key entered here, not just the default provider's — a lineup
        // mixes providers across tiers and a specialist can pin one, so "set up
        // a second provider" is ordinary use rather than an edge case.
        for (;;) {
          const hubCtx = buildContext(tryLoadConfig(), provider);
          const picked = await deps.requestWizard(
            signed(buildProviderHubSpec(hubCtx)),
            deps.signal,
          );
          if (picked.cancelled) {
            // Back returns to the welcome; Esc on the HUB leaves setup, because
            // the hub is the screen you are on.
            if (picked.back === true) {
              stage = 'welcome';
              continue stages;
            }
            return { status: 'cancelled', stage: 'provider' };
          }
          const picking = providerFromHubRow(hubCtx, picked.answers[0] ?? '');
          if (picking === null) break;

          const entry = buildKeyEntrySpec(hubCtx, picking, keyCheckFor(picking, startingConfig));
          const typed = await deps.requestWizard(signed(entry.spec), deps.signal);
          // Back and Esc mean the same thing on a page opened FROM the hub:
          // return to it. Nothing is written either way.
          if (typed.cancelled) continue;
          const key = entry.decode(typed.answers);
          if (key.length > 0) {
            saveProviderKey(picking, key);
            if (!keysStored.includes(picking)) keysStored.push(picking);
          }
        }

        const keyed = getProviderKeyStatus()
          .filter((p) => p.hasKey)
          .map((p) => p.provider);
        // Nothing can be configured without one, and walking 35 settings
        // questions to arrive at "no API key is stored" wastes the session.
        if (keyed.length === 0) return { status: 'no-key' };
        if (!keyed.includes(provider)) provider = keyed[0];
        stage = 'default';
        break;
      }

      case 'default': {
        // Its own wizard because it is built AFTER the keys are saved: a page
        // built beside them could not know what was typed in, and this one must,
        // to show a keyless provider as unpickable. Skipped when the answer is
        // forced — and then Back from the settings must skip it too, which is
        // what `askedDefault` records.
        const defaultStage = buildDefaultProviderSpec(buildContext(tryLoadConfig(), provider));
        askedDefault = defaultStage !== null;
        if (defaultStage !== null) {
          const chosen = await deps.requestWizard(signed(defaultStage.spec), deps.signal);
          if (chosen.cancelled) {
            if (chosen.back === true) {
              stage = 'providers';
              continue stages;
            }
            return { status: 'cancelled', stage: 'provider' };
          }
          provider = defaultStage.decode(chosen.answers);
        }
        stage = 'settings';
        break;
      }

      case 'settings': {
        settingsStage = buildSettingsSpec(buildContext(tryLoadConfig(), provider));
        const answered = await deps.requestWizard(signed(settingsStage.spec), deps.signal);
        if (answered.cancelled) {
          if (answered.back === true) {
            stage = askedDefault ? 'default' : 'providers';
            continue stages;
          }
          return { status: 'cancelled', stage: 'settings' };
        }
        settingsAnswers = answered.answers;
        break stages;
      }
    }
  }

  const providerChanged = provider !== startingProvider;
  // The stored model belongs to the provider that was active when it was
  // chosen, so a provider switch must re-derive it or the very next call asks
  // one vendor for another's model id. Unchanged provider leaves it alone.
  saveActiveSettings(
    providerChanged ? { provider, model: getDefaultModel(provider) } : { provider },
  );

  // ---- Stage B: everything else ------------------------------------------
  const patch = settingsPatch(settingsStage.steps, settingsAnswers);
  const changed = Object.keys(patch) as Array<keyof ProfileSettings>;
  if (changed.length > 0) saveActiveSettings(patch);
  debugLog('setup:saved', { provider, keysStored, changed });

  const saved = {
    status: 'saved' as const,
    provider,
    changed,
    keysStored,
  };

  if (deps.verify === false) return { ...saved, probeSkipped: 'verification disabled' };

  const config = tryLoadConfig();
  if (config === null) {
    return { ...saved, probeSkipped: 'no API key is stored for this provider' };
  }
  try {
    // The model the MAIN site actually resolves to, which under any model mode
    // but `off` is a lineup slot rather than `config.model`. Probing
    // `config.model` would verify a value most turns never use.
    deps.onProgress?.('Checking that the configuration can make a call…');
    const site = resolveSiteModel(config, 'main');
    const probe = await validateModel(config, site.provider, site.modelName, {
      abortSignal: deps.signal,
    });
    return { ...saved, probe };
  } catch (err) {
    return {
      ...saved,
      probeSkipped: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * What to do about a failed probe, in this context.
 *
 * Deliberately not `classifyError`'s `playbook.user`: that table answers for a
 * TOOL failure mid-turn and cannot know a setup wizard exists — its `auth` line
 * points at `/models` and its `not_found` line reads "Target was not found",
 * neither of which helps someone who has just finished pasting a key. The first
 * cut said "fix the model with /model" for every category, which sent a user
 * with a bad key after the one thing that was not wrong.
 *
 * Categories come from `validateModel`, which refines them for exactly this
 * question, so this switches on its answer rather than re-deriving one.
 */
function probeRemedy(category: ToolErrorType | undefined): string {
  switch (category) {
    case 'auth':
      return 'The key was rejected — run setup again and paste a new one.';
    case 'not_found':
      return 'That model id is not available to this account. Pick another with /model, or change the ladder with /lineup.';
    case 'rate_limit':
      return 'The account is over quota. It may work later, or try a different provider.';
    case 'timeout':
    case 'transient':
      return 'The provider did not answer in time — this may be temporary. Try again.';
    default:
      return 'Check the key with `bernard providers`, and the model with /model.';
  }
}

/** One line per outcome, shared by both hosts so they cannot word it differently. */
export function describeOutcome(outcome: SetupOutcome): string[] {
  if (outcome.status === 'unavailable') {
    return [
      `Setup needs an interactive terminal — ${outcome.reason}.`,
      'Set a key without it: bernard add-key <provider> <key>, or export ANTHROPIC_API_KEY.',
    ];
  }
  if (outcome.status === 'no-key') {
    return [
      'No API key was entered, so there is nothing to set up yet.',
      'Get one from your provider, then run `bernard setup` again.',
    ];
  }
  if (outcome.status === 'cancelled') {
    return outcome.stage === 'provider'
      ? ['Setup cancelled — nothing was changed.']
      : ['Setup cancelled — your provider and key were kept, no settings were changed.'];
  }
  const lines: string[] = [];
  lines.push(
    outcome.keysStored.length === 0
      ? `Default provider: ${outcome.provider}.`
      : `Default provider: ${outcome.provider}. Keys stored for ${outcome.keysStored.join(', ')}.`,
  );

  lines.push(
    outcome.changed.length === 0
      ? 'Settings: no changes — every value you kept is still inherited.'
      : `Settings changed: ${outcome.changed.join(', ')}.`,
  );
  if (outcome.probe) {
    lines.push(
      outcome.probe.ok
        ? `Verified: ${outcome.probe.provider}/${outcome.probe.model} answered in ${outcome.probe.latencyMs}ms.`
        : // Provider messages already end in a full stop about half the time, so
          // appending one unconditionally produced `API key is invalid..`.
          `Could NOT reach ${outcome.probe.provider}/${outcome.probe.model} — ${outcome.probe.category}: ${sentence(outcome.probe.message ?? 'no detail')}`,
    );
    if (!outcome.probe.ok) lines.push(probeRemedy(outcome.probe.category));
  } else if (outcome.probeSkipped) {
    lines.push(`Not verified — ${outcome.probeSkipped}.`);
  }
  return lines;
}

/** Ends a borrowed message in exactly one full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
