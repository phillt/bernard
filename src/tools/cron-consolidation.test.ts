import { describe, it, expect } from 'vitest';
import { CRON_ACTIONS, CRON_ACTION_NAMES, CRON_READ_ACTIONS, createCronTool } from './cron.js';
import { CRON_LOGS_ACTIONS, CRON_LOGS_ACTION_NAMES } from './cron-logs.js';
import { CRON_NOTES_ACTIONS, CRON_NOTES_ACTION_NAMES } from './cron-notes.js';
import { createTools, WORKER_EXCLUDED_TOOLS } from './index.js';
import { permissionKeyFor } from '../tool-permissions.js';

const memoryStub = {
  getAllMemoryContents: () => new Map(),
  listMemory: () => [],
} as never;

/**
 * Guards for the 18 -> 3 cron consolidation (#253). The behavioural tests live
 * in cron.test.ts / cron-logs.test.ts / cron-notes.test.ts; these cover the
 * things consolidation newly makes possible to get wrong.
 */
describe('cron consolidation (#253)', () => {
  describe('handler tables match their schemas', () => {
    // A handler table keyed off an enum can silently lose an entry: the zod
    // schema still accepts the action, then dispatch resolves to undefined and
    // throws at call time. These fail at build/test time instead.
    it.each([
      ['cron', CRON_ACTIONS, CRON_ACTION_NAMES],
      ['cron_logs', CRON_LOGS_ACTIONS, CRON_LOGS_ACTION_NAMES],
      ['cron_notes', CRON_NOTES_ACTIONS, CRON_NOTES_ACTION_NAMES],
    ])('%s has exactly one handler per declared action', (_name, handlers, names) => {
      expect(Object.keys(handlers).sort()).toEqual([...(names as readonly string[])].sort());
    });

    it('every cron read action is a real action', () => {
      for (const a of CRON_READ_ACTIONS) {
        expect(CRON_ACTION_NAMES as readonly string[]).toContain(a);
      }
    });
  });

  describe('read actions stay readable under the read-only gate (#179)', () => {
    // `cron` is kind:'write' as a whole. Without the isWriteAction refinement,
    // read-only mode would block listing jobs — a capability regression the
    // consolidation would otherwise introduce for free.
    const meta = (
      createCronTool().cron as unknown as {
        __bernardMeta: { isWriteAction?: (a: unknown) => boolean };
      }
    ).__bernardMeta;

    it.each(['list', 'get', 'status'])('%s is not a write action', (action) => {
      expect(meta.isWriteAction?.({ action })).toBe(false);
    });

    it.each(['create', 'update', 'delete', 'run', 'bounce'])('%s is a write action', (action) => {
      expect(meta.isWriteAction?.({ action })).toBe(true);
    });

    it('treats a missing or malformed action as a write', () => {
      // Fail-closed: an unreadable action must not slip past the gate.
      expect(meta.isWriteAction?.({})).toBe(true);
      expect(meta.isWriteAction?.({ action: 42 })).toBe(true);
    });
  });

  describe('permission keys stay per-action (#253)', () => {
    // Ten tools became one, so a name-keyed grant would let "always allow
    // cron" — granted while listing — authorise deletion.
    it('does not collapse list and delete into one grant', () => {
      expect(permissionKeyFor('cron', { action: 'list' })).toBe('cron:list');
      expect(permissionKeyFor('cron', { action: 'delete', id: 'x' })).toBe('cron:delete');
      expect(permissionKeyFor('cron', { action: 'list' })).not.toBe(
        permissionKeyFor('cron', { action: 'delete' }),
      );
    });

    it('keys the same action identically regardless of other args', () => {
      expect(permissionKeyFor('cron', { action: 'delete', id: 'a' })).toBe(
        permissionKeyFor('cron', { action: 'delete', id: 'b' }),
      );
    });

    it('offers no profile grant when the action is unreadable', () => {
      expect(permissionKeyFor('cron', {})).toBeNull();
      expect(permissionKeyFor('cron', { action: 7 })).toBeNull();
    });

    it('leaves non-action tools keyed by name', () => {
      expect(permissionKeyFor('web_read', { url: 'https://x.test' })).toBe('web_read');
    });
  });

  describe('worker surface', () => {
    const names = (surface?: 'full' | 'worker') =>
      Object.keys(
        createTools(
          {} as never,
          memoryStub,
          {},
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          surface ? { surface } : undefined,
        ),
      );

    it('drops cron and the config tools', () => {
      const worker = names('worker');
      expect(worker.filter((n) => n.startsWith('cron'))).toEqual([]);
      for (const excluded of WORKER_EXCLUDED_TOOLS) expect(worker).not.toContain(excluded);
    });

    it('keeps everything a worker actually needs', () => {
      // If this list ever needs widening, do it explicitly here rather than by
      // quietly loosening the exclusion set.
      const worker = names('worker');
      for (const kept of [
        'shell',
        'memory',
        'scratch',
        'datetime',
        'web_read',
        'web_search',
        'wait',
        'file_read_lines',
        'file_edit_lines',
      ]) {
        expect(worker).toContain(kept);
      }
    });

    it('leaves the full surface untouched', () => {
      const full = names();
      expect(full).toContain('cron');
      expect(full).toContain('lineup_edit');
      expect(full.length).toBeGreaterThan(names('worker').length);
    });
  });
});
