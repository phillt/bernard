import { describe, it, expect } from 'vitest';
import { buildSpecialistEditSeed } from '../App.js';
import { SCOPE_AXES } from '../../framework/agents/dispatch-profile.js';
import type { Specialist } from '../../specialists.js';

/**
 * `/specialists` → Edit hands a seed to the main agent and tells it to change
 * only what the user asked for. So the seed IS the agent's whole view of the
 * record: a field it omits is one the agent will drop or contradict, silently,
 * on the next update.
 *
 * It echoed six fields — name, description, kind, targetTools, provider, model
 * — while a record can declare twelve. `role`, the three #508 execution fields,
 * the three fences and `boundTo` were all invisible.
 */
const record = (over: Partial<Specialist> = {}): Specialist =>
  ({
    id: 'coder',
    name: 'Coder',
    description: 'writes code',
    systemPrompt: 'You write code.',
    guidelines: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as Specialist;

describe('buildSpecialistEditSeed', () => {
  it('echoes every fence the record declares', () => {
    const seed = buildSpecialistEditSeed(
      record({ memoryScope: ['proj-*'], knowledgeScope: ['general'], corpusScope: [] }),
    );
    expect(seed).toContain('memoryScope: proj-*');
    expect(seed).toContain('knowledgeScope: general');
    // Deny-all is a declaration, not an absence, and has to read as one.
    expect(seed).toContain('corpusScope:');
  });

  it('echoes the execution fields and the binding', () => {
    const seed = buildSpecialistEditSeed(
      record({
        role: 'executor',
        stepRatio: 0.2,
        strategy: 'react',
        toolSurface: 'full',
        boundTo: { appId: 'notes', action: 'summarise' },
      }),
    );
    for (const fragment of [
      'role: executor',
      'stepRatio: 0.2',
      'strategy: react',
      'toolSurface: full',
      'boundTo: notes/summarise',
    ]) {
      expect(seed).toContain(fragment);
    }
  });

  it('names no field the record did not declare', () => {
    // Guards the guard: an unconditional list would tell the agent every
    // specialist carries every field, which is a different way to lose one.
    const seed = buildSpecialistEditSeed(record());
    for (const axis of SCOPE_AXES) expect(seed).not.toContain(axis.field);
    for (const field of ['role:', 'stepRatio:', 'strategy:', 'toolSurface:', 'boundTo:']) {
      expect(seed).not.toContain(field);
    }
  });
});
