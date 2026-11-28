import { describe, it, expect } from 'vitest';
import {
  dueFirst,
  isResurfaceProps,
  resurfaceAtFor,
  resurfaceAtForDate,
  tomorrowInputValue,
} from './resurface';

// 28 Nov 2026, 21:30 local time.
const NOW = new Date(2026, 10, 28, 21, 30).getTime();

describe('resurfaceAtFor', () => {
  it('comes back at the start of the day, local time', () => {
    expect(new Date(resurfaceAtFor('2w', NOW))).toEqual(new Date(2026, 11, 12));
    expect(new Date(resurfaceAtFor('1m', NOW))).toEqual(new Date(2026, 11, 28));
    expect(new Date(resurfaceAtFor('3m', NOW))).toEqual(new Date(2027, 1, 28));
  });
});

describe('resurfaceAtForDate', () => {
  it('takes a day after today as its start', () => {
    expect(resurfaceAtForDate('2026-12-01', NOW)).toBe(new Date(2026, 11, 1).getTime());
    expect(resurfaceAtForDate('2026-11-29', NOW)).toBe(new Date(2026, 10, 29).getTime());
  });

  it('refuses today, the past, and what is not a day', () => {
    expect(resurfaceAtForDate('2026-11-28', NOW)).toBeNull();
    expect(resurfaceAtForDate('2025-01-01', NOW)).toBeNull();
    expect(resurfaceAtForDate('2027-02-30', NOW)).toBeNull();
    expect(resurfaceAtForDate('', NOW)).toBeNull();
    expect(resurfaceAtForDate('soon', NOW)).toBeNull();
  });

  it('offers tomorrow as the earliest day', () => {
    expect(tomorrowInputValue(NOW)).toBe('2026-11-29');
  });
});

describe('isResurfaceProps', () => {
  it('trusts only a pair of finite times', () => {
    expect(isResurfaceProps({ at: 1, setAt: 0 })).toBe(true);
    expect(isResurfaceProps({ at: '1', setAt: 0 })).toBe(false);
    expect(isResurfaceProps({ at: Infinity, setAt: 0 })).toBe(false);
    expect(isResurfaceProps({ at: 1 })).toBe(false);
    expect(isResurfaceProps(null)).toBe(false);
  });
});

describe('dueFirst', () => {
  it('keeps what has come due, the longest-waiting first', () => {
    const entries = [
      { item: 'today', props: { at: NOW - 1000, setAt: 0 } },
      { item: 'later', props: { at: NOW + 1000, setAt: 0 } },
      { item: 'last week', props: { at: NOW - 7 * 86400000, setAt: 0 } },
    ];
    expect(dueFirst(entries, NOW)).toEqual(['last week', 'today']);
  });
});
