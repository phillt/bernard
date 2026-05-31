/**
 * @module profiles-wizard
 *
 * Guided creation flow for settings profiles (#207). Reuses the existing UI
 * primitives `selectFromMenu` and `promptValue` from `src/menu.ts` — no new
 * components are introduced. Mirrors the `runAddProviderWizard` pattern in
 * `src/repl.ts` (Ctrl-C-safe via `createMenuSignal` / `clearMenuSignal`
 * passed in by the caller).
 *
 * The wizard never mutates the live `BernardConfig` or persists anything
 * mid-flight: it builds a draft `ProfileSettings` object and returns it to
 * the caller, which is responsible for `createProfile` + `switchActiveProfile`
 * + `applyProfileToConfig`. This keeps cancel/abort semantics clean — Esc at
 * any step leaves no trace.
 */

import * as readline from 'node:readline';
import {
  selectFromMenu,
  promptValue,
  type MenuEntry,
} from './menu.js';
import {
  validateProfileName,
  type ProfileSettings,
} from './profiles.js';
import {
  MAX_CONCURRENT_AGENTS_LIMIT,
} from './tools/agent-pool.js';
import {
  RESPONSE_STYLE_IDS,
  type ResponseStyle,
} from './agent-prompt.js';
import { THEMES } from './theme.js';

type ConfigureChoice = 'configure' | 'use-defaults' | 'skip';

/** A single tunable field inside a wizard category. */
export interface WizardField<T = unknown> {
  key: keyof ProfileSettings;
  label: string;
  description: string;
  /** Render the picker for this field. Resolves to the chosen value, or `undefined` if the user cancelled. */
  prompt: (rl: readline.Interface, current: T | undefined, signal: AbortSignal) => Promise<T | undefined>;
}

/** A category groups related fields so the user can configure or skip them as a unit. */
export interface WizardCategory {
  id: string;
  title: string;
  description: string;
  fields: WizardField<any>[];
}

interface WizardDeps {
  rl: readline.Interface;
  createSignal: () => AbortSignal;
  clearSignal: () => void;
}

/** Result of `runProfileWizard`. */
export type WizardResult =
  | { cancelled: true }
  | { cancelled: false; name: string; settings: ProfileSettings };

/* ------------------------------ field pickers ----------------------------- */

async function pickFromList<T extends string>(
  rl: readline.Interface,
  title: string,
  current: T | undefined,
  options: Array<{ value: T; label: string; description?: string }>,
  signal: AbortSignal,
): Promise<T | undefined> {
  const entries: MenuEntry[] = options.map((o) => ({
    label: o.label,
    description: o.description,
    active: current === o.value,
  }));
  const res = await selectFromMenu(rl, entries, { title }, signal);
  if (res.cancelled) return undefined;
  return options[res.index].value;
}

async function pickBoolean(
  rl: readline.Interface,
  title: string,
  current: boolean | undefined,
  signal: AbortSignal,
): Promise<boolean | undefined> {
  return pickFromList<'on' | 'off'>(
    rl,
    title,
    current === true ? 'on' : current === false ? 'off' : undefined,
    [
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ],
    signal,
  ).then((v) => (v === undefined ? undefined : v === 'on'));
}

async function pickInt(
  rl: readline.Interface,
  label: string,
  current: number | undefined,
  min: number,
  max: number,
  signal: AbortSignal,
): Promise<number | undefined> {
  const promptLabel = current !== undefined ? `${label} [current: ${current}]` : label;
  const val = await promptValue(rl, { label: promptLabel }, signal);
  if (val.cancelled) return undefined;
  const trimmed = val.raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== trimmed || parsed < min || parsed > max) {
    return undefined;
  }
  return parsed;
}

async function pickFloat01(
  rl: readline.Interface,
  label: string,
  current: number | undefined,
  signal: AbortSignal,
): Promise<number | undefined> {
  const promptLabel = current !== undefined ? `${label} [current: ${current}]` : label;
  const val = await promptValue(rl, { label: promptLabel }, signal);
  if (val.cancelled) return undefined;
  const trimmed = val.raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return undefined;
  return parsed;
}

/* ------------------------------- categories ------------------------------- */

/**
 * Canonical wizard layout. The "Provider & model" category is intentionally
 * absent — provider/model selection in Bernard depends on which API keys the
 * user has configured and routes through richer pickers (`/provider`,
 * `/model`) than belong inside this generic wizard. The user can switch into
 * the new profile after creation and run those commands.
 */
export const WIZARD_CATEGORIES: WizardCategory[] = [
  {
    id: 'agent-behavior',
    title: 'Agent behavior',
    description: 'Coordinator, multi-model assignment, sub-agent pipeline, and prompt rewriter.',
    fields: [
      {
        key: 'coordinatorMode',
        label: 'Coordinator mode',
        description: 'auto = qualifier picks; on = always ReAct; off = always Normal.',
        prompt: (rl, current, signal) =>
          pickFromList<'on' | 'off' | 'auto'>(rl, 'Coordinator mode', current, [
            { value: 'auto', label: 'Auto (qualifier picks per turn)' },
            { value: 'on', label: 'On (always coordinator)' },
            { value: 'off', label: 'Off (always normal)' },
          ], signal),
      },
      {
        key: 'modelMode',
        label: 'Model mode',
        description: 'How to assign provider models across the various LLM call sites.',
        prompt: (rl, current, signal) =>
          pickFromList<'off' | 'optimize-tokens' | 'balanced' | 'optimize-performance'>(
            rl,
            'Model mode',
            current,
            [
              { value: 'off', label: 'Off (single model)' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'optimize-tokens', label: 'Optimize for token usage' },
              { value: 'optimize-performance', label: 'Optimize for performance' },
            ],
            signal,
          ),
      },
      {
        key: 'subagentPac',
        label: 'Sub-agent PAC pipeline',
        description: 'Run sub-agent dispatch through Planner → Actor → Critic.',
        prompt: (rl, current, signal) => pickBoolean(rl, 'Sub-agent PAC pipeline', current, signal),
      },
      {
        key: 'promptRewriter',
        label: 'Prompt rewriter',
        description: 'Restructure your prompt for the active model family before each turn.',
        prompt: (rl, current, signal) => pickBoolean(rl, 'Prompt rewriter', current, signal),
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
        prompt: (rl, current, signal) =>
          pickFromList<'read-only' | 'write'>(rl, 'Tool mode', current, [
            { value: 'read-only', label: 'Read-only (least privilege)' },
            { value: 'write', label: 'Write (allow all tools)' },
          ], signal),
      },
      {
        key: 'confirmMode',
        label: 'Confirm mode',
        description: 'How aggressively to prompt before running risky tools.',
        prompt: (rl, current, signal) =>
          pickFromList<'off' | 'auto' | 'strict'>(rl, 'Confirm mode', current, [
            { value: 'auto', label: 'Auto (high-risk only)' },
            { value: 'strict', label: 'Strict (also medium-risk)' },
            { value: 'off', label: 'Off (never prompt)' },
          ], signal),
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
        prompt: (rl, current, signal) => pickBoolean(rl, 'Concise mode', current, signal),
      },
      {
        key: 'responseStyle',
        label: 'Response style',
        description: 'Default, detailed, short, step-by-step, simple, high-level, critical, or creative.',
        prompt: (rl, current, signal) =>
          pickFromList<ResponseStyle>(
            rl,
            'Response style',
            current as ResponseStyle | undefined,
            RESPONSE_STYLE_IDS.map((id) => ({ value: id, label: id })),
            signal,
          ),
      },
      {
        key: 'toolDetails',
        label: 'Tool details',
        description: 'Show full tool call args and results in the transcript.',
        prompt: (rl, current, signal) => pickBoolean(rl, 'Tool details', current, signal),
      },
      {
        key: 'theme',
        label: 'Theme',
        description: 'Color scheme for terminal output.',
        prompt: (rl, current, signal) =>
          pickFromList<string>(
            rl,
            'Theme',
            current as string | undefined,
            Object.keys(THEMES).map((name) => ({ value: name, label: name })),
            signal,
          ),
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
        prompt: (rl, current, signal) =>
          pickInt(rl, 'Max concurrent sub-agents', current as number | undefined, 1, MAX_CONCURRENT_AGENTS_LIMIT, signal),
      },
      {
        key: 'maxSteps',
        label: 'Max agent steps per turn',
        description: 'How many LLM calls the agent loop can chain.',
        prompt: (rl, current, signal) =>
          pickInt(rl, 'Max steps', current as number | undefined, 1, 200, signal),
      },
      {
        key: 'maxTokens',
        label: 'Max response tokens',
        description: 'Upper bound on tokens the model may generate per response.',
        prompt: (rl, current, signal) =>
          pickInt(rl, 'Max tokens', current as number | undefined, 256, 200_000, signal),
      },
      {
        key: 'shellTimeout',
        label: 'Shell timeout (ms)',
        description: 'How long shell tool commands may run.',
        prompt: (rl, current, signal) =>
          pickInt(rl, 'Shell timeout (ms)', current as number | undefined, 1_000, 600_000, signal),
      },
      {
        key: 'tokenWindow',
        label: 'Context window override',
        description: '0 = auto-detect from model.',
        prompt: (rl, current, signal) =>
          pickInt(rl, 'Token window (0 = auto)', current as number | undefined, 0, 2_000_000, signal),
      },
    ],
  },
  {
    id: 'advanced',
    title: 'Advanced',
    description: 'Auto-create specialists, reference lookup, and the subject-change threshold.',
    fields: [
      {
        key: 'autoCreateSpecialists',
        label: 'Auto-create specialists',
        description: 'Promote pending specialist candidates that exceed the threshold.',
        prompt: (rl, current, signal) =>
          pickBoolean(rl, 'Auto-create specialists', current, signal),
      },
      {
        key: 'autoCreateThreshold',
        label: 'Auto-create threshold',
        description: 'Confidence threshold 0-1 (e.g. 0.8).',
        prompt: (rl, current, signal) =>
          pickFloat01(rl, 'Auto-create threshold', current as number | undefined, signal),
      },
      {
        key: 'referenceLookup',
        label: 'Reference lookup',
        description: 'Try a read-only tool lookup before prompting for unknown references.',
        prompt: (rl, current, signal) => pickBoolean(rl, 'Reference lookup', current, signal),
      },
      {
        key: 'scratchSubjectThreshold',
        label: 'Scratch subject-change threshold',
        description: 'Jaccard threshold 0-1 below which scratch is cleared on subject change.',
        prompt: (rl, current, signal) =>
          pickFloat01(rl, 'Scratch subject-change threshold', current as number | undefined, signal),
      },
    ],
  },
];

/* ----------------------------- main wizard loop --------------------------- */

async function runCategoryFields(
  category: WizardCategory,
  draft: ProfileSettings,
  deps: WizardDeps,
): Promise<boolean> {
  for (const field of category.fields) {
    const signal = deps.createSignal();
    try {
      const chosen = await field.prompt(deps.rl, draft[field.key], signal);
      if (chosen !== undefined) {
        (draft as Record<string, unknown>)[field.key as string] = chosen;
      }
      // chosen === undefined means the user pressed Esc or entered an
      // out-of-range value — in either case we leave the existing draft entry
      // untouched and move on to the next field.
    } finally {
      deps.clearSignal();
    }
  }
  return true;
}

/**
 * Drives the multi-step wizard. Returns `{ cancelled: true }` if the user
 * aborts the name prompt; otherwise returns the chosen name + a (possibly
 * partial) `settings` blob. Categories the user skips contribute nothing,
 * so the resulting profile inherits Bernard's built-in defaults for those
 * fields when `loadConfig` resolves them.
 */
export async function runProfileWizard(
  deps: WizardDeps,
  options: {
    initialName?: string;
    initialSettings?: ProfileSettings;
    namePromptLabel?: string;
  } = {},
): Promise<WizardResult> {
  // 1) Name
  let name = options.initialName?.trim() ?? '';
  if (!name) {
    const signal = deps.createSignal();
    try {
      const val = await promptValue(
        deps.rl,
        { label: options.namePromptLabel ?? 'Profile name' },
        signal,
      );
      if (val.cancelled) return { cancelled: true };
      name = val.raw.trim();
    } finally {
      deps.clearSignal();
    }
    const err = validateProfileName(name);
    if (err) return { cancelled: true };
  }

  const draft: ProfileSettings = { ...(options.initialSettings ?? {}) };

  // 2) For each category: Configure / Use defaults / Skip
  for (const category of WIZARD_CATEGORIES) {
    const signal = deps.createSignal();
    let choice: ConfigureChoice | undefined;
    try {
      const res = await selectFromMenu(
        deps.rl,
        [
          { label: 'Configure', description: 'Step through each setting in this category.' },
          { label: 'Use defaults', description: 'Clear any draft values so Bernard defaults win.' },
          { label: 'Skip', description: 'Leave whatever is already in the draft (or unset).' },
        ],
        { title: `${category.title} — ${category.description}` },
        signal,
      );
      if (res.cancelled) {
        // Treat in-wizard cancellation of a category as Skip rather than
        // aborting the whole wizard. Esc on the name prompt is the documented
        // way to abort.
        choice = 'skip';
      } else {
        choice = (['configure', 'use-defaults', 'skip'] as const)[res.index];
      }
    } finally {
      deps.clearSignal();
    }

    if (choice === 'configure') {
      await runCategoryFields(category, draft, deps);
    } else if (choice === 'use-defaults') {
      for (const field of category.fields) {
        delete (draft as Record<string, unknown>)[field.key as string];
      }
    }
    // 'skip' = leave draft as-is
  }

  // 3) Final confirm
  const signal = deps.createSignal();
  try {
    const res = await selectFromMenu(
      deps.rl,
      [
        { label: `Save profile "${name}"` },
        { label: 'Cancel without saving' },
      ],
      { title: 'Ready to save?' },
      signal,
    );
    if (res.cancelled || res.index === 1) return { cancelled: true };
  } finally {
    deps.clearSignal();
  }

  return { cancelled: false, name, settings: draft };
}
