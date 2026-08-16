// Geometry for the trend sparklines, kept out of the component so the one thing
// that can silently lie — drawing a line across hours nobody recorded — is unit
// testable rather than eyeballed.
//
// A gap is any hour whose value is null: either the metric was unavailable that
// hour (a stale source is recorded as null, never as its last value) or the
// snapshot row is missing entirely (cron down — see `trendsFrom`). Both mean the
// same thing to a reader, so both break the line.

export interface SparklinePoint {
  x: number;
  y: number;
}

export interface SparklineGeometry {
  /** One `M…L…` subpath per unbroken run of recorded hours. `''` if none. */
  path: string;
  /** Recorded hours with no recorded neighbour: a line can't render them. */
  dots: SparklinePoint[];
  /** Hours between the first and last recorded value — what `change` spans. */
  spanHours: number;
  first: number | null;
  latest: number | null;
}

export function sparklineGeometry(
  points: (number | null)[],
  width: number,
  height: number
): SparklineGeometry {
  const recorded = points
    .map((value, index) => ({ value, index }))
    .filter((p): p is { value: number; index: number } => p.value !== null);

  if (recorded.length === 0) {
    return { path: '', dots: [], spanHours: 0, first: null, latest: null };
  }

  const first = recorded[0];
  const last = recorded[recorded.length - 1];
  const values = recorded.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  // x stays anchored to the hour, not to the point's position among the recorded
  // ones — that's what makes a gap occupy the width of the time it covers.
  const lastIndex = points.length - 1 || 1;

  const at = (p: { value: number; index: number }): SparklinePoint => ({
    x: (p.index / lastIndex) * width,
    // Flat series sit on the mid-line rather than pinned to the floor.
    y: height - ((p.value - min) / span) * (height - 4) - 2,
  });

  const subpaths: string[] = [];
  const dots: SparklinePoint[] = [];
  let run: { value: number; index: number }[] = [];

  const flush = () => {
    if (run.length === 1) {
      dots.push(at(run[0]));
    } else if (run.length > 1) {
      subpaths.push(
        run
          .map((p, i) => {
            const { x, y } = at(p);
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ')
      );
    }
    run = [];
  };

  for (const point of recorded) {
    const previous = run[run.length - 1];
    if (previous && point.index !== previous.index + 1) flush();
    run.push(point);
  }
  flush();

  return {
    path: subpaths.join(' '),
    dots,
    spanHours: last.index - first.index,
    first: first.value,
    latest: last.value,
  };
}
