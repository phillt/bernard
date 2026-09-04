import { describe, expect, it } from 'vitest';
import type { ToolMeta } from './framework/tools/types.js';
import { isReadOnlyMCPSuffix, riskFromMeta, shouldBlockInReadOnly, shouldConfirm } from './risk.js';

describe('isReadOnlyMCPSuffix', () => {
  it.each([
    'gmail_search',
    'gmail_list',
    'contacts_find',
    'calendar_get',
    'drive_query',
    'drive_read',
    'contacts_lookup',
    'SEARCH',
    'people_Lookup',
  ])('treats %s as read-only', (name) => {
    expect(isReadOnlyMCPSuffix(name)).toBe(true);
  });

  it.each([
    'gmail_send',
    'gmail_create_draft',
    'calendar_update',
    'drive_upload',
    'contacts_delete',
    'searching', // suffix must be a full word, not substring
    'reader', // ditto — `read` is not a suffix here
  ])('treats %s as write/unknown', (name) => {
    expect(isReadOnlyMCPSuffix(name)).toBe(false);
  });
});

describe('riskFromMeta', () => {
  const meta = (m: Partial<ToolMeta>): ToolMeta => ({
    name: 't',
    kind: 'read',
    deterministic: true,
    sideEffect: 'none',
    cacheable: false,
    ...m,
  });

  /**
   * The full precedence, stated once (#456).
   *
   * Written as one test rather than spread across the cases below because the
   * ORDER is the contract: `riskForCall` was added between two existing
   * branches, and the two facts most likely to be broken by a later edit —
   * that a static `risk` still beats it, and that it sits above the
   * downgrade-only predicate — are invisible unless they are asserted
   * together.
   */
  it('resolves in the order: meta.risk > riskForCall > isWriteAction > kind', () => {
    const del = { action: 'delete' };
    const raise = () => 'high' as const;

    // 2. `riskForCall` raises a tool the static rules would call `medium`...
    expect(
      riskFromMeta(meta({ kind: 'write', sideEffect: 'local', riskForCall: raise }), del),
    ).toBe('high');
    // 1. ...but a whole-tool `risk` is the more deliberate statement and wins.
    expect(
      riskFromMeta(
        meta({ kind: 'write', sideEffect: 'local', risk: 'low', riskForCall: raise }),
        del,
      ),
    ).toBe('low');
    // 3. `riskForCall` beats the downgrade: a statement about THIS call beats
    //    the generic "this shape of call is a read".
    expect(
      riskFromMeta(
        meta({
          kind: 'write',
          sideEffect: 'local',
          riskForCall: raise,
          isWriteAction: () => false,
        }),
        del,
      ),
    ).toBe('high');
    // 4. `null` defers, leaving every rule below untouched.
    expect(
      riskFromMeta(meta({ kind: 'write', sideEffect: 'local', riskForCall: () => null }), del),
    ).toBe('medium');
    // Guarded on args exactly as `isWriteAction` is, so a metadata-only call
    // never invokes it.
    expect(riskFromMeta(meta({ kind: 'write', sideEffect: 'local', riskForCall: raise }))).toBe(
      'medium',
    );
  });

  /**
   * The gap #456 exists to close, pinned so it cannot silently reopen: before
   * `riskForCall` NOTHING could raise a `write` + `local` tool above `medium`
   * for one call, and `medium` does not prompt under the default
   * `confirmMode: 'auto'` (threshold `high`).
   */
  it('has exactly one per-call way to raise, and it is riskForCall', () => {
    const base: Partial<ToolMeta> = { kind: 'write', sideEffect: 'local' };
    const del = { action: 'delete' };
    expect(riskFromMeta(meta(base), del)).toBe('medium');
    // The other per-call hook can only ever lower.
    expect(riskFromMeta(meta({ ...base, isWriteAction: () => true }), del)).toBe('medium');
    expect(riskFromMeta(meta({ ...base, isWriteAction: () => false }), del)).toBe('low');
    expect(riskFromMeta(meta({ ...base, riskForCall: () => 'high' }), del)).toBe('high');
  });

  it('defaults missing metadata to medium', () => {
    expect(riskFromMeta(undefined)).toBe('medium');
  });

  it('honors explicit meta.risk override', () => {
    expect(riskFromMeta(meta({ kind: 'read', risk: 'high' }))).toBe('high');
    expect(riskFromMeta(meta({ kind: 'dangerous', risk: 'low' }))).toBe('low');
  });

  it('maps dangerous → high', () => {
    expect(riskFromMeta(meta({ kind: 'dangerous', sideEffect: 'local' }))).toBe('high');
  });

  it('maps read/inert → low', () => {
    expect(riskFromMeta(meta({ kind: 'read' }))).toBe('low');
    expect(riskFromMeta(meta({ kind: 'inert' }))).toBe('low');
  });

  it('maps write + external-api → high', () => {
    expect(riskFromMeta(meta({ kind: 'write', sideEffect: 'external-api' }))).toBe('high');
  });

  it('maps write + local/network → medium', () => {
    expect(riskFromMeta(meta({ kind: 'write', sideEffect: 'local' }))).toBe('medium');
    expect(riskFromMeta(meta({ kind: 'write', sideEffect: 'network' }))).toBe('medium');
    expect(riskFromMeta(meta({ kind: 'write', sideEffect: 'none' }))).toBe('medium');
  });

  it('isWriteAction predicate downgrades reads on discriminator tools to low', () => {
    const m = meta({
      kind: 'write',
      sideEffect: 'local',
      isWriteAction: (args) =>
        (args as { action?: string } | undefined)?.action !== 'read' &&
        (args as { action?: string } | undefined)?.action !== 'list',
    });
    expect(riskFromMeta(m, { action: 'read' })).toBe('low');
    expect(riskFromMeta(m, { action: 'list' })).toBe('low');
    expect(riskFromMeta(m, { action: 'write' })).toBe('medium');
  });

  it('isWriteAction downgrades read-shaped calls on dangerous-kind tools (#212)', () => {
    const m = meta({
      kind: 'dangerous',
      sideEffect: 'local',
      isWriteAction: (args) => (args as { command?: string } | undefined)?.command !== 'ls',
    });
    expect(riskFromMeta(m, { command: 'ls' })).toBe('low');
    expect(riskFromMeta(m, { command: 'rm -rf /' })).toBe('high');
    // Without args the predicate is skipped — static kind wins.
    expect(riskFromMeta(m)).toBe('high');
  });
});

describe('shouldConfirm', () => {
  it('never threshold never confirms', () => {
    for (const risk of ['low', 'medium', 'high'] as const) {
      expect(shouldConfirm(risk, 'never')).toBe(false);
    }
  });

  it('undefined threshold never confirms', () => {
    expect(shouldConfirm('high', undefined)).toBe(false);
  });

  it('high threshold confirms only high', () => {
    expect(shouldConfirm('low', 'high')).toBe(false);
    expect(shouldConfirm('medium', 'high')).toBe(false);
    expect(shouldConfirm('high', 'high')).toBe(true);
  });

  it('medium threshold confirms medium + high', () => {
    expect(shouldConfirm('low', 'medium')).toBe(false);
    expect(shouldConfirm('medium', 'medium')).toBe(true);
    expect(shouldConfirm('high', 'medium')).toBe(true);
  });

  it('always threshold confirms everything', () => {
    for (const risk of ['low', 'medium', 'high'] as const) {
      expect(shouldConfirm(risk, 'always')).toBe(true);
    }
  });
});

describe('shouldBlockInReadOnly', () => {
  const meta = (m: Partial<ToolMeta>): ToolMeta => ({
    name: 't',
    kind: 'read',
    deterministic: true,
    sideEffect: 'none',
    cacheable: false,
    ...m,
  });

  it('blocks write and dangerous kinds', () => {
    expect(shouldBlockInReadOnly(meta({ kind: 'write' }))).toBe(true);
    expect(shouldBlockInReadOnly(meta({ kind: 'dangerous' }))).toBe(true);
  });

  it('allows read and inert kinds', () => {
    expect(shouldBlockInReadOnly(meta({ kind: 'read' }))).toBe(false);
    expect(shouldBlockInReadOnly(meta({ kind: 'inert' }))).toBe(false);
  });

  it('allows missing meta (fall through to confirmMode gate)', () => {
    expect(shouldBlockInReadOnly(undefined)).toBe(false);
  });

  it('honors isWriteAction predicate to refine per-call write-ness', () => {
    const m = meta({
      kind: 'write',
      isWriteAction: (args) =>
        (args as { action?: string } | undefined)?.action !== 'read' &&
        (args as { action?: string } | undefined)?.action !== 'list',
    });
    // Reads/lists fall through despite the static `kind: 'write'`.
    expect(shouldBlockInReadOnly(m, { action: 'read' })).toBe(false);
    expect(shouldBlockInReadOnly(m, { action: 'list' })).toBe(false);
    // Writes still block.
    expect(shouldBlockInReadOnly(m, { action: 'write' })).toBe(true);
    expect(shouldBlockInReadOnly(m, { action: 'delete' })).toBe(true);
  });

  it('without args, isWriteAction is not consulted and static kind wins', () => {
    const m = meta({ kind: 'write', isWriteAction: () => false });
    expect(shouldBlockInReadOnly(m)).toBe(true);
  });
});
