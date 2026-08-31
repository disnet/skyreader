import type { SyncLimitNotice } from '$lib/services/api';
import { mergeNotices } from '$lib/utils/limitCopy';

/**
 * What the last Atmospheric sync had to tell the reader: plan caps it ran into,
 * and failures along the way.
 *
 * This is a store rather than component state because of when a sync reports.
 * The place a reader most often turns sync on is the empty-library screen — and
 * that screen exists only while the library is empty, so the moment the sync
 * pulls a feed it unmounts. Notices owned by it would be destroyed at exactly
 * the moment they became worth reading ("100 landed, 50 were parked"). Held
 * here, they survive the library filling up and the navigation that follows,
 * and the reader dismisses them when they're done.
 *
 * Limit notices and warnings are kept apart on purpose: a cap is a fact about
 * the plan and carries an upgrade route, a failure is a bug and must not be
 * sold against.
 */

let limitNotices = $state<SyncLimitNotice[]>([]);
let warnings = $state<string[]>([]);

/** Replace what's shown with the results of one complete sync run. */
function report(notices: SyncLimitNotice[], syncWarnings: string[]) {
  limitNotices = mergeNotices(notices);
  warnings = [...new Set(syncWarnings)];
}

function clear() {
  limitNotices = [];
  warnings = [];
}

export const syncNoticesStore = {
  get limitNotices() {
    return limitNotices;
  },
  get feedNotices() {
    return limitNotices.filter((n) => n.kind === 'feeds');
  },
  get mirrorNotices() {
    return limitNotices.filter((n) => n.kind === 'mirror');
  },
  get warnings() {
    return warnings;
  },
  get isEmpty() {
    return limitNotices.length === 0 && warnings.length === 0;
  },
  report,
  clear,
};
