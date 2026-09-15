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
        description: 'Which API Bernard talks to.',
        field: { kind: 'dynamic', source: 'provider' },
        envVar: 'BERNARD_PROVIDER',
      },
      {
        key: 'model',
        label: 'Default model',
        description:
          'Used directly when model mode is off; otherwise the lineup below decides per call site.',
        field: { kind: 'dynamic', source: 'model' },
        envVar: 'BERNARD_MODEL',
      },
      {
        key: 'activeLineupId',
        label: 'Active lineup',
        description: 'The role-and-tier ladder that resolves a model for every call site.',
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
        description: 'auto = qualifier picks; on = always ReAct; off = always Normal.',
        field: {
          kind: 'list',
          options: [
            { value: 'auto', label: 'Auto (qualifier picks per turn)' },
            { value: 'on', label: 'On (always coordinator)' },
            { value: 'off', label: 'Off (always normal)' },
          ],
        },
        envVar: 'BERNARD_COORDINATOR_MODE',
      },
      {
        key: 'modelMode',
        label: 'Model mode',
        description: 'How to assign provider models across the various LLM call sites.',
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
        description: 'Run sub-agent dispatch through Planner → Actor → Critic.',
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
        description: 'Restructure your prompt for the active model family before each turn.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_PROMPT_REWRITER',
      },
      {
        key: 'recallFilter',
        label: 'Recall filter',
        description: 'Widen memory retrieval, then have a cheap model keep only what is relevant.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_RECALL_FILTER',
      },
      {
        key: 'referenceLookup',
        label: 'Reference lookup',
        description: 'Try a read-only tool lookup before prompting for unknown references.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_REFERENCE_LOOKUP',
      },
      {
        key: 'memoryConsolidation',
        label: 'Memory consolidation',
        description: 'At session close, propose which saved notes could be retired.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_MEMORY_CONSOLIDATION',
      },
      {
        key: 'specialistRecall',
        label: 'Specialist recall',
        description: 'Let each specialist remember what it learned from its own dispatches.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_SPECIALIST_RECALL',
      },
      {
        key: 'scratchSubjectThreshold',
        label: 'Scratch subject-change threshold',
        description: 'Jaccard threshold 0-1 below which scratch is cleared on subject change.',
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
        description: 'Whether write tools are blocked behind an enable prompt.',
        field: {
          kind: 'list',
          options: [
            { value: 'read-only', label: 'Read-only (least privilege)' },
            { value: 'write', label: 'Write (allow all tools)' },
            {
              value: 'unrestricted',
              label: '⚠ Unrestricted (no permission checks)',
              description: 'Dissolves both the block gate and the confirmation gate.',
            },
          ],
        },
        envVar: 'BERNARD_TOOL_MODE',
        covers: ['skipPermissions'],
      },
      {
        key: 'confirmMode',
        label: 'Confirm mode',
        description: 'How aggressively to prompt before running risky tools.',
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
          'What `bernard say` may do. Ask me shows the message and one keystroke acts on it.',
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
        description: 'Default responses to the smallest sufficient size.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_CONCISE_MODE',
      },
      {
        key: 'responseStyle',
        label: 'Response style',
        description:
          'Default, detailed, short, step-by-step, simple, high-level, critical, or creative.',
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
        description: 'Show full tool call args and results in the transcript.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_TOOL_DETAILS',
      },
      {
        key: 'theme',
        label: 'Theme',
        description: 'Color scheme for terminal output.',
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
        description: 'Read each assistant response aloud.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_VOICE',
      },
      {
        key: 'voiceNormalizer',
        label: 'Natural speech',
        description: 'Rewrite the reply into something worth hearing before speaking it.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_VOICE_NORMALIZER',
      },
      {
        key: 'voiceBackend',
        label: 'Voice backend',
        description: 'auto probes what is installed; the rest pin one.',
        field: {
          kind: 'list',
          options: VOICE_BACKEND_VALUES.map((b) => ({ value: b, label: b })),
        },
        envVar: 'BERNARD_VOICE_BACKEND',
      },
      {
        key: 'voiceVoice',
        label: 'Voice name',
        description: 'Passed straight to the backend (e.g. Daniel, en-us+f3). Blank = its default.',
        field: { kind: 'text' },
        envVar: 'BERNARD_VOICE_VOICE',
      },
      {
        key: 'voiceRate',
        label: 'Speech rate (wpm)',
        description: 'Words per minute.',
        field: { kind: 'int', min: 50, max: 500 },
        envVar: 'BERNARD_VOICE_RATE',
      },
      {
        key: 'voiceWarmupMs',
        label: 'Audio warmup (ms)',
        description: 'Silence played first to wake a suspended sink. 0 = off. Linux only.',
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
        description: 'Promote pending specialist candidates that exceed the threshold.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_CREATE_SPECIALISTS',
      },
      {
        key: 'autoCreateApplets',
        label: 'Auto-create applets',
        description: 'Build applets Bernard suggests, above the same threshold.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_CREATE_APPLETS',
      },
      {
        key: 'autoOpenApplets',
        label: 'Open new applets',
        description: 'Open an applet in the browser as soon as it is built.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_OPEN_APPLETS',
      },
      {
        key: 'autoStyleApplets',
        label: 'Style new applets',
        description: 'Run the design pass over a new applet before opening it.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_STYLE_APPLETS',
      },
      {
        key: 'appletPlanning',
        label: 'Plan applets before building',
        description: 'Decide scope, controls and stored state before any HTML is written.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_APPLET_PLANNING',
      },
      {
        key: 'autoCreateThreshold',
        label: 'Auto-create threshold',
        description: 'Confidence threshold 0-1 (e.g. 0.8).',
        field: { kind: 'float01' },
        envVar: 'BERNARD_AUTO_CREATE_THRESHOLD',
      },
      {
        key: 'autoUpdate',
        label: 'Auto-update',
        description: 'Install a new Bernard version when one is found at startup.',
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
        description: 'How many LLM calls the agent loop can chain.',
        field: { kind: 'int', min: 1, max: 200 },
        envVar: 'BERNARD_MAX_STEPS',
      },
      {
        key: 'maxTokens',
        label: 'Max response tokens',
        description: 'Upper bound on tokens the model may generate per response.',
        field: { kind: 'int', min: 256, max: 200_000 },
        envVar: 'BERNARD_MAX_TOKENS',
      },
      {
        key: 'shellTimeout',
        label: 'Shell timeout (ms)',
        description: 'How long shell tool commands may run.',
        field: { kind: 'int', min: 1_000, max: 600_000 },
        envVar: 'BERNARD_SHELL_TIMEOUT',
      },
      {
        key: 'tokenWindow',
        label: 'Context window override',
        description: '0 = auto-detect from model.',
        field: { kind: 'int', min: 0, max: 2_000_000 },
        envVar: 'BERNARD_TOKEN_WINDOW',
      },
    ],
  },
];

/** Every declared field, in walk order. */
export const WIZARD_FIELDS: WizardFieldData[] = WIZARD_CATEGORIES_DATA.flatMap((c) => c.fields);
