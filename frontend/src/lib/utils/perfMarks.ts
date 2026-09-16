/**
 * Dev-only interaction timing for the two transitions this app is judged on:
 * opening the mobile switcher, and switching views.
 *
 * Deliberately NOT a telemetry stream. Per the Observability ADR the client
 * reports errors only; adding a third channel for perf samples is a product
 * decision, not a perf fix. If field data is ever wanted it goes through the
 * existing `/api/telemetry` route. So everything here is behind
 * `import.meta.env.DEV` and compiles away in a production build.
 *
 * The measurement that matters is tap → *painted*, not tap → state-changed.
 * `endOnPaint` waits for the frame after the next rAF (the double-rAF trick):
 * the first callback runs before the commit that renders our DOM change, the
 * second after it, so the mark lands on the other side of the paint.
 */

const ENABLED =
  import.meta.env.DEV &&
  typeof performance !== 'undefined' &&
  typeof performance.mark === 'function';

/** Interaction names, so the marks are greppable in a Performance trace. */
export const PERF_SHEET_OPEN = 'skyreader:sheet-open';
export const PERF_VIEW_SWITCH = 'skyreader:view-switch';

const pending = new Set<string>();

/** Mark the start of an interaction. Call this in the tap handler, before the
 *  state change whose render cost we're trying to see. */
export function perfBegin(name: string): void {
  if (!ENABLED) return;
  try {
    performance.mark(`${name}:start`);
    pending.add(name);
  } catch {
    // performance marks are best-effort; never let instrumentation throw
  }
}

/** Close an interaction once the browser has painted the resulting frame.
 *  No-ops if nothing began this interaction (e.g. the sheet opened by a route
 *  restore rather than a tap), so stray calls can't invent measurements. */
export function perfEndOnPaint(name: string): void {
  if (!ENABLED || !pending.has(name)) return;
  pending.delete(name);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        performance.measure(name, `${name}:start`);
        const entries = performance.getEntriesByName(name, 'measure');
        const last = entries[entries.length - 1];
        if (last) console.debug(`[perf] ${name} ${Math.round(last.duration)}ms`);
      } catch {
        // the start mark may have been cleared; nothing to report
      }
    });
  });
}

/** Drop a pending interaction without measuring it (the interaction was
 *  superseded — e.g. the sheet closed before it ever painted). */
export function perfCancel(name: string): void {
  pending.delete(name);
}
