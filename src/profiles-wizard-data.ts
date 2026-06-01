/**
 * @module profiles-wizard-data
 *
 * Declarative shape of the settings-profile creation wizard (#207). The
 * legacy `src/profiles-wizard.ts` paired field metadata with readline-bound
 * pickers; this module strips the readline assumption and leaves a pure
 * data tree so any UI host (the Ink REPL in Phase D, the legacy harness
 * during transition, future hosts) can interpret the same categories.
 *
 * Phase D consumes this directly from `src/ui/App.tsx`. The legacy
 * wizard file is deleted in the same PR.
 */

import { MAX_CONCURRENT_AGENTS_LIMIT } from './tools/agent-pool.js';
import { RESPONSE_STYLE_IDS, type ResponseStyle } from './agent-prompt.js';
import { THEMES } from './theme.js';
import type { ProfileSettings } from './profiles.js';

export type WizardFieldKind =
  | { kind: 'list'; options: Array<{ value: string; label: string; description?: string }> }
  | { kind: 'boolean' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'float01' };

export interface WizardFieldData {
  key: keyof ProfileSettings;
  label: string;
  description: string;
  field: WizardFieldKind;
}

export interface WizardCategoryData {
  id: string;
  title: string;
  description: string;
  fields: WizardFieldData[];
}

export const WIZARD_CATEGORIES_DATA: WizardCategoryData[] = [
  {
    id: 'agent-behavior',
    title: 'Agent behavior',
    description: 'Coordinator, multi-model assignment, sub-agent pipeline, and prompt rewriter.',
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
      },
      {
        key: 'subagentPac',
        label: 'Sub-agent PAC pipeline',
        description: 'Run sub-agent dispatch through Planner → Actor → Critic.',
        field: { kind: 'boolean' },
      },
      {
        key: 'promptRewriter',
        label: 'Prompt rewriter',
        description: 'Restructure your prompt for the active model family before each turn.',
        field: { kind: 'boolean' },
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
          ],
        },
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
      },
      {
        key: 'toolDetails',
        label: 'Tool details',
        description: 'Show full tool call args and results in the transcript.',
        field: { kind: 'boolean' },
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
    id: 'limits',
    title: 'Limits & performance',
    description: 'Step budget, parallelism, token limits, and shell timeout.',
    fields: [
      {
        key: 'maxConcurrentAgents',
        label: 'Max concurrent sub-agents',
        description: `Integer 1-${MAX_CONCURRENT_AGENTS_LIMIT}.`,
        field: { kind: 'int', min: 1, max: MAX_CONCURRENT_AGENTS_LIMIT },
      },
      {
        key: 'maxSteps',
        label: 'Max agent steps per turn',
        description: 'How many LLM calls the agent loop can chain.',
        field: { kind: 'int', min: 1, max: 200 },
      },
      {
        key: 'maxTokens',
        label: 'Max response tokens',
        description: 'Upper bound on tokens the model may generate per response.',
        field: { kind: 'int', min: 256, max: 200_000 },
      },
      {
        key: 'shellTimeout',
        label: 'Shell timeout (ms)',
        description: 'How long shell tool commands may run.',
        field: { kind: 'int', min: 1_000, max: 600_000 },
      },
      {
        key: 'tokenWindow',
        label: 'Context window override',
        description: '0 = auto-detect from model.',
        field: { kind: 'int', min: 0, max: 2_000_000 },
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
        field: { kind: 'boolean' },
      },
      {
        key: 'autoCreateThreshold',
        label: 'Auto-create threshold',
        description: 'Confidence threshold 0-1 (e.g. 0.8).',
        field: { kind: 'float01' },
      },
      {
        key: 'referenceLookup',
        label: 'Reference lookup',
        description: 'Try a read-only tool lookup before prompting for unknown references.',
        field: { kind: 'boolean' },
      },
      {
        key: 'scratchSubjectThreshold',
        label: 'Scratch subject-change threshold',
        description: 'Jaccard threshold 0-1 below which scratch is cleared on subject change.',
        field: { kind: 'float01' },
      },
    ],
  },
];
