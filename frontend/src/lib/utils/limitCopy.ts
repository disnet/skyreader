import type { SyncLimitNotice } from '$lib/services/api';

/**
 * The sentences shown when a reader hits a plan limit. They live here, not in
 * the ten call sites, so the same wall is never described two different ways.
 *
 * The mental model these have to protect: nothing is destroyed at a limit.
 * Feeds over the active cap are *parked* (kept, still on the PDS, reactivatable)
 * and saves are capped per calendar month, not forever. Copy that says "remove
 * some feeds" tells the reader to throw away data they don't need to.
 */

/**
 * Active-feed cap. `max` comes from `auth.user.limits.maxSubscriptions`.
 *
 * `onSources` drops the "from Sources" pointer for call sites that are already
 * on that page — the sentence stays one string in one place either way.
 */
export function feedLimitLine(max: number, opts?: { onSources?: boolean }): string {
  const where = opts?.onSources
    ? 'Park a feed to free a slot.'
    : 'Park a feed from Sources to free a slot.';
  return `You're at your ${max.toLocaleString()}-feed active limit. ${where}`;
}

/**
 * Monthly URL-save cap. `resetsAt` is the backend's ISO timestamp for the first
 * of next month (UTC); omitted when a caller only knows the ceiling.
 */
export function saveLimitLine(limit: number, resetsAt?: string): string {
  const used = `You've used all ${limit.toLocaleString()} saves this month.`;
  if (!resetsAt) return used;
  const when = new Date(resetsAt);
  if (Number.isNaN(when.getTime())) return used;
  // Rendered in UTC, not local time. The backend picks UTC midnight on the 1st,
  // so formatting locally prints "Resets August 31" to everyone west of UTC — a
  // date that has already passed by the time they read it.
  return `${used} Resets ${when.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })}.`;
}

/**
 * Total mirrored-subscription cap (active + parked). Beyond it, records aren't
 * mirrored into D1 at all, so they stay on the PDS and reappear on a later sync
 * once there's room.
 */
export function mirrorLimitLine(max: number): string {
  return `Your plan mirrors ${max.toLocaleString()} subscriptions. The rest stay on your PDS and come back when you free room.`;
}

/**
 * The sentence for one cap a sync ran into. The backend sends the same fact as
 * prose, but only after the client has added up every batch can the number be
 * stated once and correctly, so the wording is rebuilt here from the counts.
 * Keep in step with the `message` strings in
 * backend/src/services/{subscription,atmosphere-subscription}-sync.ts.
 */
export function syncNoticeLine(notice: SyncLimitNotice): string {
  const { kind, subject, count, limit } = notice;
  if (count === undefined || limit === undefined || subject === undefined) {
    // An older backend that only sent prose.
    return notice.message;
  }
  const one = count === 1;
  const n = count.toLocaleString();
  const cap = limit.toLocaleString();
  const thing =
    subject === 'linkblogs' ? `followed linkblog${one ? '' : 's'}` : `feed${one ? '' : 's'}`;

  if (kind === 'feeds') {
    const tail = subject === 'linkblogs' ? '' : ', still saved to your account and just not shown';
    return (
      `${n} ${thing} over your plan's active limit of ${cap} ${one ? 'was' : 'were'} parked${tail}. ` +
      `Reactivate from Manage feeds.`
    );
  }

  return subject === 'linkblogs'
    ? `${n} ${thing} over your plan's mirror limit of ${cap} ${one ? 'was' : 'were'} not imported. ` +
        `${one ? 'It stays' : 'They stay'} in your Atmosphere graph.`
    : `${n} ${thing} over your plan's mirror limit of ${cap} ${one ? 'was' : 'were'} not synced to this device. ` +
        `${one ? 'It is' : 'They are'} still on your PDS.`;
}

/**
 * A full sync is a loop of batch calls, and each batch reports only what *it*
 * parked or dropped. Deduping on the sentence therefore fails exactly when it
 * matters — "20 feeds were parked" and "30 feeds were parked" are different
 * strings — and the reader gets a stack of numbers, none of them the total.
 * So notices are merged on what they're about and their counts summed, leaving
 * one true line per cap.
 */
export function mergeNotices(notices: SyncLimitNotice[]): SyncLimitNotice[] {
  const byKey = new Map<string, SyncLimitNotice>();
  for (const notice of notices) {
    // A notice with no count can't be summed; fall back to one line per message.
    const key =
      notice.count === undefined ? `msg:${notice.message}` : `${notice.kind}|${notice.subject}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...notice });
      continue;
    }
    if (seen.count !== undefined && notice.count !== undefined) {
      seen.count += notice.count;
      // The cap is the reader's plan, identical across batches; take the last
      // in case a plan change landed mid-sync.
      seen.limit = notice.limit;
    }
  }
  return [...byKey.values()].map((n) => ({ ...n, message: syncNoticeLine(n) }));
}
