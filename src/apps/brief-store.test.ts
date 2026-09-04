import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from '../__tests__/temp-home.js';
import { AppletBriefStore } from './brief-store.js';
import { MAX_NOTE_CHARS } from './brief.js';

describe('AppletBriefStore', () => {
  useTempHome('bernard-applet-brief');

  it('returns an empty brief for an applet that has none', () => {
    // The normal case for every applet built before this existed.
    const brief = new AppletBriefStore().read('nothing-here');
    expect(brief).toEqual({
      appId: 'nothing-here',
      intent: {},
      notes: [],
      updatedAt: expect.any(String),
    });
  });

  it('merges intent across writes rather than replacing it', () => {
    const store = new AppletBriefStore();
    store.write('merge-me', { intent: { goal: 'send shifts' } });
    store.write('merge-me', { intent: { friction: 'copying by hand' } });

    expect(new AppletBriefStore().read('merge-me').intent).toEqual({
      goal: 'send shifts',
      friction: 'copying by hand',
    });
  });

  it('clears a field written as an empty string', () => {
    // The difference between "not mentioned" (absent) and "no longer true"
    // (present and empty) — without it a wrong field can never be corrected.
    const store = new AppletBriefStore();
    store.write('clear-one', { intent: { goal: 'a', friction: 'b' } });
    store.write('clear-one', { intent: { friction: '' } });

    expect(store.read('clear-one').intent).toEqual({ goal: 'a' });
  });

  it('appends notes in order and stamps each one', () => {
    const store = new AppletBriefStore();
    store.write('noted', { note: 'chose an agent action over a tool call' });
    store.write('noted', { note: 'tried a two-column layout, too cramped' });

    const notes = store.read('noted').notes;
    expect(notes.map((n) => n.text)).toEqual([
      'chose an agent action over a tool call',
      'tried a two-column layout, too cramped',
    ]);
    expect(notes[0].timestamp).toMatch(/^\d{4}-/);
  });

  it('caps a note rather than refusing the write', () => {
    const store = new AppletBriefStore();
    store.write('long-note', { note: 'x'.repeat(MAX_NOTE_CHARS + 500) });
    expect(store.read('long-note').notes[0].text).toHaveLength(MAX_NOTE_CHARS);
  });

  it('ignores a blank note instead of recording an empty one', () => {
    const store = new AppletBriefStore();
    store.write('blank', { note: '   ' });
    expect(store.read('blank').notes).toEqual([]);
  });

  it('REFUSES a malformed id rather than repairing it', () => {
    // `CronNotesStore` sanitises; this refuses, because a repaired id may name
    // a DIFFERENT applet's brief than the caller asked for.
    const store = new AppletBriefStore();
    expect(() => store.read('../escape')).toThrow(/Invalid applet id/);
    expect(() => store.write('Not Valid', { note: 'x' })).toThrow(/Invalid applet id/);
    expect(() => store.clear('')).toThrow(/Invalid applet id/);
  });

  it('survives a corrupt file — a brief is context, not authority', () => {
    const store = new AppletBriefStore();
    store.write('corrupt', { note: 'before' });
    fs.writeFileSync(path.join(AppletBriefStore.briefsDir, 'corrupt.json'), '{not json');

    expect(() => store.read('corrupt')).not.toThrow();
    expect(store.read('corrupt').notes).toEqual([]);
  });

  it('drops junk entries from a hand-edited file', () => {
    const store = new AppletBriefStore();
    store.write('handmade', { note: 'real' });
    const file = path.join(AppletBriefStore.briefsDir, 'handmade.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    parsed.notes = [...(parsed.notes as unknown[]), { text: 'no timestamp' }, null];
    parsed.intent = { goal: 'kept', bogus: 'dropped' };
    fs.writeFileSync(file, JSON.stringify(parsed));

    const brief = store.read('handmade');
    expect(brief.notes.map((n) => n.text)).toEqual(['real']);
    expect(brief.intent).toEqual({ goal: 'kept' });
  });

  it('clears, and reports whether there was anything to clear', () => {
    // `CronNotesStore.clear()` has no caller at all, so its notes outlive the
    // job. This one is called by `deleteApplet`.
    const store = new AppletBriefStore();
    store.write('sweep-me', { note: 'x' });
    expect(store.clear('sweep-me')).toBe(true);
    expect(store.clear('sweep-me')).toBe(false);
    expect(fs.existsSync(path.join(AppletBriefStore.briefsDir, 'sweep-me.json'))).toBe(false);
  });

  it('writes the file 0600', () => {
    const store = new AppletBriefStore();
    store.write('private', { note: 'what the user told Bernard' });
    const mode = fs.statSync(path.join(AppletBriefStore.briefsDir, 'private.json')).mode;
    expect(mode & 0o777).toBe(0o600);
  });
});
