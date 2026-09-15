/**
 * @module setup-wizard
 *
 * The setup flow's questions, and the rule for what a set of answers is allowed
 * to write (#447).
 *
 * Pure: no React, no Ink, no `node:fs`, no `loadConfig`. Everything it needs to
 * know about the world arrives in a {@link SetupContext}, which is what lets the
 * whole question set be built and its answers decoded in a unit test without a
 * terminal or a provider key. The two hosts — the REPL's `/setup` and the
 * standalone `bernard setup` — differ only in who renders the spec.
 *
 * ## Two stages, because the model list depends on the provider
 *
 * `WizardSpec.steps` is a frozen array with no branching, so this exports two
 * specs rather than one. Stage A settles the provider and its key; stage B is
 * built afterwards, against a provider that is now known and a config that now
 * loads. Back does not cross the boundary, which is the honest behaviour:
 * changing provider invalidates every model answer after it.
 *
 * ## The rule that matters: only what changed is written
 *
 * `loadConfig` resolves a setting as `prefs.X ?? env ?? DEFAULT`, so writing a
 * value into the profile permanently shadows the matching `BERNARD_*` variable
 * (`CLAUDE.md`, Settings Profiles). Every step here opens on the EFFECTIVE
 * value, which for an unset field is the environment's or the built-in default.
 * Saving all of them back would therefore take every variable the user had set,
 * freeze its current value into the profile, and leave the variable dead — a
 * setting nobody touched, changed forever, by a wizard they only walked.
 *
 * So {@link settingsPatch} emits a key only when its answer differs from the one
 * the step opened with. Unchanged means unwritten, which leaves an inherited
 * field inherited. `ProfileSettings` is a merge patch (`saveActiveSettings`), so
 * an absent key is untouched rather than cleared.
 *
 * The cost of that rule, stated rather than discovered: there is no way here to
 * RESET a field back to inheriting. `/options` and `bernard reset-option` own
 * that, and a wizard row that meant "unset" would have to be distinguishable
 * from "leave alone", which is a third state these answers cannot carry.
 */

import {
  WIZARD_CATEGORIES_DATA,
  type WizardCategoryData,
  type WizardFieldData,
} from './profiles-wizard-data.js';
import type { ProfileSettings } from './profiles.js';
import type { WizardAnswer, WizardSpec, WizardStep } from './ui/overlays/wizard-types.js';

/** A provider the user can pick, and whether a key is already stored for it. */
export interface SetupProvider {
  name: string;
  hasKey: boolean;
  custom: boolean;
  /**
   * The last few characters of the stored key, so a reader can tell WHICH key
   * is in place — the fact a tick alone cannot carry when you have rotated one
   * or hold several accounts.
   *
   * A suffix rather than a prefix: provider keys are prefixed by scheme and
   * project (`sk-ant-api03-…`), so the leading characters are the part that is
   * the same across every key you own.
   */
  keyHint?: string;
}

/**
 * Everything the question set needs to know about the installation.
 *
 * Injected rather than read, so the builder has no edge to `keys.json`, the
 * model catalog or `lineups.json` — the same reason `profiles-wizard-data.ts`
 * describes a dynamic list by its `source` instead of carrying a thunk.
 */
export interface SetupContext {
  /**
   * The EFFECTIVE value of every setting: the profile's where it has one, the
   * environment's or the built-in default otherwise. This is what each step
   * opens on, and what {@link settingsPatch} compares against.
   */
  current: Readonly<Partial<ProfileSettings>>;
  /**
   * Keys the active profile sets explicitly, as opposed to inheriting. Drives
   * the provenance note only — the write rule is change detection, not this.
   */
  explicit: ReadonlySet<keyof ProfileSettings>;
  providers: readonly SetupProvider[];
  /** Models offered for the provider chosen in stage A. */
  models: readonly string[];
  lineups: readonly { id: string; name: string }[];
  /** `process.env`, injected so provenance is testable without mutating it. */
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * One question, plus how to read its answer back.
 *
 * `decode` returns a PATCH rather than a value because one step can decide two
 * settings: Tool mode's third option is `skipPermissions`, and asking about it
 * on its own screen would let a user set a mode and then contradict it.
 */
export interface SetupStep {
  key: keyof ProfileSettings;
  /** The answer this step opens with — the change test in {@link settingsPatch}. */
  initial: WizardAnswer;
  decode: (answer: WizardAnswer) => Partial<ProfileSettings>;
}

export interface SetupStageSpec {
  spec: WizardSpec;
  steps: SetupStep[];
}

/**
 * The welcome page, in the second person and without jargon.
 *
 * `[]` entries are blank rows. Deliberately short: it is the first thing
 * anybody sees and its job is to say what this is and what is about to happen,
 * not to document the product. Every noun named here is something the reader
 * will meet within the next few minutes.
 */
export const WELCOME_BODY: readonly string[] = [
  'Bernard is an AI agent that runs on your machine and works with your own tools — your shell, your files, the web, and whatever else you connect to it.',
  '',
  'It remembers what you tell it between sessions, can build small web apps for you, run jobs on a schedule, and watch for things worth telling you about.',
  '',
  'Setup has two parts: your providers and their API keys, then the settings. Every question opens on its current value, so you can move straight past it — and only what you change is saved. Esc stops at any point.',
];

/** Shown once the questions start, so the day-one commands land after the tour. */
export const WELCOME_FOOTER = 'Once you are in: /help lists everything, /setup reopens this.';

/** How the wizard spells a boolean. One place, so a decode cannot miss a variant. */
const ON = 'On';
const OFF = 'Off';

/** The Tool mode row that means `skipPermissions`, as `/agent-options` spells it. */
const UNRESTRICTED = 'unrestricted';

/**
 * Where a value is coming from right now, in a few words.
 *
 * The env case is the one that earns its place: it is the only way a reader can
 * see, while looking at the question, that answering it differently will take a
 * variable out of play for good.
 */
export function provenanceNote(field: WizardFieldData, ctx: SetupContext): string {
  const shown = ctx.current[field.key];
  // Spoken in the vocabulary of the rows below it. A boolean step offers On and
  // Off, and a note reading "Currently false" makes the reader translate
  // between two spellings of one answer to work out which row is live.
  const value =
    shown === undefined || shown === ''
      ? '(unset)'
      : field.field.kind === 'boolean'
        ? shown === true
          ? ON
          : OFF
        : String(shown);
  if (ctx.explicit.has(field.key)) return `Currently ${value}, saved in this profile.`;
  if (field.envVar !== undefined && ctx.env[field.envVar] !== undefined) {
    return `Currently ${value}, from ${field.envVar} — changing it here will override that.`;
  }
  // "(recommended)" rather than "(default)". Both are true, and only one is
  // useful to a reader deciding whether to touch it: "default" says where the
  // value came from, which they can already see, while "recommended" answers the
  // question they are actually asking. The other two branches keep saying where
  // a value came from, because a stored answer and an inherited variable are
  // both things the reader may want to go and change elsewhere.
  return `Currently ${value} (recommended).`;
}

/** The label a list step shows for a stored value, or `''` when nothing matches. */
function labelFor(options: readonly { value: string; label: string }[], value: unknown): string {
  if (value === undefined || value === null) return '';
  const hit = options.find((o) => o.value === String(value));
  return hit ? hit.label : '';
}

function stepHint(field: WizardFieldData, ctx: SetupContext): string {
  return `${field.description} ${provenanceNote(field, ctx)}`;
}

/** The options a `dynamic` field resolves to against this installation. */
/** A row a choice step can render: the two mandatory halves, plus an optional
 *  sentence about what picking it costs. Widened from `{value,label}` so a
 *  `dynamic` source and a declared `list` produce the same shape and `buildStep`
 *  needs no branch to read a note off one and not the other. */
type Option = { value: string; label: string; description?: string };

function dynamicOptions(field: WizardFieldData, ctx: SetupContext): Option[] {
  const kind = field.field;
  if (kind.kind !== 'dynamic') return [];
  switch (kind.source) {
    case 'provider':
      return ctx.providers.map((p) => ({
        value: p.name,
        label: `${p.name}${p.custom ? ' (custom)' : ''}${p.hasKey ? ' — key set' : ''}`,
      }));
    case 'model': {
      const rows = ctx.models.map((m) => ({ value: m, label: m }));
      const inUse = String(ctx.current.model ?? '');
      // The catalog is known-incomplete in BOTH directions — `grok-3-mini`
      // dispatches and is in no snapshot, `grok-4.1-fast-reasoning` is in the
      // snapshot and returns `not_found` — so the model in force can be absent
      // from its own list. Offered back rather than dropped: without it the step
      // opens on no row, and a reader who takes the page at face value trades a
      // model that works for whatever the catalog happened to list first.
      //
      // Only when the catalog answered at all. An empty list is "we could not
      // read it", and a one-row page is a screen that costs a keystroke and
      // decides nothing.
      if (rows.length > 0 && inUse !== '' && !rows.some((r) => r.value === inUse)) {
        rows.unshift({ value: inUse, label: `${inUse} — in use, not in the catalog` });
      }
      return rows;
    }
    case 'lineup':
      return ctx.lineups.map((l) => ({
        value: l.id,
        label: l.name === l.id ? l.id : `${l.name} (${l.id})`,
      }));
  }
}

/**
 * Turn one declared field into a question and its decoder.
 *
 * Every branch encodes its answer as a STRING — a label for the list kinds, the
 * typed text for the rest — so `WizardAnswer` stays `string | string[]` and this
 * module keeps its own domain out of the type every `ask_user` batch is built
 * from. The label-to-value map lives in the closure, which is also what lets the
 * provider step annotate a row (`anthropic — key set`) without the annotation
 * leaking into what gets saved.
 */
function buildStep(
  field: WizardFieldData,
  category: WizardCategoryData,
  ctx: SetupContext,
): { step: WizardStep; setup: SetupStep } | null {
  const kind = field.field;
  const base = {
    id: field.key,
    section: category.title,
    question: field.label,
    hint: stepHint(field, ctx),
    summary: field.label,
  };
  const current = ctx.current[field.key];

  if (kind.kind === 'list' || kind.kind === 'dynamic') {
    const options: Option[] = kind.kind === 'list' ? kind.options : dynamicOptions(field, ctx);
    // A field with nothing to choose from is not a question. Reachable for real:
    // a lineup list before any lineup exists, or a model list when the catalog
    // could not be read.
    if (options.length === 0) return null;
    // Tool mode folds `skipPermissions` in as a third row, so its stored value
    // is not simply `current`.
    const isToolMode = field.key === 'toolMode';
    const effective =
      isToolMode && ctx.current.skipPermissions === true ? UNRESTRICTED : (current ?? '');
    const initial = labelFor(options, effective);
    // Notes reach the screen. The registry has carried a `description` per
    // option since it was written and nothing rendered it, so the one row that
    // dissolves every permission gate said so only in the source.
    const notes: Record<string, string> = {};
    for (const o of options) if (o.description !== undefined) notes[o.label] = o.description;
    return {
      step: {
        ...base,
        field: {
          kind: 'choice',
          choices: options.map((o) => o.label),
          ...(Object.keys(notes).length > 0 ? { notes } : {}),
        },
        initial,
      },
      setup: {
        key: field.key,
        initial,
        decode: (answer) => {
          const value = options.find((o) => o.label === answer)?.value;
          if (value === undefined) return {};
          if (isToolMode) {
            // Both keys, always. Writing only the one that changed would let a
            // move away from `unrestricted` leave `skipPermissions: true`
            // standing, which reads as a mode that is set and not in force.
            return value === UNRESTRICTED
              ? { toolMode: 'write', skipPermissions: true }
              : { toolMode: value as ProfileSettings['toolMode'], skipPermissions: false };
          }
          return { [field.key]: value } as Partial<ProfileSettings>;
        },
      },
    };
  }

  if (kind.kind === 'boolean') {
    const initial = current === true ? ON : current === false ? OFF : '';
    return {
      step: { ...base, field: { kind: 'choice', choices: [ON, OFF] }, initial },
      setup: {
        key: field.key,
        initial,
        decode: (answer) => ({ [field.key]: answer === ON }) as Partial<ProfileSettings>,
      },
    };
  }

  if (kind.kind === 'text') {
    const initial = current === undefined || current === null ? '' : String(current);
    return {
      // Optional: a blank voice name is a real answer ("use the backend's own").
      step: { ...base, field: { kind: 'text' }, optional: true, initial },
      setup: {
        key: field.key,
        initial,
        decode: (answer) => ({ [field.key]: String(answer) }) as Partial<ProfileSettings>,
      },
    };
  }

  const initial = current === undefined || current === null ? '' : String(current);
  // A numeric setting with no current value — `voiceRate` is the live case, since
  // `BernardConfig` leaves it `undefined` until someone sets one. Without this
  // the step opens blank, Enter is refused by the range check, and the walk
  // CANNOT PROCEED: the only way past is to type a number, i.e. to set a value
  // the user never wanted, which is the write-what-nobody-asked-for failure this
  // whole flow is shaped to avoid. Found by walking it.
  const unset = initial === '';
  const validate = (answer: WizardAnswer): string | undefined => {
    const text = String(answer).trim();
    if (text === '' && unset) return undefined;
    if (kind.kind === 'int') {
      const parsed = Number.parseInt(text, 10);
      // The round-trip is what rejects `12abc`, which `parseInt` happily reads
      // as 12 — the check `pickWizardField` already makes, kept.
      if (!Number.isFinite(parsed) || String(parsed) !== text) {
        return `Enter a whole number between ${kind.min} and ${kind.max}.`;
      }
      if (parsed < kind.min || parsed > kind.max) {
        return `Out of range — enter a whole number between ${kind.min} and ${kind.max}.`;
      }
      return undefined;
    }
    const parsed = Number.parseFloat(text);
    if (!Number.isFinite(parsed)) return 'Enter a number between 0 and 1.';
    if (parsed < 0 || parsed > 1) return 'Out of range — enter a number between 0 and 1.';
    return undefined;
  };
  return {
    step: { ...base, field: { kind: 'text' }, initial, optional: unset, validate },
    setup: {
      key: field.key,
      initial,
      decode: (answer) => {
        const text = String(answer).trim();
        const parsed = kind.kind === 'int' ? Number.parseInt(text, 10) : Number.parseFloat(text);
        return Number.isFinite(parsed) ? ({ [field.key]: parsed } as Partial<ProfileSettings>) : {};
      },
    },
  };
}

/** Stage A's own sections, in walk order. Stage B shows them done. */
const PROVIDER_SECTIONS = ['Welcome', 'Providers'];

/**
 * Stage B's sections, derived from the registry rather than written out again.
 *
 * A hand-written copy is a second list of the same thing, and the failure is
 * silent: a new category appears in the walk and never in the rail, so the
 * reader is told there are fewer sections left than there are.
 */
function settingsSections(): string[] {
  return WIZARD_CATEGORIES_DATA.filter((c) => c.fields.some((f) => !STAGE_A_KEYS.has(f.key))).map(
    (c) => c.title,
  );
}

/** Fields stage A settles, so stage B does not ask about them again. */
const STAGE_A_KEYS: ReadonlySet<keyof ProfileSettings> = new Set(['provider']);

/**
 * Stage A: which provider, and its key.
 *
 * Hand-built rather than derived from the registry because the key is not a
 * `ProfileSettings` field at all — it lives in `keys.json` — and because this is
 * the one stage that must run before `loadConfig` can succeed.
 */
/**
 * What each built-in provider gets you, in as few words as carry the point.
 *
 * The model family, not a pitch: a reader choosing a default is choosing between
 * families, and `anthropic` / `openai` / `xai` name the vendors rather than the
 * thing being chosen. A custom provider gets none — we know only what the user
 * told us, which is already its name.
 */
const PROVIDER_BLURBS: Record<string, string> = {
  anthropic: 'Claude models',
  openai: 'GPT models',
  xai: 'Grok models',
};

/** The row that leaves the provider hub. Compared by the flow, so it is shared. */
export const PROVIDERS_DONE = 'Continue to the next step';

/** Welcome, on its own so the hub can be re-shown without repeating it. */
export function buildWelcomeSpec(): WizardSpec {
  return {
    title: 'Welcome',
    skipReview: true,
    steps: [
      {
        id: 'welcome',
        section: 'Welcome',
        question: 'Welcome to Bernard',
        field: { kind: 'info', body: [...WELCOME_BODY] },
        nextLabel: 'Start setup',
      },
    ],
    railContext: { after: ['Providers', ...settingsSections()] },
  };
}

/**
 * The provider hub: every provider, what it has, and a way onward.
 *
 * A LIST rather than a page per provider. The page-each version asked about
 * three providers in a row when almost everyone wants one, gave no view of the
 * set, and made "which of these am I actually using" a thing you had to
 * remember across screens. Here the state is the screen.
 *
 * Re-built on every pass through the flow's loop, which is what keeps the ticks
 * and the key hints true: they describe what is on disk NOW, not what was there
 * when the wizard opened.
 */
export function buildProviderHubSpec(ctx: SetupContext): WizardSpec {
  // The label is the provider and nothing else — it is the answer vocabulary,
  // and a decoder that had to strip a decorated suffix back off would be a
  // second copy of the formatting. Status is right-aligned detail instead.
  const rows = ctx.providers.map((p) => `${p.name}${p.custom ? '  (custom)' : ''}`);
  const trailing: Record<string, { text: string; tick?: boolean }> = {};
  ctx.providers.forEach((p, i) => {
    trailing[rows[i]] = p.hasKey
      ? { text: p.keyHint === undefined ? 'key set' : `····${p.keyHint}`, tick: true }
      : { text: 'no key' };
  });
  return {
    title: 'Providers',
    skipReview: true,
    // Back returns to the welcome. Without this the control is simply absent on
    // a single-step spec, which is four of setup's five screens.
    backExits: true,
    steps: [
      {
        id: 'providers',
        section: 'Providers',
        question: 'Which providers should Bernard be able to use?',
        // No mention of lineups or tiers: this screen is about keys, and a
        // reader here has not met either idea yet — the lineup question comes
        // two sections later and explains itself.
        hint: 'Pick one to add or replace its key. You need at least one, and you can add more.',
        field: {
          kind: 'choice',
          choices: rows,
          actions: [PROVIDERS_DONE],
          trailing,
          // Picking IS the act here: Enter opens that provider's key rather than
          // marking it as an answer to come back and confirm.
          pickAdvances: true,
        },
      },
    ],
    railContext: { before: ['Welcome'], after: settingsSections() },
  };
}

/** Which provider a hub row names, or `null` for the row that moves on. */
export function providerFromHubRow(ctx: SetupContext, row: WizardAnswer): string | null {
  const text = String(row);
  if (text === PROVIDERS_DONE) return null;
  // Matched on the PREFIX rather than by re-deriving the whole decorated label:
  // the tick and the key hint are display, and a decoder that rebuilt them would
  // be a second copy of the formatting to keep in step.
  return ctx.providers.find((p) => text.startsWith(p.name))?.name ?? null;
}

/** One field: the key for the provider just picked out of the hub. */
export function buildKeyEntrySpec(
  ctx: SetupContext,
  provider: string,
): { spec: WizardSpec; decode: (answers: readonly WizardAnswer[]) => string } {
  const known = ctx.providers.find((p) => p.name === provider);
  const hasKey = known?.hasKey === true;
  return {
    spec: {
      title: provider,
      skipReview: true,
      // Back and Esc mean the same thing on a page opened FROM the hub: return
      // to it.
      backExits: true,
      steps: [
        {
          id: `key:${provider}`,
          section: 'Providers',
          question: `API key for ${provider}`,
          hint: hasKey
            ? 'A key is already stored. Type a new one to replace it, or leave blank to keep it.'
            : 'Stored in keys.json with owner-only permissions. Never sent anywhere but the provider.',
          summary: `${provider} key`,
          field: { kind: 'text' },
          // Blank is always a valid answer here: it means "leave this provider
          // as it is". Esc returns to the hub, which is the same thing.
          optional: true,
          nextLabel: hasKey ? 'Keep the stored key' : 'Back to providers',
        },
      ],
      railContext: { before: ['Welcome'], after: settingsSections() },
    },
    decode: (answers) => (typeof answers[0] === 'string' ? answers[0].trim() : ''),
  };
}

/**
 * Which provider Bernard reaches for when nothing else names one.
 *
 * Its own wizard, built AFTER the keys are saved, and that is the whole reason
 * it is separate. `WizardSpec.steps` is frozen, so a page built alongside the
 * key pages cannot know what was typed into them — and this page has to know,
 * because a provider with no key cannot be a default and must be shown as
 * unpickable. Asked first, every row on a fresh install would be unpickable and
 * the reader would be stuck on a question with no valid answer.
 *
 * `null` when there is nothing to decide: with fewer than two keyed providers
 * the answer is forced, and a question whose answer is forced is a screen that
 * only costs a keystroke.
 */
export function buildDefaultProviderSpec(ctx: SetupContext): {
  spec: WizardSpec;
  decode: (answers: readonly WizardAnswer[]) => string;
} | null {
  const keyed = ctx.providers.filter((p) => p.hasKey);
  if (keyed.length < 2) return null;

  const currentProvider = String(ctx.current.provider ?? '');
  const options = ctx.providers.map((p) => ({
    value: p.name,
    label: `${p.name}${p.custom ? '  (custom)' : ''}`,
  }));
  // What each provider actually gets you, beside its name. A reader choosing a
  // default is choosing between model families, and `anthropic` / `openai` /
  // `xai` name the vendors rather than the thing being chosen.
  const trailing: Record<string, { text: string; tick?: boolean }> = {};
  for (const p of ctx.providers) {
    const label = options.find((o) => o.value === p.name)?.label;
    const note = p.hasKey ? PROVIDER_BLURBS[p.name] : 'no key';
    if (label !== undefined && note !== undefined) trailing[label] = { text: note };
  }
  // Keyed by LABEL because that is the answer vocabulary — the same map the
  // renderer greys and the same one it reads a reason out of.
  const unavailable: Record<string, string> = {};
  for (const p of ctx.providers) {
    if (p.hasKey) continue;
    const label = options.find((o) => o.value === p.name)?.label;
    if (label !== undefined) {
      unavailable[label] = `${p.name} has no key stored, so it cannot be the default.`;
    }
  }

  return {
    spec: {
      title: 'Providers',
      backExits: true,
      // One question, so Continue commits it. The review is a check-your-ANSWERS
      // screen; over a single answer it is the page you just left, restated as
      // `Default provider — xai` with the blurbs and the greyed rows that made
      // the choice legible stripped out. It cost a keystroke to confirm
      // something nobody had stopped seeing.
      skipReview: true,
      steps: [
        {
          id: 'provider',
          section: 'Providers',
          question: 'Which one should Bernard reach for by default?',
          hint: 'Lineups can still mix providers per tier — this is the fallback when nothing else names one.',
          field: { kind: 'choice', choices: options.map((o) => o.label), unavailable, trailing },
          initial: labelFor(options, currentProvider),
        },
      ],
      railContext: { before: ['Welcome'], after: settingsSections() },
    },
    decode: (answers) => options.find((o) => o.label === answers[0])?.value ?? currentProvider,
  };
}

/**
 * Stage B: every remaining setting, in walk order, each opening on its current
 * value.
 *
 * Flat — no per-category Configure / Use defaults / Skip gate. A gate skips past
 * exactly the questions a walkthrough exists to weigh, and costs a screen per
 * category of its own. Group titles ride on each question instead, so the walk
 * still reads as sections.
 */
export function buildSettingsSpec(ctx: SetupContext): SetupStageSpec {
  const steps: WizardStep[] = [];
  const setup: SetupStep[] = [];
  for (const category of WIZARD_CATEGORIES_DATA) {
    for (const field of category.fields) {
      if (STAGE_A_KEYS.has(field.key)) continue;
      const built = buildStep(field, category, ctx);
      if (built === null) continue;
      steps.push(built.step);
      setup.push(built.setup);
    }
  }
  return {
    spec: {
      intro:
        'Each question opens on its current value, so Continue keeps it. Enter picks a different one.',
      title: 'Settings',
      // Back off question one returns to the provider stage rather than leaving
      // the reader with no way out but Esc.
      backExits: true,
      steps,
      railContext: { before: PROVIDER_SECTIONS },
    },
    steps: setup,
  };
}

/**
 * The settings to write: only those whose answer differs from the one their step
 * opened with.
 *
 * The env-shadowing guard, and the reason it is a pure function with its own
 * test. An answer equal to its initial produces no key at all, so a field the
 * user walked past keeps inheriting from the environment or the default.
 */
export function settingsPatch(
  steps: readonly SetupStep[],
  answers: readonly WizardAnswer[],
): Partial<ProfileSettings> {
  const patch: Partial<ProfileSettings> = {};
  steps.forEach((step, i) => {
    const answer = answers[i];
    if (answer === undefined) return;
    if (sameAnswer(answer, step.initial)) return;
    Object.assign(patch, step.decode(answer));
  });
  return patch;
}

function sameAnswer(a: WizardAnswer, b: WizardAnswer): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a.trim() === b.trim();
}
