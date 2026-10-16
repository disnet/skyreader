/**
 * Format an estimated reading time for display: "8 min", "1 hr 20 min",
 * "14 hr". A book-length EPUB at "843 min" reads as noise, so past an hour the
 * estimate breaks into hours, and its precision drops with its size — minutes
 * round to the nearest 5 past the first hour (a ~200 wpm estimate has no real
 * single-minute resolution there), and past 10 hours only hours remain.
 */
export function formatReadTime(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} min`;
  if (m >= 10 * 60) return `${Math.round(m / 60)} hr`;
  const rounded = Math.round(m / 5) * 5;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}
