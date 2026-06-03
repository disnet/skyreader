// OAuth scope definitions shared between the auth routes and the token-refresh
// path in services/oauth.ts. Kept here (rather than in routes/auth.ts) so the
// OAuth service can reconstruct the localhost public-client client_id during
// refresh without importing a route module (which would create a cycle).

// Granular scopes for Skyreader's custom lexicons
// Requests write access only to app.skyreader.* record collections
export const GRANULAR_SCOPES = [
  'atproto',
  'repo:app.skyreader.feed.subscription',
  'repo:app.skyreader.social.follow',
  'repo:app.skyreader.feed.saved',
].join(' ');

// Integration-specific scopes (written to external app lexicons on user's PDS)
export const SEMBLE_SCOPES = [
  'repo:network.cosmik.card',
  'repo:network.cosmik.collection',
  'repo:network.cosmik.collectionLink',
];
export const MARGIN_SCOPES = [
  'repo:at.margin.bookmark',
  'repo:at.margin.collection',
  'repo:at.margin.collectionItem',
];

// Linkblog scopes — sharing writes standard.site records to the user's PDS.
export const LINKBLOG_SCOPES = ['repo:site.standard.publication', 'repo:site.standard.document'];

// All possible scopes (base + all integrations) — used in client metadata
export const ALL_POSSIBLE_SCOPES = [
  GRANULAR_SCOPES,
  ...SEMBLE_SCOPES,
  ...MARGIN_SCOPES,
  ...LINKBLOG_SCOPES,
].join(' ');
