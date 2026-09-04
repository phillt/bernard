import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { useTempHome } from '../__tests__/temp-home.js';
import { formatLogRow } from './invocation-log.js';
import type { InvocationLogRow } from './invoke.js';

const ROW = (over: Partial<InvocationLogRow> = {}): InvocationLogRow => ({
  invocationId: 'i1',
  appId: 'notes',
  action: 'summarise',
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
  durationMs: 1000,
  ok: false,
  capabilityId: null,
  errorCode: 'run_failed',
  ...over,
});

async function load() {
  vi.resetModules();
  return {
    ...(await import('./invocation-log.js')),
    ...(await import('../paths.js')),
  };
}

describe('formatLogRow', () => {
  it('shows the failure message, which is the whole point of the record', () => {
    const out = formatLogRow(ROW({ errorMessage: 'No datetime tool available' }));
    expect(out).toContain('FAILED');
    expect(out).toContain('No datetime tool available');
  });

  it('explains an empty grant rather than leaving the reader to spot it', () => {
    // The observed failure: a non-empty allowlist whose intersection with the
    // specialist's targets was empty, so the action ran with no tools and
    // answered that it could not do the job — a bad answer, not an error.
    const out = formatLogRow(
      ROW({
        errorMessage: 'No datetime tool available',
        specialistId: 'clock',
        toolAllowlist: ['datetime'],
        toolsGranted: [],
      }),
    );
    expect(out).toContain('datetime');
    expect(out).toContain('clock');
  });

  it('says nothing about tools when the grant was fully covered', () => {
    const out = formatLogRow(
      ROW({ specialistId: 'clock', toolAllowlist: ['datetime'], toolsGranted: ['datetime'] }),
    );
    expect(out).not.toContain('does not target');
  });

  it('renders a success as one line', () => {
    expect(formatLogRow(ROW({ ok: true, errorCode: undefined })).split('\n')).toHaveLength(1);
  });
});

describe('readAppletLog', () => {
  useTempHome('bernard-invocation-log');

  it('returns only this applet rows, newest last, bounded by the limit', async () => {
    const m = await load();
    fs.mkdirSync(m.LOGS_DIR, { recursive: true });
    const rows = [
      ROW({ appId: 'other', action: 'a' }),
      ROW({ appId: 'notes', action: 'first' }),
      ROW({ appId: 'notes', action: 'second' }),
    ];
    fs.writeFileSync(m.SCRIPT_LOG_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    expect(m.readAppletLog('notes').map((r) => r.action)).toEqual(['first', 'second']);
    expect(m.readAppletLog('notes', 1).map((r) => r.action)).toEqual(['second']);
    expect(m.readAppletLog('missing')).toEqual([]);
  });

  it('reads nothing rather than throwing when the log does not exist', async () => {
    const m = await load();
    expect(m.readAppletLog('notes')).toEqual([]);
  });
});
