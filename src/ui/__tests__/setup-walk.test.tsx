import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { DimensionsProvider } from '../DimensionsContext.js';
import { WizardOverlay } from '../overlays/WizardOverlay.js';
import type { WizardResult, WizardSpec } from '../overlays/wizard-types.js';
import {
  buildDefaultProviderSpec,
  buildKeyEntrySpec,
  buildProviderHubSpec,
  buildSettingsSpec,
  buildWelcomeSpec,
  type SetupContext,
} from '../../setup-wizard.js';
import { CTRL_N, tick } from './_keys.js';

/**
 * `ctrl+n` walks the real setup, not a fixture (#447).
 *
 * The chord was bound straight to "hand back the selection", which is not what
 * every step's forward button does: the provider hub draws an ACTION row as its
 * button, and a `pickAdvances` page carries no selection — so the chord was
 * advertised in the key line and silently inert on the screen a fresh install
 * starts on. A hand-written spec could not have caught that, because the shape
 * only exists in the flow's own builders.
 *
 * So the fixtures here are the builders themselves. What is asserted is the
 * property rather than any one screen: from the first step, `ctrl+n` alone
 * reaches the end.
 */
const CTX: SetupContext = {
  current: {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    activeLineupId: 'anthropic',
    coordinatorMode: 'auto',
    modelMode: 'balanced',
    subagentPac: true,
    promptRewriter: true,
    recallFilter: true,
    memoryConsolidation: true,
    specialistRecall: true,
    scratchSubjectThreshold: 0.15,
    toolMode: 'write',
    skipPermissions: false,
    confirmMode: 'auto',
    remoteMessages: 'ask',
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
  } as SetupContext['current'],
  explicit: new Set(),
  providers: [
    { name: 'anthropic', hasKey: true, custom: false, keyHint: 'aa11' },
    { name: 'openai', hasKey: true, custom: false, keyHint: 'bb22' },
    { name: 'xai', hasKey: false, custom: false },
  ],
  models: ['claude-sonnet-5', 'claude-opus-5'],
  lineups: [
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'xai', name: 'xAI' },
  ],
  env: {},
};

/** Press `ctrl+n` until the wizard resolves, or give up and say where it stuck. */
async function walkWithChord(spec: WizardSpec, presses: number) {
  const onResolve = vi.fn<[WizardResult], void>();
  const { stdin, lastFrame } = render(
    createElement(DimensionsProvider, null, createElement(WizardOverlay, { spec, onResolve })),
  );
  await tick();
  for (let i = 0; i < presses && onResolve.mock.calls.length === 0; i++) {
    stdin.write(CTRL_N);
    await tick(20);
  }
  return { onResolve, frame: stripAnsi(lastFrame() ?? '') };
}

describe('ctrl+n walks every stage of the real setup flow', () => {
  const stages: Array<[string, WizardSpec]> = [
    ['welcome', buildWelcomeSpec()],
    ['provider hub', buildProviderHubSpec(CTX)],
    ['key entry (key already stored)', buildKeyEntrySpec(CTX, 'anthropic').spec],
    ['key entry (no key yet)', buildKeyEntrySpec(CTX, 'xai').spec],
    ['default provider', buildDefaultProviderSpec(CTX)!.spec],
    ['settings', buildSettingsSpec(CTX).spec],
  ];

  it.each(stages)('%s', async (_name, spec) => {
    // One press per step, plus the review the settings stage ends on.
    const { onResolve, frame } = await walkWithChord(spec, spec.steps.length + 2);
    expect(onResolve, `stuck on:\n${frame}`).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0][0].cancelled).toBe(false);
  });

  it('reaches the settings review, having answered every question', async () => {
    // The stage that matters most: 36 questions, and a chord that silently held
    // on any one of them would leave the walk short with nothing saying so.
    const { spec, steps } = buildSettingsSpec(CTX);
    const { onResolve } = await walkWithChord(spec, spec.steps.length + 2);
    const result = onResolve.mock.calls[0][0];
    expect(result.cancelled).toBe(false);
    if (result.cancelled) return;
    expect(result.answers).toHaveLength(steps.length);
    // …and each answer is the value the step opened on, which is what makes
    // `settingsPatch` emit nothing for a walk that changed nothing.
    expect(result.answers).toEqual(steps.map((s) => s.initial));
  });

  it('never draws two controls that both read as "back"', async () => {
    // The key page draws `← Back` and its own forward button. That button said
    // "Back to providers", so the row had two controls a reader could only tell
    // apart by pressing one.
    for (const provider of ['anthropic', 'xai']) {
      const { frame } = await walkWithChord(buildKeyEntrySpec(CTX, provider).spec, 0);
      const controls = frame.split('\n').find((l) => l.includes('← Back')) ?? '';
      expect(controls, provider).toContain('← Back');
      // One "back" on the row, not two.
      expect(controls.toLowerCase().match(/back/g) ?? [], provider).toHaveLength(1);
    }
  });

  it('is advertised on exactly the stages where it works', async () => {
    // The hint and the binding come apart silently: a key line naming a chord
    // that does nothing is the defect this whole block exists for.
    for (const [name, spec] of stages) {
      const { frame } = await walkWithChord(spec, 0);
      expect(frame, `no ctrl+n hint on ${name}`).toContain('ctrl+n');
    }
  });
});
