/**
 * Does this feed URL look like one only its reader should hold? Member-only
 * podcast feeds and feeds signed with a personal token work for anyone who has
 * the link, so publishing the link publishes the access. Atmospheric sync makes
 * the feed list public on the reader's PDS, so the add flows ask first.
 *
 * A guess from the URL alone, tuned to stay quiet: it names the signal it saw
 * so the prompt can say why, and misses rather than nags on ordinary feeds.
 */

export type PrivateFeedSignal =
  /** user:pass@ in the URL. */
  | 'credentials'
  /** A query parameter named like a key or token, e.g. ?token=… */
  | 'token'
  /** A host that serves member-only feeds (Patreon, Supercast, …). */
  | 'member-host'
  /** A path that says so: /private/, Pinboard's secret: feeds. */
  | 'private-path';

// Hosts whose feeds are, by design, one link per paying member or one inbox per
// reader. Matched on the registrable suffix, so subdomains count.
const MEMBER_FEED_HOSTS = [
  'patreon.com',
  'supercast.com',
  'supercast.tech',
  'memberful.com',
  'supportingcast.fm',
  'glow.fm',
  'kill-the-newsletter.com',
  'passport.online',
];

// Query parameter names that carry a secret. Matched whole or as a suffix after
// a separator (feed_key, access-token), plus a few that are never anything
// else wherever they appear in the name. `auth` stays whole-word: ?author= is a
// common, public feed filter.
const SECRET_PARAM_EXACT = /^(key|auth|sig|pass|pw|passkey|jwt)$/;
const SECRET_PARAM_SUFFIX = /[_-](key|auth|sig|pass|id_secret)$/;
const SECRET_PARAM_ANYWHERE = /token|apikey|secret|passw|signature|credential/;

export function privateFeedSignal(feedUrl: string): PrivateFeedSignal | null {
  let url: URL;
  try {
    url = new URL(feedUrl);
  } catch {
    return null;
  }

  if (url.username || url.password) return 'credentials';

  for (const [name, value] of url.searchParams) {
    if (!value) continue;
    const n = name.toLowerCase();
    if (
      SECRET_PARAM_EXACT.test(n) ||
      SECRET_PARAM_SUFFIX.test(n) ||
      SECRET_PARAM_ANYWHERE.test(n)
    ) {
      return 'token';
    }
  }

  const host = url.hostname.toLowerCase();

  // Reddit's private feeds (inbox, saved, front page) are signed with
  // ?feed=<hash>&user=<name>.
  if (
    (host === 'reddit.com' || host.endsWith('.reddit.com')) &&
    url.searchParams.get('feed') &&
    url.searchParams.get('user')
  ) {
    return 'token';
  }
  if (MEMBER_FEED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return 'member-host';
  }

  // Substack's paid podcast feeds live under /feed/podcast/<id>/private/<uuid>.
  // Raw, not decoded: a malformed escape would throw, and Pinboard's colon may
  // arrive as %3A.
  const path = url.pathname.toLowerCase();
  // Instapaper's per-reader feeds live under /rss/<id>/<token>.
  if (/\/private(\/|\.|$)/.test(path) || /\/secret(:|%3a)/.test(path)) return 'private-path';
  if ((host === 'instapaper.com' || host === 'www.instapaper.com') && path.startsWith('/rss/')) {
    return 'private-path';
  }

  return null;
}

/** One clause on why the prompt appeared, for the line under its heading. */
export function privateFeedReason(signal: PrivateFeedSignal): string {
  switch (signal) {
    case 'credentials':
      return 'Its link contains a username and password.';
    case 'token':
      return 'Its link carries what looks like a personal key.';
    case 'member-host':
      return 'It comes from a service that gives each member their own feed link.';
    case 'private-path':
      return 'Its link is marked private.';
  }
}
