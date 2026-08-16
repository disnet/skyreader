// OAuth scope definitions shared between the auth routes and the token-refresh
// path in services/oauth.ts. Kept here (rather than in routes/auth.ts) so the
// OAuth service can reconstruct the localhost public-client client_id during
// refresh without importing a route module (which would create a cycle).

// Granular scopes for Skyreader's custom lexicons
// Requests write access only to app.skyreader.* record collections.
// Note: saves are NOT written to the PDS (they live in D1, and optionally in a
// Semble/Margin collection via the integration scopes), so no app.skyreader.feed.saved
// scope is requested.
export const GRANULAR_SCOPES = [
  'atproto',
  'repo:app.skyreader.feed.subscription',
  'repo:app.skyreader.social.follow',
].join(' ');

// Integration-specific scopes (written to external app lexicons on user's PDS)
export const SEMBLE_SCOPES = [
  'repo:network.cosmik.card',
  'repo:network.cosmik.collection',
  'repo:network.cosmik.collectionLink',
];
export const MARGIN_SCOPES = [
  // Bookmarks are no longer a distinct collection — Margin folded them into
  // at.margin.note (motivation: 'bookmarking'), so we only need the note +
  // collection scopes.
  'repo:at.margin.note',
  'repo:at.margin.collection',
  'repo:at.margin.collectionItem',
];

// Linkblog scopes — sharing writes standard.site records to the user's PDS.
export const LINKBLOG_SCOPES = ['repo:site.standard.publication', 'repo:site.standard.document'];

// Extra scopes for a linkblog connected to a pckt or Offprint publication. Those
// apps only show posts that carry a companion record in their own collection (see
// COMPANION_COLLECTIONS), so sharing there needs write access to it.
// Deliberately NOT part of LINKBLOG_SCOPES: that set gates every share, and
// folding these in would push everyone who never touches those apps through a
// re-auth. Each is checked only when it's the user's chosen target.
export const PCKT_SCOPES = ['repo:blog.pckt.document'];
export const OFFPRINT_SCOPES = ['repo:app.offprint.document.article'];

// Atmosphere subscription scope — "subscribe via the Atmosphere" writes a
// portable site.standard.graph.subscription follow edge to the user's PDS.
// Kept separate from LINKBLOG_SCOPES (which is also used as a required-scope
// check for sharing) so adding it doesn't retroactively over-restrict shares.
export const ATMOSPHERE_SCOPES = ['repo:site.standard.graph.subscription'];

// AT Intents discovery footprint — lets Skyreader write a dev.at-intent.usage record
// into the user's OWN repo so other Atmosphere apps/agents can discover that the user
// uses Skyreader and resolve the capabilities it publishes. Deliberately kept OUT of
// GRANULAR_SCOPES (it's not required for any core Skyreader action), so requesting it
// doesn't push existing users through a hasRequiredScopes re-auth. It's only added to
// ALL_POSSIBLE_SCOPES, which is what the login/callback flow actually requests, so new
// logins pick it up and the usage write is skipped for sessions that lack it.
export const AT_INTENT_SCOPES = ['repo:dev.at-intent.usage'];

// All possible scopes (base + all integrations) — used in client metadata
export const ALL_POSSIBLE_SCOPES = [
  GRANULAR_SCOPES,
  ...SEMBLE_SCOPES,
  ...MARGIN_SCOPES,
  ...LINKBLOG_SCOPES,
  ...PCKT_SCOPES,
  ...OFFPRINT_SCOPES,
  ...ATMOSPHERE_SCOPES,
  ...AT_INTENT_SCOPES,
].join(' ');
