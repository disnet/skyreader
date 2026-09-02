/**
 * The tier limits as they appear in copy, mirrored from
 * `backend/src/config/tier-limits.ts` (the enforcing side).
 *
 * A signed-in reader's own limits come from the server (`auth.user.limits`) and
 * Settings shows those. These are for the copy that names a tier the reader
 * isn't on — the landing page's plan ledger and the Supporter pitch, which a
 * signed-out visitor reads with no user at all. Pre-formatted because every use
 * is prose.
 */

const display = (n: number) => n.toLocaleString('en-US');

const FREE = { subscriptions: 100, urlSavesPerMonth: 100, mirroredSubscriptions: 1000 };
const SUPPORTER = { subscriptions: 1000, urlSavesPerMonth: 1000, mirroredSubscriptions: 5000 };

export const freeLimits = {
  feeds: display(FREE.subscriptions),
  saves: display(FREE.urlSavesPerMonth),
  mirrored: display(FREE.mirroredSubscriptions),
};

export const supporterLimits = {
  feeds: display(SUPPORTER.subscriptions),
  saves: display(SUPPORTER.urlSavesPerMonth),
  mirrored: display(SUPPORTER.mirroredSubscriptions),
};
