import { describe, it, expect } from 'vitest';
import { sparklineGeometry } from './sparkline';

// The failure these guard against is a chart that reads as continuous collection
// when it isn't: one line drawn straight across the hours nobody recorded.

const WIDTH = 240;
const HEIGHT = 40;
const geometry = (points: (number | null)[]) => sparklineGeometry(points, WIDTH, HEIGHT);

// "M12.3,4.5 L…" → ['M12.3,4.5 L…'] per subpath
const subpaths = (path: string) =>
  path
    .split('M')
    .filter(Boolean)
    .map((s) => `M${s.trim()}`);

describe('sparkline geometry', () => {
  it('breaks the line at a missing value instead of drawing through it', () => {
    const { path } = geometry([1000, 1500, null, 2000, 3000]);
    // Two runs of two, not one line of four drawn through the missing hour.
    expect(subpaths(path)).toHaveLength(2);
    expect(path.match(/L/g)).toHaveLength(2);
  });

  it('draws one continuous subpath when nothing is missing', () => {
    const { path } = geometry([1, 2, 3, 4]);
    expect(subpaths(path)).toHaveLength(1);
    expect(path.match(/L/g)).toHaveLength(3);
  });

  it('keeps x anchored to the hour, so a gap occupies its own width', () => {
    const { path, dots } = geometry([1000, 1100, null, null, 2000, 2100]);
    // Six hours: the second run starts at hour 4 of 5, i.e. 80% across. Dropping
    // the nulls instead would have put it at 50%.
    expect(dots).toHaveLength(0);
    expect(subpaths(path)[1]).toContain(`M${((4 / 5) * WIDTH).toFixed(1)},`);
  });

  it('marks a lone recorded hour that has no neighbour to connect to', () => {
    const { path, dots } = geometry([null, 1000, null, 2000, 3000]);
    expect(dots).toHaveLength(1);
    expect(subpaths(path)).toHaveLength(1);
  });

  it('has nothing to draw when nothing was ever recorded', () => {
    expect(geometry([null, null])).toEqual({
      path: '',
      dots: [],
      spanHours: 0,
      first: null,
      latest: null,
    });
    expect(geometry([])).toMatchObject({ path: '', latest: null });
  });

  it('spans the change over the hours between the endpoints, not the sample count', () => {
    // Two recorded values 5 hours apart: "+1000 over 5h", never "over 2h".
    const { first, latest, spanHours } = geometry([1000, null, null, null, null, 2000]);
    expect({ first, latest, spanHours }).toEqual({ first: 1000, latest: 2000, spanHours: 5 });
  });

  it('puts a flat series on the mid-line rather than on the floor', () => {
    const { path } = geometry([5, 5, 5]);
    const ys = [...path.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBeGreaterThan(1);
    expect(ys[0]).toBeLessThan(HEIGHT - 1);
  });
});
