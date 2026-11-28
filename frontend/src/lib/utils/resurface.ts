// "Come back to this": a save the reader asked to see again later. Synced as the
// `resurface` item label (see `stores/itemLabels`), last write wins; clearing it
// deletes the label. When `at` passes, the save shows in Home's Back again lane
// until the reader opens it or puts it off. Pure, so the date rules are tested
// without the page. See docs/plans/REREADING.md.

export interface ResurfaceProps {
  /** When the save comes back (epoch ms). */
  at: number;
  /** When the reader asked (epoch ms): "you asked in March". */
  setAt: number;
}

export type ResurfaceChoice = '2w' | '1m' | '3m';

export const RESURFACE_CHOICES: { id: ResurfaceChoice; label: string }[] = [
  { id: '2w', label: 'In 2 weeks' },
  { id: '1m', label: 'In a month' },
  { id: '3m', label: 'In 3 months' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight at the start of `ms`'s day. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The moment a choice comes back: the start of that day, local time, so a piece
 * set for "in 2 weeks" in the evening is waiting that morning, not that evening.
 */
export function resurfaceAtFor(choice: ResurfaceChoice, now: number): number {
  const d = new Date(startOfDay(now));
  if (choice === '2w') {
    d.setDate(d.getDate() + 14);
    return d.getTime();
  }
  // Months by the calendar, held to the target month's last day: 31 Jan plus a
  // month is 28 Feb, not 3 March.
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + (choice === '1m' ? 1 : 3));
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d.getTime();
}

/**
 * A picked calendar day (`YYYY-MM-DD`, as a date input gives it) as the start of
 * that day, local time, or null when it isn't a day after today.
 */
export function resurfaceAtForDate(value: string, now: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime()) || d.getDate() !== Number(m[3])) return null;
  return d.getTime() > startOfDay(now) ? d.getTime() : null;
}

/** Tomorrow as a date input's `min`. */
export function tomorrowInputValue(now: number): string {
  return dateInputValue(startOfDay(now) + DAY_MS + DAY_MS / 2);
}

export function dateInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Synced props are user data: only trust a pair of finite times. */
export function isResurfaceProps(value: unknown): value is ResurfaceProps {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.at === 'number' &&
    Number.isFinite(v.at) &&
    typeof v.setAt === 'number' &&
    Number.isFinite(v.setAt)
  );
}

export function isResurfaceDue(props: ResurfaceProps, now: number): boolean {
  return props.at <= now;
}

/** "12 Dec", or "12 Dec 2027" when it isn't this year. */
export function formatResurfaceDay(ms: number, now: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** A menu's label for a save the reader asked to come back to, or not. */
export function resurfaceMenuLabel(props: ResurfaceProps | null, now: number): string {
  if (!props) return 'Come back to this';
  const day = formatResurfaceDay(props.at, now);
  return isResurfaceDue(props, now) ? `Came back ${day}` : `Comes back ${day}`;
}

/** "March" for this year, "March 2025" for another: when the reader asked. */
export function formatAskedWhen(ms: number, now: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * Due saves for the Back again lane: the longest-waiting first, so nothing that
 * came due a while ago sinks under today's.
 */
export function dueFirst<T>(entries: { item: T; props: ResurfaceProps }[], now: number): T[] {
  return entries
    .filter((e) => isResurfaceDue(e.props, now))
    .sort((a, b) => a.props.at - b.props.at)
    .map((e) => e.item);
}
