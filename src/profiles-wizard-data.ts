/**
 * @module profiles-wizard-data
 *
 * Declarative shape of the settings wizard. The legacy `src/profiles-wizard.ts`
 * paired field metadata with readline-bound pickers; this module strips the
 * readline assumption and leaves a pure data tree so any UI host (the Ink REPL,
 * the standalone setup host, future hosts) can interpret the same categories.
 *
 * Two consumers today: `runProfileWizardInk` (`/profiles` → create) and
 * `src/setup-wizard.ts` (`bernard setup`, `/setup`, first run).
 *
 * ## It covers every settable field, and a test says so
 *
 * It used to cover 22 of `ProfileSettings`' 40 fields (#447). The other 18 were
 * not a considered exclusion — they were simply never added, so `provider`,
 * `model`, the active lineup, every voice setting and five behaviour toggles
 * were reachable from no wizard at all. The drift is silent by construction: a
 * field added to `ProfileSettings` works everywhere else and is merely absent
 * here, which nothing notices.
 *
 * So `src/settings-coverage.test.ts` walks `ProfileSettings`' keys and
 * fails on any that is neither declared here nor in a reasoned exclusion set —
 * the record-to-table direction, per `bundled-manifest.test.ts`. Adding a
 * preference is now a failing test until someone decides whether a user should
 * be asked about it.
 *
 * ## Why `envVar` is here
 *
 * `loadConfig` resolves a setting as `prefs.X ?? env ?? DEFAULT`, so writing a
 * value into the profile permanently shadows the matching variable. A wizard
 * that prepopulates from the effective value and saves everything back would
 * silently kill every `BERNARD_*` the user had set. The setup flow guards that
 * by persisting only what changed, and uses this field to SAY where a value is
 * coming from while the user is looking at it.
 */

import { MAX_CONCURRENT_AGENTS_LIMIT } from './tools/agent-pool.js';
import { RESPONSE_STYLE_IDS, type ResponseStyle } from './agent-prompt.js';
import { REMOTE_MESSAGE_MODES } from './remote-messages.js';
import { COORDINATOR_MODES } from './coordinator-modes.js';
import { TOOL_MODES } from './tool-modes.js';
import { THEMES } from './theme.js';
import { VOICE_BACKEND_VALUES } from './voice-service.js';
import type { ProfileSettings } from './profiles.js';

/**
 * A list whose options are only knowable at runtime — the installed providers,
 * the model catalog for the provider just chosen, the lineups on disk.
 *
 * Declared as a `source` rather than a thunk so this module stays a pure data
 * tree with no edge to the catalog, the lineup store or `keys.json`. The setup
 * flow resolves it (`src/setup-wizard.ts`); a host that cannot resolve it says
 * so instead of guessing.
 */
export type DynamicOptionSource = 'provider' | 'model' | 'lineup';

export type WizardFieldKind =
  | { kind: 'list'; options: Array<{ value: string; label: string; description?: string }> }
  | { kind: 'dynamic'; source: DynamicOptionSource }
  | { kind: 'text' }
  | { kind: 'boolean' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'float01' };

export interface WizardFieldData {
  key: keyof ProfileSettings;
  label: string;
  description: string;
  field: WizardFieldKind;
  /**
   * The environment variable this setting reads when the profile leaves it
   * unset. Absent means the setting is profile-only.
   */
  envVar?: string;
  /**
   * Other `ProfileSettings` keys this one step decides.
   *
   * One entry: Tool mode, whose third option (`unrestricted`) is
   * `skipPermissions`, exactly as `/agent-options` already presents it. Asking
   * about it twice would let a user set a mode and then contradict it on the
   * next screen.
   */
  covers?: Array<keyof ProfileSettings>;
}

export interface WizardCategoryData {
  id: string;
  title: string;
  description: string;
  fields: WizardFieldData[];
}

/** `on` / `off` as the wizard shows them, so one spelling reaches every step. */
export const BOOLEAN_LABELS = { on: 'On', off: 'Off' } as const;

export const WIZARD_CATEGORIES_DATA: WizardCategoryData[] = [
  {
    id: 'model',
    title: 'Model',
    description: 'Which model answers you, and which ladder the other call sites use.',
    fields: [
      {
        key: 'provider',
        label: 'Provider',
        description:
          "Which company's models Bernard sends your work to. Each has its own API key, its own prices and its own strengths. You are not locked in \u2014 a lineup can mix providers and a specialist can pin one \u2014 so this is the provider Bernard reaches for when nothing else names a model.",
        field: { kind: 'dynamic', source: 'provider' },
        envVar: 'BERNARD_PROVIDER',
      },
      {
        key: 'model',
        label: 'Default model',
        description:
          'The model Bernard falls back to when nothing else names one. A larger model reasons better on hard work and costs more per turn; a smaller one is faster and cheaper and gives up sooner. Model mode and lineups decide most calls, so this matters most when they are off.',
        field: { kind: 'dynamic', source: 'model' },
        envVar: 'BERNARD_MODEL',
      },
      {
        key: 'activeLineupId',
        label: 'Active lineup',
        description:
          'A named set of models: a strong one for hard work, a cheaper one for routine jobs, a cheap one for the small internal passes. It is what lets Bernard spend less without you choosing a model each turn. It does nothing while model mode is off, since every call then uses the default model.',
        field: { kind: 'dynamic', source: 'lineup' },
      },
    ],
  },
  {
    id: 'agent-behavior',
    title: 'Agent behavior',
    description: 'How a turn is planned, which models it spends, and how sub-agents run.',
    fields: [
      {
        key: 'coordinatorMode',
        label: 'Coordinator mode',
        // The rows are bare on purpose. They used to read "Auto (qualifier picks
        // per turn)" and "On (always coordinator)", which translated one piece
        // of jargon into another beside every option — a reader who does not
        // know what a coordinator is learns nothing from being told they always
        // get one. The sentence carries it instead.
        //
        // It has to do more than name the rows, because the question a reader
        // brings is "which of these is right for ME", and no list of examples
        // answers that — they will always be someone else's work. So it states
        // the trade itself: what planning buys, what it costs, and the one
        // condition under which the cost buys nothing. A reader who knows
        // whether their own work has several steps can then settle it, and the
        // two `Always` rows are the two ends of that same sentence.
        description:
          'On a task with several steps, coordinator mode makes the work markedly more reliable: Bernard works out a plan and holds itself to it. The cost is the extra turns and time that takes, and it buys nothing on work that was only ever one step. Auto turns it on when it sees a multi-step task.',
        // The shared table, not a second copy — see `coordinator-modes.ts`.
        field: { kind: 'list', options: [...COORDINATOR_MODES] },
        envVar: 'BERNARD_COORDINATOR_MODE',
      },
      {
        key: 'modelMode',
        label: 'Model mode',
        description:
          'Which rung of the lineup each internal call uses. Most of those calls are small jobs a cheap model does just as well, so spreading them out cuts cost with nothing visible lost. Balanced keeps the strong model for your own turns; optimize for token usage moves those down too; optimize for performance uses the strong one everywhere; off ignores the lineup.',
        field: {
          kind: 'list',
          options: [
            { value: 'off', label: 'Off' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'optimize-tokens', label: 'Optimize for token usage' },
            { value: 'optimize-performance', label: 'Optimize for performance' },
          ],
        },
        envVar: 'BERNARD_MODEL_MODE',
      },
      {
        key: 'subagentPac',
        label: 'Sub-agent PAC pipeline',
        description:
          'Whether a sub-agent plans, works, then checks its own output before handing it back. The extra pass catches mistakes that would otherwise reach you as a confident wrong answer, and costs two more model calls every time you delegate. Worth turning off only if you rarely do.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_SUBAGENT_PAC',
      },
    ],
  },
  {
    id: 'memory-context',
    title: 'Memory & context',
    description: 'The pre-turn passes, and what Bernard remembers between sessions.',
    fields: [
      {
        key: 'promptRewriter',
        label: 'Prompt rewriter',
        description:
          'Rewrites your message into the shape the answering model reads best, before it is sent. It costs one small call each turn and buys a better first answer, which is worth most if you type quickly or move between model families.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_PROMPT_REWRITER',
      },
      {
        key: 'recallFilter',
        label: 'Recall filter',
        description:
          'Bernard searches its saved facts before each turn. This widens that search and has a cheap model drop whatever is not relevant, so an unrelated memory cannot pull the answer off course. It costs one small call each turn; without it the narrower search is used instead.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_RECALL_FILTER',
      },
      {
        key: 'memoryConsolidation',
        label: 'Memory consolidation',
        description:
          'At the end of a session, look over the notes Bernard has saved and suggest which ones look finished. Nothing is removed without you \u2014 the list is shown next time you start. Left alone, memory only grows, and past a point the oldest notes stop reaching the model at all.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_MEMORY_CONSOLIDATION',
      },
      {
        key: 'specialistRecall',
        label: 'Specialist recall',
        description:
          'Lets each specialist keep notes from its own runs, so it stops repeating a mistake it has already made. The notes are private to that specialist and go when it does. It costs one small call per specialist at the end of a session.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_SPECIALIST_RECALL',
      },
      {
        key: 'scratchSubjectThreshold',
        label: 'Scratch subject-change threshold',
        description:
          'Bernard keeps working notes across turns and drops them when you change the subject. This is how close a new message has to be to the last one to count as the same subject. Higher drops the notes more readily, which keeps a new task clean; lower carries them further, which keeps a long one coherent.',
        field: { kind: 'float01' },
        envVar: 'BERNARD_SCRATCH_SUBJECT_THRESHOLD',
      },
    ],
  },
  {
    id: 'tool-safety',
    title: 'Tool safety',
    description: 'Read-only blocking and risk-based confirmation prompts.',
    fields: [
      {
        key: 'toolMode',
        label: 'Tool mode',
        // The rows are bare and the description names all three, which is the
        // treatment the coordinator question already got: a gloss in
        // parentheses translates one piece of jargon into another beside every
        // option, where a sentence above has room to say what each one means by
        // the time the reader reaches it.
        description:
          'How much Bernard can do on its own. Read-only lets it read anything and stops it changing anything until you say so. Write lets changes through, with a check first on the risky ones. Unrestricted removes every check.',
        // The shared table, not a fourth copy of it — see `tool-modes.ts` on the
        // three spellings this had already grown, one of them wrong.
        field: { kind: 'list', options: [...TOOL_MODES] },
        envVar: 'BERNARD_TOOL_MODE',
        covers: ['skipPermissions'],
      },
      {
        key: 'confirmMode',
        label: 'Confirm mode',
        // Bare rows for the same reason as its neighbour above. `Auto` alone
        // says nothing about a risk threshold, so the sentence has to name all
        // three — which it could not while each row carried two words of it.
        description:
          'How often Bernard checks with you before it acts. Auto asks only about the riskiest calls — a dangerous shell command, or anything that reaches outside your machine. Strict also asks before ordinary file writes. Off never asks. Ignored when tool mode is unrestricted.',
        field: {
          kind: 'list',
          options: [
            { value: 'auto', label: 'Auto' },
            { value: 'strict', label: 'Strict' },
            { value: 'off', label: 'Off' },
          ],
        },
        envVar: 'BERNARD_CONFIRM_MODE',
      },
      {
        // Beside the two tool gates rather than under Automation: those govern
        // what Bernard is allowed to BUILD unattended, and this governs what may
        // reach it as an instruction — the same question `toolMode` asks, one
        // channel over.
        key: 'remoteMessages',
        label: 'Messages from other processes',
        description:
          'What a message from another program on this machine may do. Ask me shows it and waits \u2014 one keystroke acts on it, so nothing runs unwatched. The other two let any local process that can write your state directory start a turn on its own, which is convenient for scripts and is a real grant.',
        // The shared table, not a fourth copy of it. Hand-written here the rows
        // had already disagreed with the menu's on arrival — which is the drift
        // `remote-messages.ts` says it exists to prevent, happening in the one
        // surface that could not import it while it lived under `src/ui/`.
        field: { kind: 'list', options: [...REMOTE_MESSAGE_MODES] },
      },
    ],
  },
  {
    id: 'output-style',
    title: 'Output style',
    description: 'Concise mode, response shape, tool-call verbosity, and color theme.',
    fields: [
      {
        key: 'conciseMode',
        label: 'Concise mode',
        description:
          'Keeps answers as short as the question allows. Off lets Bernard explain its reasoning and show its working, which is worth having while you are still learning what it does; on suits work where you already know what you asked for.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_CONCISE_MODE',
      },
      {
        key: 'responseStyle',
        label: 'Response style',
        description:
          'The shape of an answer rather than its length \u2014 how much structure, how much detail, what tone. Default adds nothing and lets the model answer as it would; the others trade some of that freedom for a predictable form, which helps when answers are read the same way every time.',
        field: {
          kind: 'list',
          options: RESPONSE_STYLE_IDS.map((id: ResponseStyle) => ({
            value: id,
            label: id,
          })),
        },
        envVar: 'BERNARD_RESPONSE_STYLE',
      },
      {
        key: 'toolDetails',
        label: 'Tool details',
        description:
          "Shows the arguments each tool was called with and what it returned. It is how you check Bernard's work rather than take it on trust, and it makes the transcript considerably noisier. Worth having on while you are still deciding whether to trust a tool.",
        field: { kind: 'boolean' },
        envVar: 'BERNARD_TOOL_DETAILS',
      },
      {
        key: 'theme',
        label: 'Theme',
        description:
          'Which colours the terminal uses. Pick high-contrast or colorblind if the defaults are hard to read; nothing but the colours changes.',
        field: {
          kind: 'list',
          options: Object.keys(THEMES).map((name) => ({ value: name, label: name })),
        },
      },
    ],
  },
  {
    id: 'voice',
    title: 'Voice',
    description: 'Spoken readback of each reply.',
    fields: [
      {
        key: 'voiceTts',
        label: 'Speak replies',
        description:
          'Reads each answer out loud as well as printing it, which is what makes Bernard usable while you are looking somewhere else. It speaks the last answer only, so anything that has scrolled past is not read back.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_VOICE',
      },
      {
        key: 'voiceNormalizer',
        label: 'Natural speech',
        description:
          'Rewrites an answer into how a person would say it \u2014 links named rather than spelled out, numbers read as what they are, no markup read aloud. It costs one small call per spoken reply. Off still strips the markup, so speech stays intelligible either way.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_VOICE_NORMALIZER',
      },
      {
        key: 'voiceBackend',
        label: 'Voice backend',
        description:
          'Which program does the speaking. Auto picks whichever is installed, which is the right answer unless you have more than one and want a particular voice from a particular one.',
        field: {
          kind: 'list',
          options: VOICE_BACKEND_VALUES.map((b) => ({ value: b, label: b })),
        },
        envVar: 'BERNARD_VOICE_BACKEND',
      },
      {
        key: 'voiceVoice',
        label: 'Voice name',
        description:
          'Which named voice the backend speaks in. Leave blank for its own default. The name is not checked here \u2014 a backend that does not recognise it simply says nothing \u2014 so try it after changing.',
        field: { kind: 'text' },
        envVar: 'BERNARD_VOICE_VOICE',
      },
      {
        key: 'voiceRate',
        label: 'Speech rate (wpm)',
        description:
          'How fast Bernard speaks, in words per minute. Higher gets through a long answer sooner and is harder to follow while your attention is elsewhere, which is where spoken replies are usually heard.',
        field: { kind: 'int', min: 50, max: 500 },
        envVar: 'BERNARD_VOICE_RATE',
      },
      {
        key: 'voiceWarmupMs',
        label: 'Audio warmup (ms)',
        description:
          'Plays a moment of silence before speaking, so a sleeping speaker is awake by the first word. Linux only \u2014 macOS and Windows keep audio devices ready. Raise it if words are still clipped; 0 turns it off.',
        field: { kind: 'int', min: 0, max: 5_000 },
        envVar: 'BERNARD_VOICE_WARMUP_MS',
      },
    ],
  },
  {
    id: 'automation',
    title: 'Automation',
    description: 'What Bernard is allowed to build or update without being asked each time.',
    fields: [
      {
        key: 'autoCreateSpecialists',
        label: 'Auto-create specialists',
        description:
          'When the same kind of work keeps coming back, Bernard can write a specialist for it. On, it saves one once it is confident enough; off, it offers and waits. The threshold below is what confident enough means.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_CREATE_SPECIALISTS',
      },
      {
        key: 'autoCreateApplets',
        label: 'Auto-create applets',
        description:
          'Whether Bernard offers to build a small web app when it notices the same task returning. It only ever offers \u2014 building one is still a turn you ask for \u2014 so this widens what gets suggested, not what gets made.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_CREATE_APPLETS',
      },
      {
        key: 'autoOpenApplets',
        label: 'Open new applets',
        description:
          'Opens a newly built applet in your browser as soon as it is ready. Turn it off where there is nothing to open, such as over SSH or on a machine with no display.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_OPEN_APPLETS',
      },
      {
        key: 'autoStyleApplets',
        label: 'Style new applets',
        description:
          'Runs a design pass over a new applet before it opens, so it does not arrive looking unmade. It costs one call at build time, and only on create \u2014 an applet whose page you supply is left exactly as written.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_STYLE_APPLETS',
      },
      {
        key: 'appletPlanning',
        label: 'Plan applets before building',
        description:
          'Works out what an applet should be \u2014 its screens, its controls, what it stores \u2014 before any of it is written. It costs three short calls up front and saves the rebuilds that come from deciding those things while writing the page.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_APPLET_PLANNING',
      },
      {
        key: 'autoCreateThreshold',
        label: 'Auto-create threshold',
        description:
          'How sure Bernard has to be before acting on any of the above by itself. Higher means it asks more often and surprises you less; lower means it acts more freely and will sometimes make something you did not want.',
        field: { kind: 'float01' },
        envVar: 'BERNARD_AUTO_CREATE_THRESHOLD',
      },
      {
        key: 'autoUpdate',
        label: 'Auto-update',
        description:
          'Installs a new version of Bernard at startup when one is available. On keeps you current without thinking about it; off keeps a version you have tested in place until you choose to move.',
        field: { kind: 'boolean' },
      },
    ],
  },
  {
    id: 'limits',
    title: 'Limits & performance',
    description: 'Step budget, parallelism, token limits, and shell timeout.',
    fields: [
      {
        key: 'maxConcurrentAgents',
        label: 'Max concurrent sub-agents',
        description:
          "How many sub-agents may run at once. More finishes a fan-out sooner, and multiplies how quickly you reach a provider's rate limit \u2014 which is what this bounds, rather than the amount of work itself.",
        field: { kind: 'int', min: 1, max: MAX_CONCURRENT_AGENTS_LIMIT },
        envVar: 'BERNARD_MAX_CONCURRENT_AGENTS',
      },
      {
        key: 'maxSteps',
        label: 'Max agent steps per turn',
        description:
          'How many times Bernard may call the model to finish one turn. Higher lets it see a long job through; lower caps what a single turn can cost you, and a turn that runs out stops mid-job and says so.',
        field: { kind: 'int', min: 1, max: 200 },
        envVar: 'BERNARD_MAX_STEPS',
      },
      {
        key: 'maxTokens',
        label: 'Max response tokens',
        description:
          'The longest single answer the model may write. Raising it lets a long piece of writing finish in one go; the cost is that a runaway answer runs further before anything stops it.',
        field: { kind: 'int', min: 256, max: 200_000 },
        envVar: 'BERNARD_MAX_TOKENS',
      },
      {
        key: 'shellTimeout',
        label: 'Shell timeout (ms)',
        description:
          'How long a shell command may run before Bernard gives up on it. Long enough for your slowest ordinary command, short enough that one which will never finish does not hold the whole turn.',
        field: { kind: 'int', min: 1_000, max: 600_000 },
        envVar: 'BERNARD_SHELL_TIMEOUT',
      },
      {
        key: 'tokenWindow',
        label: 'Context window override',
        description:
          'How much Bernard holds in mind before it compacts the conversation. 0 reads the real limit from the model, which is right unless your provider reports one Bernard cannot look up \u2014 set it by hand then.',
        field: { kind: 'int', min: 0, max: 2_000_000 },
        envVar: 'BERNARD_TOKEN_WINDOW',
      },
    ],
  },
];

/** Every declared field, in walk order. */
export const WIZARD_FIELDS: WizardFieldData[] = WIZARD_CATEGORIES_DATA.flatMap((c) => c.fields);
