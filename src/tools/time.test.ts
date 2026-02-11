import { describe, it, expect } from 'vitest';
import { militaryToMinutes, calcRangeMinutes, formatHours, createTimeTools } from './time.js';

describe('time helpers', () => {
  describe('militaryToMinutes', () => {
    it('converts 0 to 0', () => {
      expect(militaryToMinutes(0)).toBe(0);
    });

    it('converts 500 to 300', () => {
      expect(militaryToMinutes(500)).toBe(300);
    });

    it('converts 1530 to 930', () => {
      expect(militaryToMinutes(1530)).toBe(930);
    });

    it('converts 2359 to 1439', () => {
      expect(militaryToMinutes(2359)).toBe(1439);
    });
  });

  describe('calcRangeMinutes', () => {
    it('500 to 600 → 60 min', () => {
      expect(calcRangeMinutes(500, 600)).toBe(60);
    });

    it('1300 to 1530 → 150 min', () => {
      expect(calcRangeMinutes(1300, 1530)).toBe(150);
    });

    it('900 to 1700 → 480 min', () => {
      expect(calcRangeMinutes(900, 1700)).toBe(480);
    });

    it('2300 to 0000 → 60 min (next-day wrap)', () => {
      expect(calcRangeMinutes(2300, 0)).toBe(60);
    });

    it('2200 to 0200 → 240 min (next-day wrap)', () => {
      expect(calcRangeMinutes(2200, 200)).toBe(240);
    });

    it('0 to 0 → 0 min', () => {
      expect(calcRangeMinutes(0, 0)).toBe(0);
    });

    it('600 to 600 → 0 min (same time)', () => {
      expect(calcRangeMinutes(600, 600)).toBe(0);
    });
  });

  describe('formatHours', () => {
    it('formats 0 minutes', () => {
      expect(formatHours(0)).toBe('0 minutes');
    });

    it('formats 60 minutes as 1 hour', () => {
      expect(formatHours(60)).toBe('1 hour');
    });

    it('formats 150 minutes as 2 hours 30 minutes', () => {
      expect(formatHours(150)).toBe('2 hours 30 minutes');
    });

    it('formats 1 minute singular', () => {
      expect(formatHours(1)).toBe('1 minute');
    });

    it('formats 480 minutes as 8 hours', () => {
      expect(formatHours(480)).toBe('8 hours');
    });

    it('formats 135 minutes as 2 hours 15 minutes', () => {
      expect(formatHours(135)).toBe('2 hours 15 minutes');
    });
  });
});

describe('time tools', () => {
  const tools = createTimeTools();

  describe('time_range', () => {
    it('calculates 500 to 600 as 1 hour', async () => {
      const result = await tools.time_range.execute!({ start: 500, end: 600 }, {} as any);
      expect(result).toBe('1 hour');
    });

    it('calculates 1300 to 1530 as 2 hours 30 minutes', async () => {
      const result = await tools.time_range.execute!({ start: 1300, end: 1530 }, {} as any);
      expect(result).toContain('2 hours');
      expect(result).toContain('30 minutes');
    });
  });

  describe('time_range_total', () => {
    it('sums multiple ranges', async () => {
      const result = await tools.time_range_total.execute!(
        { ranges: [{ start: 500, end: 600 }, { start: 1300, end: 1530 }] },
        {} as any,
      );
      expect(result).toContain('3 hours');
      expect(result).toContain('30 minutes');
    });

    it('handles next-day wrap + normal range', async () => {
      const result = await tools.time_range_total.execute!(
        { ranges: [{ start: 2300, end: 100 }, { start: 800, end: 1200 }] },
        {} as any,
      );
      // 2300→0100 = 120 min, 0800→1200 = 240 min → 360 min = 6 hours
      expect(result).toBe('6 hours');
    });
  });

  describe('schema validation', () => {
    it('parses valid time_range input', () => {
      const parsed = tools.time_range.parameters.parse({ start: 800, end: 1700 });
      expect(parsed.start).toBe(800);
      expect(parsed.end).toBe(1700);
    });

    it('rejects string input for time_range', () => {
      expect(() => {
        tools.time_range.parameters.parse({ start: '800', end: '1700' });
      }).toThrow();
    });

    it('parses valid time_range_total input', () => {
      const parsed = tools.time_range_total.parameters.parse({
        ranges: [{ start: 800, end: 1200 }, { start: 1300, end: 1700 }],
      });
      expect(parsed.ranges).toEqual([{ start: 800, end: 1200 }, { start: 1300, end: 1700 }]);
    });

    it('rejects string values in ranges', () => {
      expect(() => {
        tools.time_range_total.parameters.parse({ ranges: [{ start: '800', end: '1200' }] });
      }).toThrow();
    });
  });
});
