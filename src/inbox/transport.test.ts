import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from '../__tests__/temp-home.js';
import { MAX_PENDING, MAX_RENDER_BURST, type InboxMessage } from './types.js';

async function load() {
  vi.resetModules();
  return {
    ...(await import('./registry.js')),
    ...(await import('./send.js')),
    ...(await import('./watcher.js')),
    ...(await import('../paths.js')),
  };
}

const SEND = {
  text: 'the button did not work',
  source: { kind: 'applet' as const, label: 'applet:news' },
};

describe('the session registry', () => {
  useTempHome('bernard-inbox-registry');
  beforeEach(async () => (await load()).resetSendDedupe());

  it('registers a live session and removes it again', async () => {
    const m = await load();
    const record = m.registerSession({ sessionId: 's1' });
    expect(m.listLiveSessions().map((s) => s.sessionId)).toEqual(['s1']);
    expect(fs.existsSync(record.inboxDir)).toBe(true);
    m.unregisterSession('s1');
    expect(m.listLiveSessions()).toEqual([]);
    // Undelivered messages go with it — nobody will ever render them, and a
    // re-used id must not inherit a stranger's backlog.
    expect(fs.existsSync(record.inboxDir)).toBe(false);
  });

  it('does not treat a dead PID as a live session', async () => {
    const m = await load();
    const rec = m.registerSession({ sessionId: 's1' });
    // A PID that is certainly not this process. Rewritten by hand because
    // that is exactly how a stale record comes to exist: the process died
    // without unregistering.
    fs.writeFileSync(m.sessionRecordPath('s1'), JSON.stringify({ ...rec, pid: 2 ** 30 }));
    expect(m.listLiveSessions()).toEqual([]);
    m.reapDeadSessions();
    expect(fs.existsSync(m.sessionRecordPath('s1'))).toBe(false);
  });

  it('skips and reaps a record it cannot read', async () => {
    const m = await load();
    m.registerSession({ sessionId: 's1' });
    fs.writeFileSync(m.sessionRecordPath('s1'), '{ not json');
    expect(m.listLiveSessions()).toEqual([]);
    m.reapDeadSessions();
    expect(fs.existsSync(m.sessionRecordPath('s1'))).toBe(false);
  });

  it('resolves an unambiguous prefix and refuses an ambiguous one', async () => {
    const m = await load();
    m.registerSession({ sessionId: 'aaa-1' });
    m.registerSession({ sessionId: 'aab-2' });
    expect(m.resolveSession('aaa')).toMatchObject({ sessionId: 'aaa-1' });
    expect(m.resolveSession('aa')).toBe('ambiguous');
    expect(m.resolveSession('zz')).toBeNull();
  });
});

describe('sending', () => {
  useTempHome('bernard-inbox-send');
  beforeEach(async () => (await load()).resetSendDedupe());

  it('delivers to the only live session', async () => {
    const m = await load();
    m.registerSession({ sessionId: 's1' });
    const out = m.sendToSessions(SEND);
    expect(out.delivered).toHaveLength(1);
    expect(fs.existsSync(out.delivered[0].file)).toBe(true);
  });

  it('refuses rather than guessing when several are running', async () => {
    // The acceptance criterion, literally: "several fails with a clear message
    // rather than silently". A most-recent default guesses wrong in exactly
    // the two-terminal case this feature exists for.
    const m = await load();
    m.registerSession({ sessionId: 's1' });
    m.registerSession({ sessionId: 's2' });
    const out = m.sendToSessions(SEND);
    expect(out.reason).toBe('ambiguous');
    expect(out.candidates).toHaveLength(2);
    expect(out.delivered).toEqual([]);
  });

  it('fans out with --all, which is what an automated failure hook uses', async () => {
    const m = await load();
    m.registerSession({ sessionId: 's1' });
    m.registerSession({ sessionId: 's2' });
    expect(m.sendToSessions({ ...SEND, target: { all: true } }).delivered).toHaveLength(2);
  });

  it('reports no running session rather than writing somewhere', async () => {
    const m = await load();
    expect(m.sendToSessions(SEND)).toEqual({ delivered: [], reason: 'none-running' });
  });

  it('refuses text that is too large, and empty text', async () => {
    const m = await load();
    m.registerSession({ sessionId: 's1' });
    expect(m.sendToSessions({ ...SEND, text: 'x'.repeat(9000) }).reason).toBe('too-large');
    expect(m.sendToSessions({ ...SEND, text: '   ' }).reason).toBe('empty');
  });

  it('sends an identical repeat once inside the dedupe window', async () => {
    // A page whose button is broken retries; forty clicks must not be forty
    // panels.
    const m = await load();
    m.registerSession({ sessionId: 's1' });
    const t = 1_000_000;
    expect(m.sendToSessions(SEND, t).delivered).toHaveLength(1);
    expect(m.sendToSessions(SEND, t + 1000).delivered).toHaveLength(0);
    expect(m.sendToSessions(SEND, t + 60_000).delivered).toHaveLength(1);
  });

  it('applies backpressure rather than filling the disk', async () => {
    const m = await load();
    const rec = m.registerSession({ sessionId: 's1' });
    for (let i = 0; i < MAX_PENDING + 5; i++) {
      fs.writeFileSync(path.join(rec.inboxDir, `${i}-x.json`), '{}');
    }
    expect(m.sendToSessions(SEND).reason).toBe('inbox-full');
  });

  it('leaves no temp file behind, which the drain would otherwise read', async () => {
    const m = await load();
    const rec = m.registerSession({ sessionId: 's1' });
    m.sendToSessions(SEND);
    expect(fs.readdirSync(rec.inboxDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('the watcher', () => {
  useTempHome('bernard-inbox-watcher');
  beforeEach(async () => (await load()).resetSendDedupe());

  function collect(m: Awaited<ReturnType<typeof load>>, sessionId = 's1') {
    const seen: InboxMessage[] = [];
    const coalesced: number[] = [];
    const watcher = new m.InboxWatcher({
      sessionId,
      onMessage: (msg) => seen.push(msg),
      onCoalesced: (n) => coalesced.push(n),
    });
    return { watcher, seen, coalesced };
  }

  it('drains what was already waiting when it starts', async () => {
    // The window a fast `bernard say` hits: the record exists, the watch is
    // not armed yet.
    const m = await load();
    const rec = m.registerSession({ sessionId: 's1' });
    m.writeMessage(rec, {
      schemaVersion: 1,
      kind: 'notice',
      sourceKind: 'cli',
      sourceLabel: 'cli',
      text: 'hello',
      sentAt: 1,
    });
    const { watcher, seen } = collect(m);
    watcher.start();
    expect(seen.map((s) => s.text)).toEqual(['hello']);
    watcher.stop();
  });

  it('unlinks what it delivers, which is how the sender knows', async () => {
    const m = await load();
    m.registerSession({ sessionId: 's1' });
    const out = m.sendToSessions(SEND);
    const { watcher } = collect(m);
    watcher.start();
    expect(fs.existsSync(out.delivered[0].file)).toBe(false);
    watcher.stop();
  });

  it('unlinks a message it cannot use, so one bad file cannot wedge the drain', async () => {
    const m = await load();
    const rec = m.registerSession({ sessionId: 's1' });
    const bad = path.join(rec.inboxDir, '1-bad.json');
    fs.writeFileSync(bad, '{ not json');
    const worse = path.join(rec.inboxDir, '2-worse.json');
    fs.writeFileSync(worse, JSON.stringify({ schemaVersion: 99 }));
    const { watcher, seen } = collect(m);
    watcher.start();
    expect(seen).toEqual([]);
    expect(fs.existsSync(bad)).toBe(false);
    expect(fs.existsSync(worse)).toBe(false);
    watcher.stop();
  });

  it('ignores the temp file of an in-flight atomic write', async () => {
    const m = await load();
    const rec = m.registerSession({ sessionId: 's1' });
    fs.writeFileSync(path.join(rec.inboxDir, '1-half.json.tmp'), '{"partial":');
    const { watcher, seen } = collect(m);
    watcher.start();
    expect(seen).toEqual([]);
    // Left alone: it belongs to a write still in progress.
    expect(fs.existsSync(path.join(rec.inboxDir, '1-half.json.tmp'))).toBe(true);
    watcher.stop();
  });

  it('delivers in arrival order', async () => {
    const m = await load();
    const rec = m.registerSession({ sessionId: 's1' });
    for (const [ts, text] of [
      [200, 'second'],
      [100, 'first'],
    ] as const) {
      fs.writeFileSync(
        path.join(rec.inboxDir, `${ts}-x.json`),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'notice',
          sourceKind: 'cli',
          sourceLabel: 'cli',
          text,
          sentAt: ts,
        }),
      );
    }
    const { watcher, seen } = collect(m);
    watcher.start();
    expect(seen.map((s) => s.text)).toEqual(['first', 'second']);
    watcher.stop();
  });

  it('coalesces a burst rather than filling the screen', async () => {
    const m = await load();
    const rec = m.registerSession({ sessionId: 's1' });
    for (let i = 0; i < MAX_RENDER_BURST + 7; i++) {
      fs.writeFileSync(
        path.join(rec.inboxDir, `${100 + i}-x.json`),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'notice',
          sourceKind: 'cli',
          sourceLabel: 'cli',
          text: `m${i}`,
          sentAt: i,
        }),
      );
    }
    const { watcher, seen, coalesced } = collect(m);
    watcher.start();
    expect(seen).toHaveLength(MAX_RENDER_BURST);
    expect(coalesced).toEqual([7]);
    watcher.stop();
  });

  it('strips a control sequence on the way in, not only on the way out', async () => {
    // The writer is not necessarily our own code: anything that can write the
    // directory can write the file.
    const m = await load();
    const rec = m.registerSession({ sessionId: 's1' });
    fs.writeFileSync(
      path.join(rec.inboxDir, '1-x.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'notice',
        sourceKind: 'cli',
        sourceLabel: 'cli',
        text: 'clear\x1b[2J',
        sentAt: 1,
      }),
    );
    const { watcher, seen } = collect(m);
    watcher.start();
    expect(seen[0].text).not.toContain('\x1b');
    watcher.stop();
  });

  it('takes its registration down on stop', async () => {
    const m = await load();
    const { watcher } = collect(m);
    watcher.start();
    expect(m.listLiveSessions()).toHaveLength(1);
    watcher.stop();
    expect(m.listLiveSessions()).toEqual([]);
  });
});

describe('delivery confirmation', () => {
  useTempHome('bernard-inbox-ack');
  beforeEach(async () => (await load()).resetSendDedupe());

  it('resolves when the file is consumed and gives up when it is not', async () => {
    const m = await load();
    m.registerSession({ sessionId: 's1' });
    const out = m.sendToSessions(SEND);
    const file = out.delivered[0].file;
    // Deletion IS the acknowledgement — no ack file, no protocol.
    setTimeout(() => fs.rmSync(file, { force: true }), 20);
    expect(await m.waitForConsumption(file, 1000)).toBe(true);

    const again = m.sendToSessions({ ...SEND, text: 'a different message' });
    expect(await m.waitForConsumption(again.delivered[0].file, 120)).toBe(false);
  });
});
