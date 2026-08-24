import { describe, it, expect, vi } from 'vitest';
import { permissionKeyFor, actionOf } from '../tool-permissions.js';
import { breadthOptionsFor } from './breadth.js';
import { readToolMeta } from '../framework/tools/adapter.js';

vi.mock('../cron/store.js', () => ({
  CronStore: class {
    loadJobs() {
      return [];
    }
    listAlerts() {
      return [];
    }
    getJob() {
      return undefined;
    }
  },
}));
vi.mock('../cron/log-store.js', () => ({
  CronLogStore: class {
    getEntries() {
      return [];
    }
    getEntryCount() {
      return 0;
    }
    getEntry() {
      return undefined;
    }
    deleteJobLogs() {
      return false;
    }
    rotate() {}
  },
}));
vi.mock('../cron/notes-store.js', () => ({
  CronNotesStore: class {
    read() {
      return { entries: [] };
    }
    listJobIds() {
      return [];
    }
    append() {
      return { total: 0 };
    }
    entriesForRun() {
      return [];
    }
  },
  MAX_NOTE_LENGTH: 2000,
}));
vi.mock('../cron/client.js', () => ({
  isDaemonRunning: () => false,
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
}));
vi.mock('../cron/runner.js', () => ({ runJob: vi.fn() }));

const { createCronTool } = await import('../tools/cron.js');
const { createCronLogTool } = await import('../tools/cron-logs.js');
const { createCronNotesTool } = await import('../tools/cron-notes.js');

/**
 * #322: `ACTION_SCOPED_TOOLS` was a name Set in `tool-permissions.ts` restating
 * what each tool's own meta already declared — and the two could disagree, with
 * nothing to notice. The discriminator now lives on `ToolMeta.actionArg`, so
 * these assertions read it off the real tools rather than a test-local list.
 *
 * The stakes: `cron` consolidated ten tools into one, so without per-action
 * keying `cron_list` and `cron_delete` collapse into a single grant, and an
 * "always allow" granted while listing jobs silently authorises deleting them.
 */
const ACTION_TOOLS = {
  ...createCronTool(),
  ...createCronLogTool(),
  ...createCronNotesTool(),
};

describe('action-enum tools declare their discriminator (#322)', () => {
  it.each(['cron', 'cron_logs', 'cron_notes'])('%s declares actionArg on its meta', (name) => {
    expect(readToolMeta(ACTION_TOOLS[name])?.actionArg).toBe('action');
  });

  it('the declaration and the write-ness refinement agree on the same field', () => {
    // Both read `action`; a tool that dispatched on one field and keyed on
    // another would gate and grant inconsistently.
    const meta = readToolMeta(ACTION_TOOLS.cron)!;
    expect(meta.actionArg).toBe('action');
    expect(meta.isWriteAction!({ action: 'list' })).toBe(false);
    expect(meta.isWriteAction!({ action: 'delete' })).toBe(true);
  });
});

// The per-action keying itself is covered against the real cron tool in
// `src/tools/cron-consolidation.test.ts`; these cover the generalization —
// what happens for tools that do NOT declare a discriminator.
describe('permissionKeyFor without a declared discriminator', () => {
  it('keys by name for a tool that declares no discriminator', () => {
    // The deliberate exclusion of `routine` / `specialist` / `lineup_edit`
    // (users hold stored rules keyed on the bare name) is now expressed by
    // those tools simply not declaring the field.
    expect(permissionKeyFor('routine', { action: 'delete' }, { kind: 'write' } as never)).toBe(
      'routine',
    );
    expect(permissionKeyFor('web_read', { url: 'https://x' })).toBe('web_read');
  });

  it('shell still keys per primary command — its meta declares no discriminator', () => {
    expect(permissionKeyFor('shell', { command: 'ls -la' })).toBe('shell:ls');
    expect(permissionKeyFor('shell', { command: 'a | b' })).toBeNull();
  });
});

describe('breadthOptionsFor with a declared discriminator', () => {
  it('offers this-action / any-action rather than exact args', () => {
    const opts = breadthOptionsFor(
      'cron',
      { action: 'delete', id: 'x' },
      readToolMeta(ACTION_TOOLS.cron),
    );
    expect(opts.map((o) => o.specifier)).toEqual(['action:delete', '*']);
  });

  it('falls back to the exact-args ladder when no action is readable', () => {
    const opts = breadthOptionsFor('cron', {}, readToolMeta(ACTION_TOOLS.cron));
    expect(opts.map((o) => o.label)).toEqual(['these arguments', 'any arguments']);
  });

  it('a tool with no declared discriminator keeps the exact-args ladder', () => {
    const opts = breadthOptionsFor('srv__tool', { action: 'delete' });
    expect(opts.map((o) => o.label)).toEqual(['these arguments', 'any arguments']);
  });
});

describe('actionOf', () => {
  it('returns null without a declared discriminator, whatever the args carry', () => {
    expect(actionOf({ action: 'delete' })).toBeNull();
    expect(actionOf({ action: 'delete' }, null)).toBeNull();
    expect(actionOf({ action: 'delete' }, { actionArg: 'action' })).toBe('delete');
  });

  it('reads whichever field the meta names', () => {
    expect(actionOf({ op: 'purge', action: 'list' }, { actionArg: 'op' })).toBe('purge');
  });
});
