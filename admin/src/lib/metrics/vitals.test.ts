import { describe, it, expect } from 'vitest';
import { percentileFromBuckets, formatVital, vitalsPanelFrom, type BucketRow } from './vitals';

// The panel reads percentiles back from histogram buckets, so the thing to pin is
// that it never claims more precision than a bucket has, and never invents a
// number from no data.

describe('percentileFromBuckets', () => {
  it('is null with no samples', () => {
    expect(percentileFromBuckets([], 0.75)).toBeNull();
  });

  it('is the upper bound of the bucket holding the percentile', () => {
    const buckets = [
      { le: 100, count: 60 },
      { le: 200, count: 20 },
      { le: 500, count: 20 },
    ];
    expect(percentileFromBuckets(buckets, 0.5)).toBe(100);
    expect(percentileFromBuckets(buckets, 0.75)).toBe(200);
    expect(percentileFromBuckets(buckets, 0.9)).toBe(500);
  });

  it('does not depend on row order', () => {
    expect(
      percentileFromBuckets(
        [
          { le: 500, count: 1 },
          { le: 50, count: 3 },
        ],
        0.75
      )
    ).toBe(50);
  });
});

describe('formatVital', () => {
  it('reads as an upper bound, with the overflow bucket as "over"', () => {
    expect(formatVital('inp', 200)).toBe('≤ 200 ms');
    expect(formatVital('cls', 0.05)).toBe('≤ 0.05');
    expect(formatVital('inp', 1e9)).toBe('> 5 s');
    expect(formatVital('blocking', null)).toBe('—');
  });
});

describe('vitalsPanelFrom', () => {
  const row = (metric: string, route: string, le: number, count: number): BucketRow => ({
    metric,
    route,
    bucket_le: le,
    count,
  });

  it('rates p75 against the web-vitals lines and shows last week beside it', () => {
    const panel = vitalsPanelFrom(
      [row('inp', '/feeds', 150, 8), row('inp', '/feeds', 750, 2), row('cls', '/feeds', 0.25, 10)],
      [row('inp', '/feeds', 300, 4)]
    );
    const [inp, cls, blocking] = panel.metrics;
    expect(inp).toMatchObject({ value: '≤ 150 ms', status: 'healthy' });
    expect(inp.unit).toContain('last week ≤ 300 ms');
    expect(cls).toMatchObject({ value: '≤ 0.25', status: 'warning' });
    expect(blocking).toMatchObject({ value: '—', status: undefined });
  });

  it('lists routes busiest first, counting views from CLS reports', () => {
    const panel = vitalsPanelFrom(
      [row('cls', '/home', 0.01, 3), row('cls', '/feeds', 0.01, 9), row('inp', '/feeds', 100, 4)],
      []
    );
    expect(panel.routes.map((r) => [r.route, r.views])).toEqual([
      ['/feeds', 9],
      ['/home', 3],
    ]);
    expect(panel.routes[1].inp).toBe('—');
  });
});
