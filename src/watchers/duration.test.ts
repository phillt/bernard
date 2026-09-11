import { describe, it, expect } from 'vitest';

import { formatRelative, parseDuration, parseUntil, parseWhen } from './duration.js';

describe('parseDuration', () => {
  it('reads the shapes a person types', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('90m')).toBe(5_400_000);
    expect(parseDuration('45 seconds')).toBe(45_000);
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration('3 days')).toBe(259_200_000);
  });

  it('refuses what it cannot read rather than guessing', () => {
    // A sleep that silently lands at the wrong hour is worse than one that did
    // not start: the user believes it is set.
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('0h')).toBeNull();
    expect(parseDuration('-2h')).toBeNull();
    expect(parseDuration('2 fortnights')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});

describe('parseUntil', () => {
  const now = new Date('2026-09-11T10:00:00');

  it('resolves a time later today', () => {
    const t = parseUntil('until 15:30', now);
    expect(new Date(t!).getHours()).toBe(15);
    expect(new Date(t!).getMinutes()).toBe(30);
  });

  it('rolls to tomorrow when the time has passed', () => {
    // "until 9am" at 11pm means tomorrow. Not rolling fires instantly, which
    // reads as a bug.
    const t = parseUntil('until 9am', new Date('2026-09-11T23:00:00'));
    expect(new Date(t!).getDate()).toBe(12);
    expect(new Date(t!).getHours()).toBe(9);
  });

  it('handles am/pm including the noon and midnight edges', () => {
    expect(new Date(parseUntil('until 12am', now)!).getHours()).toBe(0);
    expect(new Date(parseUntil('until 12pm', now)!).getHours()).toBe(12);
    expect(new Date(parseUntil('until 3pm', now)!).getHours()).toBe(15);
  });

  it('refuses impossible clock values', () => {
    expect(parseUntil('until 25:00', now)).toBeNull();
    expect(parseUntil('until 10:99', now)).toBeNull();
    expect(parseUntil('until 13pm', now)).toBeNull();
    expect(parseUntil('tomorrow', now)).toBeNull();
  });
});

describe('parseWhen', () => {
  it('accepts either form', () => {
    const now = new Date('2026-09-11T10:00:00');
    expect(parseWhen('2h', now)).toBe(now.getTime() + 7_200_000);
    expect(new Date(parseWhen('until 11:00', now)!).getHours()).toBe(11);
    expect(parseWhen('whenever', now)).toBeNull();
  });
});

describe('formatRelative', () => {
  it('reads naturally at each scale', () => {
    expect(formatRelative(30_000)).toBe('30s');
    expect(formatRelative(300_000)).toBe('5m');
    expect(formatRelative(7_200_000)).toBe('2h');
    expect(formatRelative(9_000_000)).toBe('2h 30m');
    expect(formatRelative(180_000_000)).toBe('2d 2h');
  });
});
