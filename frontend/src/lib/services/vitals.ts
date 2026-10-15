import { browser, dev, version } from '$app/environment';

// Field vitals: does Skyreader feel crisp on readers' real devices? Three numbers
// per route view, counted server-side into daily histograms and nothing else
// (backend/src/routes/vitals.ts; docs/RUNBOOK.md, "Field vitals").
//
// - inp: the slowest interaction's input-to-next-paint (ms) — how laggy a tap felt.
//   Sent only when the view had an interaction.
// - cls: the largest burst of unexpected layout shift — how much things moved.
// - blocking: total main-thread time past 50ms per long task (ms) — jank.
//
// Same rules as the error reporter (telemetry.ts): sampled, never retried, never
// sent offline, and nothing that identifies a reader — the route goes as the
// path's first segment only (`/rooms`, never the room), which is all the
// server keeps. Browsers without these performance APIs (Safari, today, for some of
// them) just report what they can.

const API_BASE = import.meta.env.VITE_API_URL || '';

/** Per page load: a sampled load reports every view it has, the rest report none. */
const SAMPLE_RATE = 0.25;

// --- Pure measurement (unit-tested) ---

/**
 * INP from a view's interaction durations: the worst, except that for every 50
 * interactions one outlier is forgiven (the web-vitals definition), so a long
 * session isn't judged by its single unluckiest tap.
 */
export function inpFrom(durations: number[]): number | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => b - a);
  return sorted[Math.min(sorted.length - 1, Math.floor(durations.length / 50))];
}

export interface Shift {
  startTime: number;
  value: number;
}

/**
 * CLS: shifts group into session windows (each shift within 1s of the last, the
 * window at most 5s long), and the score is the largest window's sum.
 */
export function clsFrom(shifts: Shift[]): number {
  let max = 0;
  let current = 0;
  let windowStart = -Infinity;
  let last = -Infinity;
  for (const shift of shifts) {
    if (shift.startTime - last > 1000 || shift.startTime - windowStart > 5000) {
      current = 0;
      windowStart = shift.startTime;
    }
    current += shift.value;
    last = shift.startTime;
    max = Math.max(max, current);
  }
  return max;
}

// --- Collection ---

interface View {
  route: string;
  /** Worst duration per interaction id, for interactions slow enough to observe. */
  interactions: Map<number, number>;
  /** Any tap, click or key at all — most are too fast to show up above. */
  interacted: boolean;
  shifts: Shift[];
  blocking: number;
}

let view: View | null = null;
let sampled = false;
/**
 * The first view's route comes from the root layout's first afterNavigate, which
 * can run before or after startVitals — remember it either way.
 */
let firstRoute: string | null = null;

function newView(route: string): View {
  return { route, interactions: new Map(), interacted: false, shifts: [], blocking: 0 };
}

function observe(type: string, onEntry: (entry: PerformanceEntry) => void, extra = {}): void {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) onEntry(entry);
    }).observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
  } catch {
    // Not supported in this browser: that metric just isn't reported.
  }
}

/** The event observer's floor: an interaction it never saw was faster than this. */
const EVENT_THRESHOLD_MS = 40;

function send(v: View): void {
  // A view whose interactions were all fast still had an INP: under the floor.
  // Leaving it out would count only the slow views and skew every percentile.
  const inp =
    inpFrom([...v.interactions.values()]) ?? (v.interacted ? EVENT_THRESHOLD_MS - 1 : null);
  const body: Record<string, unknown> = {
    route: v.route,
    appVersion: version,
    cls: Math.round(clsFrom(v.shifts) * 10000) / 10000,
    blocking: Math.round(v.blocking),
  };
  if (inp !== null) body.inp = Math.round(inp);
  try {
    if (navigator.onLine === false) return;
    void fetch(`${API_BASE}/api/telemetry/vitals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Sent as the page hides, so it has to outlive the page.
      keepalive: true,
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {
    // Reporting must never be the thing that breaks the page.
  }
}

/**
 * Report the current view and start a fresh one. A view where nothing moved and
 * nothing blocked is reported too: it's the good case, and dropping it would
 * leave only the bad ones in the histogram.
 */
function flush(nextRoute?: string): void {
  if (!view) return;
  send(view);
  view = newView(nextRoute ?? view.route);
}

/** Start measuring. Called once, from hooks.client.ts. */
export function startVitals(): void {
  if (!browser || dev || view) return;
  sampled = Math.random() < SAMPLE_RATE;
  if (!sampled || typeof PerformanceObserver === 'undefined') return;
  view = newView(firstRoute ?? 'other');

  observe(
    'event',
    (entry) => {
      // `interactionId` is newer than the bundled DOM types.
      const e = entry as PerformanceEventTiming & { interactionId?: number };
      if (!view || !e.interactionId) return;
      const prior = view.interactions.get(e.interactionId) ?? 0;
      view.interactions.set(e.interactionId, Math.max(prior, e.duration));
    },
    // Interactions faster than this can't move INP's verdict.
    { durationThreshold: EVENT_THRESHOLD_MS }
  );
  for (const type of ['pointerdown', 'keydown']) {
    addEventListener(
      type,
      () => {
        if (view) view.interacted = true;
      },
      { capture: true, passive: true }
    );
  }
  observe('layout-shift', (entry) => {
    const e = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
    if (!view || e.hadRecentInput) return;
    view.shifts.push({ startTime: e.startTime, value: e.value });
  });
  observe('longtask', (entry) => {
    if (view) view.blocking += Math.max(0, entry.duration - 50);
  });

  // A hidden page may never come back (closed tab, killed PWA): report now.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/** The first segment of a path: `/rooms/abc` → `/rooms`. Never anything after it. */
export function routeOf(pathname: string): string {
  return `/${pathname.split('/')[1] ?? ''}`;
}

/** A client-side navigation ended one view and began another. */
export function vitalsRouteChanged(pathname: string | null | undefined): void {
  const route = pathname ? routeOf(pathname) : 'other';
  if (firstRoute === null) {
    // The initial load's own navigation: what was measured so far (the load's
    // shifts and long tasks) belongs to this route, not to a new view.
    firstRoute = route;
    if (view) view.route = route;
    return;
  }
  if (!sampled || !view || route === view.route) return;
  flush(route);
}
