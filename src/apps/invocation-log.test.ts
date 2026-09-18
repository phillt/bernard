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

/**
 * A run that was refused a capability (#447).
 *
 * `runHeadless` returns `denied` on BOTH arms, so `ok` and `denied` are
 * independently reachable — and the first cut of this reporting returned early
 * on `denied`, which pre-empted the failure detail entirely.
 */
describe('formatLogRow: denied runs', () => {
  const base = {
    invocationId: 'i',
    appId: 'a',
    action: 'send',
    startedAt: '',
    completedAt: '2026-09-17T00:00:00Z',
    durationMs: 1200,
    capabilityId: null,
  };

  it('reports a denial on a SUCCESSFUL row, which is the case it exists for', () => {
    // The "ten clean successes" shape: the action ran, answered, and was
    // refused the capability it existed for. Reported only on the failure
    // path, the field would be write-only for exactly this row.
    const out = formatLogRow({ ...base, ok: true, denied: ['shell:gh'] });
    expect(out).toContain('ok');
    expect(out).toContain('Denied: shell:gh');
    expect(out).toContain('the action ran without it.');
  });

  it('keeps the failure detail when a run both failed AND was denied', () => {
    // The regression the early return caused. A button that was refused a
    // capability and then failed is where a reader needs both facts, so this
    // is the worst case for this surface rather than an edge of it.
    const out = formatLogRow({
      ...base,
      ok: false,
      errorCode: 'run_failed',
      errorMessage: 'ran out of steps',
      denied: ['shell:gh'],
    });
    expect(out).toContain('[run_failed]');
    expect(out).toContain('ran out of steps');
    expect(out).toContain('Denied: shell:gh');
  });

  it('does not claim the action ran when it failed', () => {
    // Three words after `FAILED`, "the action ran without it" is false.
    const out = formatLogRow({
      ...base,
      ok: false,
      errorCode: 'run_failed',
      denied: ['shell:gh'],
    });
    expect(out).toContain('FAILED');
    expect(out).not.toContain('the action ran without it.');
    expect(out).toContain('and the action then failed.');
  });

  it('leaves an ordinary success and an ordinary failure untouched', () => {
    // Guard the guard: the two assertions above pass trivially if the denial
    // line were emitted unconditionally.
    expect(formatLogRow({ ...base, ok: true })).not.toContain('Denied');
    expect(formatLogRow({ ...base, ok: true, denied: [] })).not.toContain('Denied');
    const failed = formatLogRow({ ...base, ok: false, errorCode: 'run_failed' });
    expect(failed).not.toContain('Denied');
    expect(failed).toContain('[run_failed]');
  });
});
