import { describe, it, expect } from 'vitest';
import {
  getBuiltinSpecialistIds,
  roleOf,
  permissionsFor,
  assertCanDeleteSpecialist,
  assertCanEditSpecialist,
  ProtectedSpecialistError,
  invocationRefusal,
} from './specialist-authority.js';

// These tests run against the real shipped manifest (src/builtin-specialists/),
// resolved relative to this module — no mocking. The bundled set is fixed at
// build time, so the assertions are deterministic.
const BUNDLED = 'shell-wrapper';
const USER = 'my-custom-specialist-xyz';

describe('specialist-authority', () => {
  it('resolves the bundled manifest from the shipped directory', () => {
    const ids = getBuiltinSpecialistIds();
    expect(ids.has('shell-wrapper')).toBe(true);
    expect(ids.has('specialist-creator')).toBe(true);
    expect(ids.has('mcp-manager')).toBe(true);
    expect(ids.has(USER)).toBe(false);
  });

  it('assigns the builtin role to bundled ids and user to everything else', () => {
    expect(roleOf(BUNDLED)).toBe('builtin');
    expect(roleOf(USER)).toBe('user');
  });

  it('locks every mutation on bundled specialists except learned examples', () => {
    const perms = permissionsFor(BUNDLED);
    expect(perms).toEqual({
      role: 'builtin',
      canDelete: false,
      canEditDefinition: false,
      canToggleDisabled: false,
      canAppendExamples: true,
    });
  });

  it('grants full permissions on user specialists', () => {
    const perms = permissionsFor(USER);
    expect(perms).toEqual({
      role: 'user',
      canDelete: true,
      canEditDefinition: true,
      canToggleDisabled: true,
      canAppendExamples: true,
    });
  });

  it('assertCanDeleteSpecialist throws only for bundled', () => {
    expect(() => assertCanDeleteSpecialist(BUNDLED)).toThrow(ProtectedSpecialistError);
    expect(() => assertCanDeleteSpecialist(USER)).not.toThrow();
  });

  it('assertCanEditSpecialist throws only for bundled', () => {
    expect(() => assertCanEditSpecialist(BUNDLED)).toThrow(ProtectedSpecialistError);
    expect(() => assertCanEditSpecialist(USER)).not.toThrow();
  });

  it('ProtectedSpecialistError carries structured detail', () => {
    try {
      assertCanDeleteSpecialist(BUNDLED);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProtectedSpecialistError);
      const e = err as ProtectedSpecialistError;
      expect(e.specialistId).toBe(BUNDLED);
      expect(e.action).toBe('delete');
      expect(e.message).toContain('bundled');
    }
  });
});

/**
 * A pipeline stage is not a specialist anybody calls directly (#610 follow-up).
 *
 * The applet design pipeline was bypassed in exactly this way: three of its
 * five stages were ordinary roster records, the main agent dispatched them by
 * hand, and the two stages that exist only inside the pipeline never ran at
 * all — zero dispatches, ever. Neither did the cross-stage checks, which are
 * code rather than prose.
 */
describe('pipeline-only stages', () => {
  const stage = { id: 'applet-architect', pipeline: 'applet-design' };

  it('refuses a stage dispatched as an ordinary tool call', () => {
    const out = invocationRefusal(stage, { kind: 'tool' });
    expect(out?.code).toBe('pipeline');
    expect(out?.message).toContain('applet-design');
  });

  it('permits the pipeline that owns it', () => {
    expect(invocationRefusal(stage, { kind: 'pipeline', pipeline: 'applet-design' })).toBeNull();
  });

  it('refuses a DIFFERENT pipeline', () => {
    // The mark carries a name rather than a boolean for exactly this: a
    // second pipeline must not be able to drive the first one's stages.
    const out = invocationRefusal(stage, { kind: 'pipeline', pipeline: 'something-else' });
    expect(out?.code).toBe('pipeline');
  });

  it('refuses an applet dispatch too', () => {
    // A stage has no business behind an applet button either, and the `app`
    // arm is the one that PERMITS for `boundTo` — so it has to be shown not
    // to permit here.
    const out = invocationRefusal(stage, { kind: 'app', appId: 'x', action: 'y' });
    expect(out?.code).toBe('pipeline');
  });

  it('leaves an unmarked record alone from every channel', () => {
    // The guard that stops this becoming "nothing is dispatchable".
    const plain = { id: 'shell-wrapper' };
    expect(invocationRefusal(plain, { kind: 'tool' })).toBeNull();
    expect(invocationRefusal(plain, { kind: 'pipeline', pipeline: 'applet-design' })).toBeNull();
  });

  it('still refuses a disabled stage as disabled, not as a pipeline stage', () => {
    // Order matters for the message: "re-enable it" is the actionable one.
    const out = invocationRefusal(
      { ...stage, disabled: true },
      {
        kind: 'pipeline',
        pipeline: 'applet-design',
      },
    );
    expect(out?.code).toBe('disabled');
  });
});
