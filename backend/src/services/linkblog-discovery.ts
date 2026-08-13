// Linkblog discovery (Phase 6) — answer "which people I follow have a Skyreader
// linkblog?" and seed a /discover of all linkblogs.
//
// It's an intersection: (the user's Bluesky follows) ∩ (the linkblog registry).
//   - registry: every DID with a linkblog, from the proxy's one cached
//     Constellation marker query (see feed-proxy/src/linkblog-registry.ts),
//     unioned with the local list of users who connected an EXISTING publication
//     — connecting never stamps a marker on someone else's app's record, so those
//     linkblogs are real but invisible to the network-wide query.
//   - follows: the user's Bluesky follows, which already carry profile basics —
//     so "friends with linkblogs" needs no extra profile resolution.
// Everything is best-effort: a registry/follows outage yields a shorter list, not
// an error. Discovery is an adornment, never load-bearing.

import type { Env, Session } from '../types';
import { FeedProxyClient } from './feed-proxy-client';
import { fetchFollows, fetchProfiles, type BskyProfileLite } from './bsky-appview';
import {
  getConnectedLinkblogAuthors,
  getDisabledLinkblogAuthors,
  getLinkblogTargets,
  linkblogBaseUrl,
  publicationUri,
} from './linkblog-sync';

export interface LinkblogPerson {
  did: string;
  handle: string | null;
  displayName?: string;
  avatar?: string;
  // The publication to subscribe to — the author's CURRENT linkblog target, which
  // is their `skyreader-links` publication unless they've connected an existing
  // standard.site publication. Subscribing to the default after someone switched
  // would silently yield a feed that never updates again.
  publicationUri: string;
  // The public linkblog page (env-correct base URL) — used as the subscription's
  // siteUrl. Always the Skyreader linkblog site: it renders the connected
  // publication's link posts too.
  blogUrl: string;
  // Whether the requesting user already follows this person on Bluesky.
  isFollow: boolean;
}

// Cap profile resolution for non-followed authors on /discover — friends are
// unbounded (they come free from getFollows), but resolving the whole global
// registry would be wasteful. Friends are always listed first.
const MAX_DISCOVER_OTHERS = 100;

function toPerson(
  p: BskyProfileLite | { did: string },
  isFollow: boolean,
  env: Env,
  targets?: Map<string, { siteUri: string }>
): LinkblogPerson {
  const lite = p as BskyProfileLite;
  return {
    did: p.did,
    handle: lite.handle || null,
    displayName: lite.displayName,
    avatar: lite.avatar,
    publicationUri: targets?.get(p.did)?.siteUri || publicationUri(p.did),
    blogUrl: linkblogBaseUrl(env, p.did),
    isFollow,
  };
}

/**
 * Friends with linkblogs: people the user follows on Bluesky who have a linkblog.
 * Profiles come straight from getFollows, so this is one registry fetch + one
 * follows fetch with no extra resolution — cheap enough for an empty-state.
 */
export async function getLinkblogFriends(session: Session, env: Env): Promise<LinkblogPerson[]> {
  const proxy = new FeedProxyClient(env);
  const [registry, connected, disabled, follows] = await Promise.all([
    proxy.fetchLinkblogRegistry().catch(() => [] as string[]),
    getConnectedLinkblogAuthors(env),
    getDisabledLinkblogAuthors(env),
    fetchFollows(session.did),
  ]);

  const disabledSet = new Set(disabled);
  const registrySet = new Set([...registry, ...connected].filter((did) => !disabledSet.has(did)));
  const people = follows.filter((f) => f.did !== session.did && registrySet.has(f.did));
  // One batched settings lookup resolves everyone's current publication.
  const targets = await getLinkblogTargets(
    env,
    people.map((f) => f.did)
  );
  return people.map((f) => toPerson(f, true, env, targets));
}

/**
 * The whole registry for /discover: friends first (flagged `isFollow`), then a
 * capped slice of everyone else, with their profiles resolved. Excludes the
 * requesting user's own linkblog.
 */
export async function getLinkblogDiscover(session: Session, env: Env): Promise<LinkblogPerson[]> {
  const proxy = new FeedProxyClient(env);
  const [registry, connected, disabled, follows] = await Promise.all([
    proxy.fetchLinkblogRegistry().catch(() => [] as string[]),
    getConnectedLinkblogAuthors(env),
    getDisabledLinkblogAuthors(env),
    fetchFollows(session.did).catch(() => [] as BskyProfileLite[]),
  ]);

  const followMap = new Map(follows.map((f) => [f.did, f]));
  const disabledSet = new Set(disabled);
  const authors = [...new Set([...registry, ...connected])].filter(
    (did) => did !== session.did && !disabledSet.has(did)
  );

  const friendDids = authors.filter((did) => followMap.has(did));
  const otherDids = authors.filter((did) => !followMap.has(did)).slice(0, MAX_DISCOVER_OTHERS);

  // Friends already have profiles from getFollows; resolve only the rest.
  const [otherProfiles, targets] = await Promise.all([
    fetchProfiles(otherDids),
    getLinkblogTargets(env, [...friendDids, ...otherDids]),
  ]);

  return [
    ...friendDids.map((did) => toPerson(followMap.get(did)!, true, env, targets)),
    ...otherDids.map((did) => toPerson(otherProfiles.get(did) ?? { did }, false, env, targets)),
  ];
}
