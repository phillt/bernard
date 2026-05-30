import { describe, expect, it } from 'vitest';
import type { ToolMeta } from './framework/tools/types.js';
import { isReadOnlyMCPSuffix, riskFromMeta, shouldConfirm } from './risk.js';

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
