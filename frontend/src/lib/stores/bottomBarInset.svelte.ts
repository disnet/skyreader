/**
 * How much of the bottom edge a fixed app bar is holding right now, in px.
 *
 * Below the mobile breakpoint the bottom edge is spoken for: the feed's
 * MobileBottomBar or the reader's own bar sits flush against it. Anything else
 * that anchors to that edge — the share composer's resting minibar — has to sit
 * on top of the bar rather than in the same strip, or the two fight over the
 * same pixels and the bar's controls end up unreachable underneath.
 *
 * Those bars slide away on scroll-down, and above the breakpoint they aren't
 * rendered at all, so the inset can't be a constant. Bars claim it with their
 * measured height while they're actually on screen and release it when they
 * slide away or unmount; whoever anchors to the edge lifts by that much for as
 * long as the claim stands. Measured rather than assumed because the height a
 * bar occupies includes the safe-area inset it absorbs, which no constant knows.
 *
 * Claims are a list rather than a single value, so two bars overlapping
 * mid-transition can't have one's release cancel the other's claim — the tallest
 * standing claim wins. See `bottomRail` for the same pattern applied to the
 * refresh indicator.
 */
import { untrack } from 'svelte';

function createBottomBarInsetStore() {
  let nextId = 0;
  let claims = $state<{ id: number; height: number }[]>([]);

  return {
    /** Height of the tallest bar currently holding the edge; 0 when it's free. */
    get height() {
      return claims.reduce((max, claim) => Math.max(max, claim.height), 0);
    },
    /**
     * Claim the edge with a measured height. Returns the release function — hand
     * it straight to `$effect`, and let the effect re-run to re-claim when the
     * measurement changes.
     */
    claim(height: number) {
      const id = nextId++;
      // untrack for the same reason bottomRail does it: claims are made from
      // inside `$effect`, and appending reads the list it writes, so a tracked
      // read would make every claimant depend on every other claim and loop.
      untrack(() => {
        claims = [...claims, { id, height }];
      });
      return () =>
        untrack(() => {
          claims = claims.filter((claim) => claim.id !== id);
        });
    },
  };
}

export const bottomBarInset = createBottomBarInsetStore();
