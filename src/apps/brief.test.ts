import { describe, it, expect } from 'vitest';
import {
  INTENT_FIELDS,
  INTENT_FIELD_LABELS,
  MAX_INTENT_FIELD_CHARS,
  emptyBrief,
  normalizeIntent,
  renderBrief,
  type AppletBrief,
} from './brief.js';

function briefWith(notes: { timestamp: string; text: string }[]): AppletBrief {
  return { intent: {}, notes };
}

describe('the intent fields', () => {
  it('every field has a label — the labels are what a model is asked against', () => {
    for (const field of INTENT_FIELDS) {
      expect(INTENT_FIELD_LABELS[field], `no label for "${field}"`).toBeTruthy();
    }
    expect(Object.keys(INTENT_FIELD_LABELS).sort()).toEqual([...INTENT_FIELDS].sort());
  });

  it('carries `assumptions`, which is what separates evidence from a guess', () => {
    expect(INTENT_FIELDS).toContain('assumptions');
  });
});

describe('normalizeIntent', () => {
  it('drops keys that are not intent fields', () => {
    // The intent comes from a model, so an invented key is the expected case.
    expect(normalizeIntent({ goal: 'ship', nonsense: 'x' })).toEqual({ goal: 'ship' });
  });

  it('treats an empty or blank value as absent, so a field can be cleared', () => {
    expect(normalizeIntent({ goal: '', friction: '   ' })).toEqual({});
  });

  it('caps a field rather than refusing it', () => {
    const long = 'x'.repeat(MAX_INTENT_FIELD_CHARS + 500);
    expect(normalizeIntent({ goal: long }).goal).toHaveLength(MAX_INTENT_FIELD_CHARS);
  });

  it('ignores non-strings and a missing object', () => {
    expect(normalizeIntent({ goal: 42 as unknown as string })).toEqual({});
    expect(normalizeIntent(undefined)).toEqual({});
  });
});

describe('renderBrief', () => {
  it('renders nothing for an empty brief — the empty string IS the predicate', () => {
    // Every call site pairs the render with "is there one?", so a separate
    // `isBriefEmpty` was a second way to ask the same question.
    expect(renderBrief(emptyBrief())).toBe('');
  });

  it('renders intent with its labels, in field order', () => {
    const out = renderBrief({
      intent: { friction: 'copying by hand', goal: 'send shifts' },
      notes: [],
    });
    expect(out).toContain(INTENT_FIELD_LABELS.goal);
    // Field order, not object-key order — the object above is deliberately
    // out of order.
    expect(out.indexOf('send shifts')).toBeLessThan(out.indexOf('copying by hand'));
  });

  it('drops WHOLE notes oldest-first and says how many', () => {
    // Whole notes, never a mid-note cut: a note that stops mid-sentence still
    // reads as authoritative, so a truncated one is worse than an absent one.
    const notes = Array.from({ length: 20 }, (_, i) => ({
      timestamp: `t${i}`,
      text: `note ${i} ${'x'.repeat(80)}`,
    }));
    const out = renderBrief(briefWith(notes), 400);

    expect(out).toContain('### (truncated)');
    expect(out).toMatch(/\d+ older notes were omitted/);
    expect(out).toContain('note 19');
    expect(out).not.toContain('note 0 ');
    // Nothing is cut mid-note: every rendered note line ends with its padding.
    for (const line of out.split('\n').filter((l) => l.startsWith('- t'))) {
      expect(line.endsWith('x')).toBe(true);
    }
  });

  it('keeps intent even when notes are dropped', () => {
    // Intent is the smaller half and the one that says what the applet is FOR.
    // Losing it to make room for note #40 inverts the priority.
    const out = renderBrief(
      {
        intent: { goal: 'the whole point' },
        notes: Array.from({ length: 30 }, (_, i) => ({ timestamp: `t${i}`, text: 'y'.repeat(60) })),
      },
      300,
    );
    expect(out).toContain('the whole point');
    expect(out).toContain('### (truncated)');
  });

  it('renders surviving notes oldest-first, so it reads as a history', () => {
    const out = renderBrief(
      briefWith([
        { timestamp: 't1', text: 'first' },
        { timestamp: 't2', text: 'second' },
      ]),
    );
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
    expect(out).not.toContain('### (truncated)');
  });

  it('says nothing about truncation when everything fits', () => {
    expect(renderBrief(briefWith([{ timestamp: 't', text: 'ok' }]))).not.toContain('truncated');
  });
});
