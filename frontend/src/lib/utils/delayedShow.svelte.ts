/**
 * A flag that turns on only once `condition` has held for `delayMs`, and off the
 * moment it stops. For loading indicators: a load that finishes inside the delay
 * shows nothing at all instead of a skeleton or bar that flashes and vanishes.
 *
 * Call during component init (it owns an effect).
 */
export function delayedShow(condition: () => boolean, delayMs: number) {
  let shown = $state(false);
  $effect(() => {
    if (!condition()) {
      shown = false;
      return;
    }
    const timer = setTimeout(() => (shown = true), delayMs);
    return () => clearTimeout(timer);
  });
  return {
    get current() {
      return shown;
    },
  };
}
