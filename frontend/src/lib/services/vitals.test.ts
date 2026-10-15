import { describe, expect, it } from 'vitest';
import { clsFrom, inpFrom, routeOf } from './vitals';

describe('inpFrom', () => {
  it('is null with no interactions', () => {
    expect(inpFrom([])).toBeNull();
  });

  it('is the worst interaction in a short view', () => {
    expect(inpFrom([40, 220, 90])).toBe(220);
  });

  it('forgives one outlier per 50 interactions', () => {
    const durations = [900, ...Array.from({ length: 59 }, () => 60), 120];
    expect(inpFrom(durations)).toBe(120);
  });
});

describe('clsFrom', () => {
  it('is 0 with no shifts', () => {
    expect(clsFrom([])).toBe(0);
  });

  it('sums shifts within a session window', () => {
    expect(
      clsFrom([
        { startTime: 100, value: 0.05 },
        { startTime: 600, value: 0.05 },
      ])
    ).toBeCloseTo(0.1);
  });

  it('takes the largest window, not the total', () => {
    expect(
      clsFrom([
        { startTime: 0, value: 0.05 },
        // More than 1s later: a new window.
        { startTime: 2000, value: 0.08 },
        { startTime: 2500, value: 0.02 },
      ])
    ).toBeCloseTo(0.1);
  });

  it('caps a window at 5 seconds', () => {
    const shifts = Array.from({ length: 12 }, (_, i) => ({ startTime: i * 900, value: 0.01 }));
    // 0..4.5s fits six shifts; the seventh starts a new window.
    expect(clsFrom(shifts)).toBeCloseTo(0.06);
  });
});

describe('routeOf', () => {
  it('keeps only the first segment', () => {
    expect(routeOf('/')).toBe('/');
    expect(routeOf('/feeds')).toBe('/feeds');
    expect(routeOf('/rooms/3kabc')).toBe('/rooms');
    expect(routeOf('/linkblog/alice.bsky.social/post')).toBe('/linkblog');
  });
});
