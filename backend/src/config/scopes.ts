// OAuth scope definitions shared between the auth routes and the token-refresh
// path in services/oauth.ts. Kept here (rather than in routes/auth.ts) so the
// OAuth service can reconstruct the localhost public-client client_id during
// refresh without importing a route module (which would create a cycle).

import skyreaderAuthFull from '../../../lexicons/app/skyreader/authFull.json';
import {
  SEMBLE_AUTH_FULL,
  SITE_STANDARD_AUTH_FULL,
  USERINPUT_AUTH_BASIC,
} from './external-permission-sets';

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

// Permission set covering every app.skyreader.* collection Skyreader writes
// (lexicons/app/skyreader/authFull.json). Requested as `include:<nsid>`, the PDS
// resolves the published lexicon and shows its title/detail on the consent
// screen instead of one line per collection. Because the PDS re-resolves the set
// on every token refresh, adding a new app.skyreader.* collection to the set is
// picked up by live sessions without a re-auth. Sets can only cover collections
// under their own namespace, so other apps' lexicons are requested progressively
// below, through that app's own published set where one fits
// (FEATURE_PERMISSION_SET_SCOPES).
export const SKYREADER_PERMISSION_SET = skyreaderAuthFull.id;
export const SKYREADER_PERMISSION_SET_SCOPE = `include:${SKYREADER_PERMISSION_SET}`;

// Integration-specific scopes (written to external app lexicons on user's PDS)
export const SEMBLE_SCOPES = [
  'repo:network.cosmik.card',
  'repo:network.cosmik.collection',
  'repo:network.cosmik.collectionLink',
];
// Writing a Semble *connection* (a typed edge between two URLs) needs its own
// repo scope. Deliberately NOT folded into SEMBLE_SCOPES: that set is the gate on
// every existing Semble action (card saves, the collection picker, backed saves),
// so adding a scope no current session holds would 403 all of them until every
// user re-authed. Same reasoning as PCKT_SCOPES / ATMOSPHERE_SCOPES below — it
// only joins ALL_POSSIBLE_SCOPES (what login actually requests) and is checked
// solely on the connection endpoint.
export const SEMBLE_CONNECTION_SCOPES = ['repo:network.cosmik.connection'];
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

// Reading Rooms — joining a room writes a public app.skyreader.reading.readAlong
// record ("I'm reading along with this collection") to the user's own repo. Kept
// OUT of GRANULAR_SCOPES so requesting it doesn't push existing sessions through
// a re-auth; it only joins ALL_POSSIBLE_SCOPES (what login actually requests) and
// is checked solely on the join endpoint, which 403s a stale session into the
// standard scope-upgrade re-auth flow.
export const READING_ROOM_SCOPES = ['repo:app.skyreader.reading.readAlong'];

// AT Intents discovery footprint — lets Skyreader write a dev.at-intent.usage record
// into the user's OWN repo so other Atmosphere apps/agents can discover that the user
// uses Skyreader and resolve the capabilities it publishes. Deliberately kept OUT of
// GRANULAR_SCOPES (it's not required for any core Skyreader action), so requesting it
// doesn't push existing users through a hasRequiredScopes re-auth. It's only added to
// ALL_POSSIBLE_SCOPES, which is what the login/callback flow actually requests, so new
// logins pick it up and the usage write is skipped for sessions that lack it.
export const AT_INTENT_SCOPES = ['repo:dev.at-intent.usage'];

// Feedback board posting. userinput.app is backend-less: a post IS an
// app.userinput.discussion record in the author's own repo, so posting from
// Skyreader means writing that record on their behalf. Kept OUT of
// GRANULAR_SCOPES for the usual reason — every live session predates it, and
// folding it in would re-auth people who never open /feedback. The post route
// answers scope_upgrade_required without it and the board keeps its link-out.
export const USERINPUT_SCOPES = ['repo:app.userinput.discussion'];
// userinput.app's own composer upvotes the post it just made, so a post starts
// at one vote instead of zero. Split out because it is best-effort: a session
// that holds the discussion scope but not this one still posts, it just doesn't
// get the self-vote.
export const USERINPUT_VOTE_SCOPES = ['repo:app.userinput.upvote'];
// A screenshot on a post is a blob in the reader's own repo, and uploading one
// needs a blob scope on top of the record scope. Split out for the same reason
// as the vote: folding it into USERINPUT_SCOPES would tell every existing
// session it can't post at all, when all it actually can't do is attach a file.
// The composer offers the attach control only when this one is granted.
export const USERINPUT_IMAGE_SCOPES = ['blob:image/*'];

// From your follows — reading the user's Bluesky Following timeline to collect the
// links their follows share (docs/plans/FOLLOWS_LINKS_PLAN.md). An `rpc:` scope, not
// a repo one: getTimeline is an appview method the PDS proxies on the user's
// behalf, and `aud` names the service it may be proxied to. Kept OUT of
// GRANULAR_SCOPES for the usual reason: every live session predates it.
//
// What the feature needs is the appview audience (FOLLOWS_LINKS_ACCESS_SCOPES,
// what the gates check), but what it asks for is `aud=*`. rsky (Blacksky's PDS)
// checks an rpc grant against the proxy target's bare DID, so a grant naming
// `did:web:api.bsky.app#bsky_appview` never matches there and the call 403s with
// InsufficientScope. `aud=*` passes on rsky and on the reference PDS alike, and
// only for getTimeline, which is read-only. Sessions granted the narrow scope
// keep working on the reference PDS; on rsky the refresh sees the 403 and asks
// the reader to grant again (routes/follow-links.ts).
export const FOLLOWS_LINKS_ACCESS_SCOPES = [
  'rpc:app.bsky.feed.getTimeline?aud=did:web:api.bsky.app%23bsky_appview',
];
export const FOLLOWS_LINKS_SCOPES = ['rpc:app.bsky.feed.getTimeline?aud=*'];

// Also posting to Bluesky — a share can go out as an app.bsky.feed.post in the
// reader's own repo, with quoted passages attached as images ("text shots").
// The post is theirs, exactly as if they had written it in a Bluesky client. The
// blob scope is what lets those images (and a link card's thumbnail) upload.
// Kept OUT of GRANULAR_SCOPES for the usual reason: every live session predates it.
export const BLUESKY_POST_SCOPES = ['repo:app.bsky.feed.post'];
export const BLUESKY_IMAGE_SCOPES = ['blob:image/*'];

// All possible granular scopes (base + all integrations). Still part of the client
// metadata so sessions granted before permission sets / progressive requests keep
// refreshing, and so the granular fallback (permission sets disabled) can request them.
export const ALL_POSSIBLE_SCOPES = [
  GRANULAR_SCOPES,
  ...SEMBLE_SCOPES,
  ...SEMBLE_CONNECTION_SCOPES,
  ...MARGIN_SCOPES,
  ...LINKBLOG_SCOPES,
  ...PCKT_SCOPES,
  ...OFFPRINT_SCOPES,
  ...ATMOSPHERE_SCOPES,
  ...READING_ROOM_SCOPES,
  ...AT_INTENT_SCOPES,
  ...USERINPUT_SCOPES,
  ...USERINPUT_VOTE_SCOPES,
  ...USERINPUT_IMAGE_SCOPES,
  ...FOLLOWS_LINKS_SCOPES,
  // Still in the ceiling so sessions granted the narrow form keep refreshing.
  ...FOLLOWS_LINKS_ACCESS_SCOPES,
  ...BLUESKY_POST_SCOPES,
].join(' ');

// ---------------------------------------------------------------------------
// Progressive scope requests
//
// Sign-in asks only for the base scopes. Each optional feature asks for its own
// scopes the first time the reader uses it (POST /api/auth/upgrade), and the
// features a reader has granted are remembered (users.oauth_features) so the next
// sign-in asks for the same set again. See docs/OAUTH_SCOPES.md.
// ---------------------------------------------------------------------------

export type ScopeFeature =
  'semble' | 'margin' | 'linkblog' | 'pckt' | 'offprint' | 'feedback' | 'follows' | 'blueskyPost';

export const SCOPE_FEATURES: Record<ScopeFeature, string[]> = {
  semble: [...SEMBLE_SCOPES, ...SEMBLE_CONNECTION_SCOPES],
  margin: MARGIN_SCOPES,
  linkblog: LINKBLOG_SCOPES,
  // Companion records only make sense on top of a linkblog, so granting one
  // also grants the linkblog itself.
  pckt: [...LINKBLOG_SCOPES, ...PCKT_SCOPES],
  offprint: [...LINKBLOG_SCOPES, ...OFFPRINT_SCOPES],
  feedback: [...USERINPUT_SCOPES, ...USERINPUT_VOTE_SCOPES, ...USERINPUT_IMAGE_SCOPES],
  follows: FOLLOWS_LINKS_SCOPES,
  blueskyPost: [...BLUESKY_POST_SCOPES, ...BLUESKY_IMAGE_SCOPES],
};

// The scopes whose presence means a reader opted into a feature, used to
// remember features across sign-ins. Narrower than SCOPE_FEATURES where a
// feature's set grew after launch (the Semble connection scope, the feedback
// vote/image scopes): sessions granted before those additions still opted in,
// and the next request re-asks for the full SCOPE_FEATURES set anyway.
export const FEATURE_OPT_IN_SCOPES: Record<ScopeFeature, string[]> = {
  ...SCOPE_FEATURES,
  semble: SEMBLE_SCOPES,
  feedback: USERINPUT_SCOPES,
  // Either form of the getTimeline grant (the `aud=*` one covers it).
  follows: FOLLOWS_LINKS_ACCESS_SCOPES,
  // The blob scope is shared with feedback, so it can't say which one was asked for.
  blueskyPost: BLUESKY_POST_SCOPES,
};

export function isScopeFeature(value: string): value is ScopeFeature {
  return Object.prototype.hasOwnProperty.call(SCOPE_FEATURES, value);
}

// Other apps' published permission sets (see external-permission-sets.ts).
export const SITE_STANDARD_PERMISSION_SET_SCOPE = `include:${SITE_STANDARD_AUTH_FULL.id}`;
export const SEMBLE_PERMISSION_SET_SCOPE = `include:${SEMBLE_AUTH_FULL.id}`;
export const USERINPUT_PERMISSION_SET_SCOPE = `include:${USERINPUT_AUTH_BASIC.id}`;

// What each feature asks for when permission sets are on: the owning app's set,
// plus whatever it doesn't cover. The consent screen then shows one line per app
// ("Semble", "Standard.site") instead of one per collection. Must grant at least
// SCOPE_FEATURES[feature] (test/oauth-scopes.spec.ts), since gates check those.
//
// Margin, pckt and Offprint stay granular: their only sets are "full access"
// (Margin's includes API keys and preferences), far more than the one or three
// collections we write. A PDS refuses the whole authorization if an included set
// won't resolve; buildAuthorizationUrl (routes/auth.ts) then retries with the
// granular form, so an app's lexicon hosting going down costs the consent screen,
// not sign-in.
const FEATURE_PERMISSION_SET_SCOPES: Partial<Record<ScopeFeature, string[]>> = {
  semble: [SEMBLE_PERMISSION_SET_SCOPE, ...SEMBLE_CONNECTION_SCOPES],
  linkblog: [SITE_STANDARD_PERMISSION_SET_SCOPE],
  pckt: [SITE_STANDARD_PERMISSION_SET_SCOPE, ...PCKT_SCOPES],
  offprint: [SITE_STANDARD_PERMISSION_SET_SCOPE, ...OFFPRINT_SCOPES],
  feedback: [USERINPUT_PERMISSION_SET_SCOPE, ...USERINPUT_IMAGE_SCOPES],
};

/** The scopes an authorization request asks for to enable `feature`. */
export function featureScopes(
  env: { OAUTH_PERMISSION_SETS?: string },
  feature: ScopeFeature
): string[] {
  return (
    (usePermissionSets(env) && FEATURE_PERMISSION_SET_SCOPES[feature]) || SCOPE_FEATURES[feature]
  );
}

/**
 * Whether sign-in requests Skyreader's own collections through the published
 * permission set (`include:app.skyreader.authFull`) rather than one granular
 * `repo:` scope each. Off until the set is published under `_lexicon.skyreader.app`
 * — a PDS rejects the whole authorization if it can't resolve an included set.
 */
export function usePermissionSets(env: { OAUTH_PERMISSION_SETS?: string }): boolean {
  return env.OAUTH_PERMISSION_SETS === 'true';
}

// Skyreader's own collections, granular form. The permission set expands to
// exactly these (kept in sync by test/oauth-scopes.spec.ts).
export const SKYREADER_REPO_SCOPES = [
  ...GRANULAR_SCOPES.split(' ').filter((s) => s !== 'atproto'),
  ...READING_ROOM_SCOPES,
];

/**
 * What every sign-in asks for. Beyond Skyreader's own collections this carries
 * two small cross-namespace scopes that background work depends on without the
 * reader opting into anything: the standard.site follow-graph mirror that rides
 * Atmospheric sync, and the AT Intents discovery record.
 */
export function baseScopes(env: { OAUTH_PERMISSION_SETS?: string }): string[] {
  return [
    'atproto',
    ...(usePermissionSets(env) ? [SKYREADER_PERMISSION_SET_SCOPE] : SKYREADER_REPO_SCOPES),
    ...ATMOSPHERE_SCOPES,
    ...AT_INTENT_SCOPES,
  ];
}

/** The scope string for an authorization request: base + the given features. */
export function buildRequestedScopes(
  env: { OAUTH_PERMISSION_SETS?: string },
  features: Iterable<ScopeFeature>
): string {
  const scopes = new Set(baseScopes(env));
  for (const feature of features) {
    for (const scope of featureScopes(env, feature)) scopes.add(scope);
  }
  return [...scopes].join(' ');
}

/**
 * The client metadata `scope`: the ceiling every authorization request must fit
 * inside. It must stay stable across login, callback, refresh and revoke (for the
 * localhost public client it is baked into the client_id itself).
 */
export function clientMetadataScopes(env: { OAUTH_PERMISSION_SETS?: string }): string {
  return usePermissionSets(env)
    ? [
        ALL_POSSIBLE_SCOPES,
        SKYREADER_PERMISSION_SET_SCOPE,
        SITE_STANDARD_PERMISSION_SET_SCOPE,
        SEMBLE_PERMISSION_SET_SCOPE,
        USERINPUT_PERMISSION_SET_SCOPE,
      ].join(' ')
    : ALL_POSSIBLE_SCOPES;
}
