/**
 * Who is showing refresh state at the bottom edge right now.
 *
 * Below the mobile breakpoint the app-wide RefreshProgressBar stands down,
 * because a bottom bar's own rail already carries the sweep at the edge the
 * thumb and eye are on, and two indicators for one refresh is one too many.
 * But a bottom bar is not always there: it slides away on scroll-down, and the
 * reader surfaces render a different bar entirely. A blanket stand-down leaves
 * mobile with no indicator at all in those gaps.
 *
 * So bars claim the job while they are actually on screen and release it when
 * they slide away or unmount, and the top bar takes it back in between. The
 * reader's bar claims unconditionally: a refresh behind an open article is not
 * the reader's business, so nothing should show there either way.
 *
 * A count rather than a flag, so two bars overlapping mid-transition can't have
 * one's release cancel the other's claim.
 */
import { untrack } from 'svelte';

function createBottomRailStore() {
  let claims = $state(0);

  // `claims += 1` reads `claims` as well as writing it, and claims are made from
  // inside `$effect`. Without `untrack` the read makes the effect a dependency of
  // the count it just changed, so it re-runs, releases, re-claims — an update
  // loop that Svelte kills with `effect_update_depth_exceeded`, taking the rest
  // of the component's effects (its click handlers included) down with it.
  const bump = (n: number) =>
    untrack(() => {
      claims += n;
    });

  return {
    /** True while some bottom bar is carrying (or deliberately swallowing) refresh state. */
    get claimed() {
      return claims > 0;
    },
    /** Claim the indicator. Returns the release function — hand it straight to `$effect`. */
    claim() {
      bump(1);
      return () => bump(-1);
    },
  };
}

export const bottomRail = createBottomRailStore();
