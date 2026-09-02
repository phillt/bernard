import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function loadModule() {
  vi.resetModules();
  // Load paths through the same fresh module graph — `APPS_DIR` is a
  // module-level const derived from BERNARD_HOME at import time, and
  // hard-coding the layout here would make the test agree with itself rather
  // than with `paths.ts`.
  const paths = await import('../paths.js');
  const registry = await import('./registry.js');
  return { ...registry, APPS_DIR: paths.APPS_DIR };
}

const VALID = {
  schemaVersion: 1,
  id: 'notes',
  name: 'Notes',
  actions: {
    summarize: {
      instructions: 'Summarise the supplied text.',
      specialistId: 'web-wrapper',
      args: { text: { type: 'string', required: true } },
    },
  },
};

describe('AppRegistry', () => {
  let tmpDir: string;
  let appsDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-apps-'));
    origHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = tmpDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.BERNARD_HOME;
    else process.env.BERNARD_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(appId: string, body: unknown): void {
    fs.mkdirSync(appsDir, { recursive: true });
    fs.writeFileSync(path.join(appsDir, `${appId}.json`), JSON.stringify(body));
  }

  /** Loads the registry module and latches the APPS_DIR it resolved. */
  async function load() {
    const m = await loadModule();
    appsDir = m.APPS_DIR;
    return m;
  }

  it('resolves a declared action', async () => {
    const { AppRegistry } = await load();
    write('notes', VALID);
    const res = new AppRegistry({ seed: false }).resolve('notes', 'summarize');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.action.specialistId).toBe('web-wrapper');
  });

  // Three distinct failures, because they mean different things to a caller:
  // a wrong app id, a wrong action name, and a manifest the user broke.
  it('reports an unknown app distinctly, without throwing', async () => {
    const { AppRegistry } = await load();
    const res = new AppRegistry({ seed: false }).resolve('nope', 'summarize');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe('unknown_app');
  });

  it('reports an unknown action distinctly and lists what it does know', async () => {
    const { AppRegistry } = await load();
    write('notes', VALID);
    const res = new AppRegistry({ seed: false }).resolve('notes', 'exfiltrate');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure.kind).toBe('unknown_action');
      expect(res.failure.message).toContain('summarize');
    }
  });

  it('reports a malformed manifest distinctly', async () => {
    const { AppRegistry } = await load();
    fs.mkdirSync(appsDir, { recursive: true });
    fs.writeFileSync(path.join(appsDir, 'notes.json'), '{ not json');
    const res = new AppRegistry({ seed: false }).resolve('notes', 'summarize');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe('invalid_manifest');
  });

  // Validating on read, not only on write: the file is user-editable between
  // runs, so a write-time check alone is a time-of-check/time-of-use gap.
  it('rejects a manifest that fails schema validation at read time', async () => {
    const { AppRegistry } = await load();
    write('notes', { ...VALID, actions: { go: { instructions: 'x' } } });
    const res = new AppRegistry({ seed: false }).resolve('notes', 'go');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe('invalid_manifest');
  });

  it('rejects a manifest whose id disagrees with its filename', async () => {
    const { AppRegistry } = await load();
    write('notes', { ...VALID, id: 'other' });
    const res = new AppRegistry({ seed: false }).resolve('notes', 'summarize');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.message).toMatch(/filename must match/);
  });

  it('lists app ids and returns empty when the directory does not exist', async () => {
    const { AppRegistry } = await load();
    const reg = new AppRegistry({ seed: false });
    expect(reg.listIds()).toEqual([]);
    write('notes', VALID);
    write('other', { ...VALID, id: 'other' });
    expect(reg.listIds()).toEqual(['notes', 'other']);
  });

  it('seeds the bundled example app on first construction', async () => {
    const { AppRegistry } = await load();
    const reg = new AppRegistry();
    expect(reg.listIds()).toContain('demo');
    const res = reg.resolve('demo', 'web_answer');
    expect(res.ok).toBe(true);
  });

  it('never overwrites a user-edited copy when seeding', async () => {
    const { AppRegistry } = await load();
    write('demo', { ...VALID, id: 'demo' });
    const reg = new AppRegistry();
    const res = reg.resolve('demo', 'summarize');
    expect(res.ok).toBe(true);
  });
});
