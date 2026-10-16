import { describe, it, expect } from 'vitest';
import { formatReadTime } from './readTime';

describe('formatReadTime', () => {
  it('keeps short reads in minutes', () => {
    expect(formatReadTime(1)).toBe('1 min');
    expect(formatReadTime(8)).toBe('8 min');
    expect(formatReadTime(59)).toBe('59 min');
  });

  it('never shows less than a minute', () => {
    expect(formatReadTime(0)).toBe('1 min');
    expect(formatReadTime(0.2)).toBe('1 min');
  });

  it('breaks an hour or more into hours and minutes', () => {
    expect(formatReadTime(60)).toBe('1 hr');
    expect(formatReadTime(80)).toBe('1 hr 20 min');
    expect(formatReadTime(125)).toBe('2 hr 5 min');
  });

  it('rounds minutes to the nearest 5 past the first hour', () => {
    expect(formatReadTime(83)).toBe('1 hr 25 min');
    expect(formatReadTime(81)).toBe('1 hr 20 min');
    expect(formatReadTime(119)).toBe('2 hr');
  });

  it('shows only hours for very long reads', () => {
    expect(formatReadTime(600)).toBe('10 hr');
    expect(formatReadTime(843)).toBe('14 hr');
  });
});
