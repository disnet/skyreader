/**
 * Dev-build counters for work the UI should do a bounded amount of, read by the
 * responsiveness e2e spec (`e2e/responsiveness.spec.ts`) through
 * `window.__skyreaderWork`. Counting work rather than timing it gives CI a
 * deterministic budget: "marking one item read re-checks one card's labels",
 * not "it took under N ms on whatever runner this was".
 *
 * `import.meta.env.DEV` is a build-time constant, so production builds drop
 * the counting entirely.
 */

export type WorkCounter = 'sanitize' | 'cardLabels';

declare global {
  interface Window {
    __skyreaderWork?: Partial<Record<WorkCounter, number>>;
  }
}

export function countWork(name: WorkCounter): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  const counts = (window.__skyreaderWork ??= {});
  counts[name] = (counts[name] ?? 0) + 1;
}
