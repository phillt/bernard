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
          "Which company's AI Bernard talks to. Each one has its own models, prices and API key.",
        field: { kind: 'dynamic', source: 'provider' },
        envVar: 'BERNARD_PROVIDER',
      },
      {
        key: 'model',
        label: 'Default model',
        description:
          'The model Bernard uses when nothing else picks one. Bigger models think better and cost more.',
        field: { kind: 'dynamic', source: 'model' },
        envVar: 'BERNARD_MODEL',
      },
      {
        key: 'activeLineupId',
        label: 'Active lineup',
        description:
          'A named set of models — a strong one for hard work, a cheap one for small jobs. Lets Bernard spend less without you choosing a model each time.',
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
        // get one. The sentence above carries it instead, and names all three
        // rows so each one is already explained by the time it is read.
        description:
          'Whether Bernard works out a plan before it starts. Planning pays off on a job with several steps and wastes a call on a simple question. Auto decides per message, On always plans first, Off never does.',
        field: {
          kind: 'list',
          options: [
            { value: 'auto', label: 'Auto' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ],
        },
        envVar: 'BERNARD_COORDINATOR_MODE',
      },
      {
        key: 'modelMode',
        label: 'Model mode',
        description:
          'How much Bernard spends across its own internal calls. Most of them are small jobs a cheap model does just as well.',
        field: {
          kind: 'list',
          options: [
            { value: 'off', label: 'Off (single model)' },
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
          'Have sub-agents plan, work, then check their own output. Catches mistakes before they reach you, and costs extra calls.',
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
          'Optimizes your message for the model that will answer it, before it is sent. Costs one small call each turn.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_PROMPT_REWRITER',
      },
      {
        key: 'recallFilter',
        label: 'Recall filter',
        description:
          'Pull up more of your saved facts, then let a cheap model keep only the ones that matter. Stops unrelated memories crowding the answer.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_RECALL_FILTER',
      },
      {
        key: 'referenceLookup',
        label: 'Reference lookup',
        description:
          'When you mention someone Bernard does not know, let it check a tool such as your contacts before asking you.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_REFERENCE_LOOKUP',
      },
      {
        key: 'memoryConsolidation',
        label: 'Memory consolidation',
        description:
          'At the end of a session, suggest saved notes that look finished. Without it, memory only ever grows.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_MEMORY_CONSOLIDATION',
      },
      {
        key: 'specialistRecall',
        label: 'Specialist recall',
        description:
          'Let each specialist keep notes from its own work, so it stops repeating the same mistake.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_SPECIALIST_RECALL',
      },
      {
        key: 'scratchSubjectThreshold',
        label: 'Scratch subject-change threshold',
        description:
          'How different a new message has to be before Bernard drops its working notes. Lower keeps context for longer.',
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
        description:
          'Whether Bernard may change things without asking. Read-only blocks writes until you allow them.',
        field: {
          kind: 'list',
          options: [
            { value: 'read-only', label: 'Read-only (least privilege)' },
            { value: 'write', label: 'Write (allow all tools)' },
            {
              value: 'unrestricted',
              label: '⚠ Unrestricted (no permission checks)',
              // `toolModePolicy` short-circuits on `skipPermissions` BEFORE every
              // other rule, so this does not merely relax the confirm gate — it
              // makes the confirm-mode answer inert. Said on the row, because
              // the two questions are asked on separate screens and nothing else
              // connects them.
              description: 'Dissolves both gates — your confirm-mode answer stops applying.',
            },
          ],
        },
        envVar: 'BERNARD_TOOL_MODE',
        covers: ['skipPermissions'],
      },
      {
        key: 'confirmMode',
        label: 'Confirm mode',
        description:
          'When Bernard stops to ask before doing something risky. Ignored entirely when tool mode is unrestricted.',
        field: {
          kind: 'list',
          options: [
            { value: 'auto', label: 'Auto (high-risk only)' },
            { value: 'strict', label: 'Strict (also medium-risk)' },
            { value: 'off', label: 'Off (never prompt)' },
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
          'What a message from another program may do. Ask me shows it and one keystroke acts on it.',
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
        description: 'Keep answers as short as the question allows.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_CONCISE_MODE',
      },
      {
        key: 'responseStyle',
        label: 'Response style',
        description: 'The shape of an answer — how long, how detailed, what tone.',
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
          "Show what each tool was called with and what came back. Useful when you want to check Bernard's work.",
        field: { kind: 'boolean' },
        envVar: 'BERNARD_TOOL_DETAILS',
      },
      {
        key: 'theme',
        label: 'Theme',
        description: 'Which colors the terminal uses.',
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
        description: 'Read each answer out loud.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_VOICE',
      },
      {
        key: 'voiceNormalizer',
        label: 'Natural speech',
        description:
          'Rewrite the answer so it sounds right spoken — links named, numbers read properly, no markdown read aloud.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_VOICE_NORMALIZER',
      },
      {
        key: 'voiceBackend',
        label: 'Voice backend',
        description: 'Which program does the speaking. Auto finds one that is already installed.',
        field: {
          kind: 'list',
          options: VOICE_BACKEND_VALUES.map((b) => ({ value: b, label: b })),
        },
        envVar: 'BERNARD_VOICE_BACKEND',
      },
      {
        key: 'voiceVoice',
        label: 'Voice name',
        description: "Which voice to speak in. Leave blank for the backend's own.",
        field: { kind: 'text' },
        envVar: 'BERNARD_VOICE_VOICE',
      },
      {
        key: 'voiceRate',
        label: 'Speech rate (wpm)',
        description: 'How fast Bernard speaks, in words per minute.',
        field: { kind: 'int', min: 50, max: 500 },
        envVar: 'BERNARD_VOICE_RATE',
      },
      {
        key: 'voiceWarmupMs',
        label: 'Audio warmup (ms)',
        description:
          'Plays a moment of silence first, so the first word is not cut off. Linux only; 0 turns it off.',
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
          'Save a new specialist by itself once Bernard is confident enough, instead of asking you.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_CREATE_SPECIALISTS',
      },
      {
        key: 'autoCreateApplets',
        label: 'Auto-create applets',
        description: 'Offer to build a small app when the same task keeps coming back.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_CREATE_APPLETS',
      },
      {
        key: 'autoOpenApplets',
        label: 'Open new applets',
        description: 'Open a new applet in your browser as soon as it is built.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_OPEN_APPLETS',
      },
      {
        key: 'autoStyleApplets',
        label: 'Style new applets',
        description:
          'Run a design pass over a new applet, so it does not arrive looking unfinished.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_STYLE_APPLETS',
      },
      {
        key: 'appletPlanning',
        label: 'Plan applets before building',
        description: 'Work out what an applet needs before writing any of it. Fewer rebuilds.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_APPLET_PLANNING',
      },
      {
        key: 'autoCreateThreshold',
        label: 'Auto-create threshold',
        description:
          'How sure Bernard has to be before doing any of the above on its own. Higher means it asks you more often.',
        field: { kind: 'float01' },
        envVar: 'BERNARD_AUTO_CREATE_THRESHOLD',
      },
      {
        key: 'autoUpdate',
        label: 'Auto-update',
        description: 'Install a new version of Bernard at startup when one is available.',
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
        description: `Integer 1-${MAX_CONCURRENT_AGENTS_LIMIT}.`,
        field: { kind: 'int', min: 1, max: MAX_CONCURRENT_AGENTS_LIMIT },
        envVar: 'BERNARD_MAX_CONCURRENT_AGENTS',
      },
      {
        key: 'maxSteps',
        label: 'Max agent steps per turn',
        description:
          'How many times Bernard may call the model to finish one turn. Higher handles bigger jobs and costs more.',
        field: { kind: 'int', min: 1, max: 200 },
        envVar: 'BERNARD_MAX_STEPS',
      },
      {
        key: 'maxTokens',
        label: 'Max response tokens',
        description: 'The longest answer the model may write in one go.',
        field: { kind: 'int', min: 256, max: 200_000 },
        envVar: 'BERNARD_MAX_TOKENS',
      },
      {
        key: 'shellTimeout',
        label: 'Shell timeout (ms)',
        description: 'How long a shell command may run before Bernard gives up on it.',
        field: { kind: 'int', min: 1_000, max: 600_000 },
        envVar: 'BERNARD_SHELL_TIMEOUT',
      },
      {
        key: 'tokenWindow',
        label: 'Context window override',
        description:
          'How much Bernard can hold in mind at once. 0 reads the real limit from the model.',
        field: { kind: 'int', min: 0, max: 2_000_000 },
        envVar: 'BERNARD_TOKEN_WINDOW',
      },
    ],
  },
];

/** Every declared field, in walk order. */
export const WIZARD_FIELDS: WizardFieldData[] = WIZARD_CATEGORIES_DATA.flatMap((c) => c.fields);
