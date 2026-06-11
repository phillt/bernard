import { describe, it, expect } from 'vitest';
import {
  getBuiltinSpecialistIds,
  roleOf,
  permissionsFor,
  assertCanDeleteSpecialist,
  assertCanEditSpecialist,
  ProtectedSpecialistError,
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
