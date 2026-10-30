// Margin note writes by rkey: which are still out, and when each last started.
//
// The Margin highlight sync reads the note records back and lets Margin win, so
// it has to know when one of the reader's own writes may not be in the listing
// it just read: a PUT still in flight, or one that landed just after the
// listing was taken. The sync queue can't say — a direct online write never
// enters it, and a queued one leaves it the moment it drains.

const startedAt = new Map<string, number>();
const inFlight = new Map<string, number>();

/** Record a write to this note starting; call the returned function when it settles. */
export function trackMarginWrite(rkey: string): () => void {
  startedAt.set(rkey, Date.now());
  inFlight.set(rkey, (inFlight.get(rkey) ?? 0) + 1);
  return () => {
    const left = (inFlight.get(rkey) ?? 1) - 1;
    if (left > 0) inFlight.set(rkey, left);
    else inFlight.delete(rkey);
  };
}

/** Notes with a write still out, or one started at or after `since`. */
export function marginRkeysWrittenSince(since: number): Set<string> {
  const rkeys = new Set(inFlight.keys());
  for (const [rkey, at] of startedAt) if (at >= since) rkeys.add(rkey);
  return rkeys;
}

/** Test seam. */
export function resetMarginWrites(): void {
  startedAt.clear();
  inFlight.clear();
}
