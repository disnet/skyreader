// Portable "subscribe via the Atmosphere" record.
//
// When a user follows someone's linkblog, we also write a standard.site
// `site.standard.graph.subscription` to their PDS — the portable, public
// follow edge that any Atmospheric app (or standard.site reader) can see. This
// is gated behind Atmospheric sync (pds_sync_enabled), the same opt-in that
// governs whether the subscription/feed list is mirrored to the PDS.
//
// See https://standard.site/docs/lexicons/subscription/.

import type { Session } from '../types';
import { createPDSClient, type PDSResult, type PutRecordResponse } from './pds-client';

export const SUBSCRIPTION_COLLECTION = 'site.standard.graph.subscription';

// The publication NSID a linkblog follow points at. A linkblog subscription is an
// `atproto.documents` stream whose feedUrl is the publication's AT-URI.
const PUBLICATION_NSID = 'site.standard.publication';

interface SubscriptionRecord {
  $type: string;
  publication: string; // AT-URI of the site.standard.publication being followed
  createdAt: string;
}

// Whether a value is the AT-URI of a `site.standard.publication` record — the
// only thing one can "subscribe to in the Atmosphere".
export function isPublicationUri(uri: string | undefined | null): uri is string {
  return !!uri && uri.startsWith('at://') && uri.includes(`/${PUBLICATION_NSID}/`);
}

// A linkblog follow is an `atproto.documents` subscription whose feedUrl is the
// AT-URI of a `site.standard.publication` record. Returns that publication URI
// when the subscription is one of those (so it warrants a portable graph edge),
// or null for an ordinary RSS / collection subscription.
export function linkblogPublicationUri(
  sourceType: string | undefined | null,
  feedUrl: string | undefined | null
): string | null {
  if (sourceType !== 'atproto.documents') return null;
  return isPublicationUri(feedUrl) ? feedUrl : null;
}

// Deterministic rkey derived from the publication URI, so subscribing is
// idempotent (a re-follow overwrites rather than duplicating) and unsubscribing
// can delete the exact record without a list-and-match. SHA-256 → hex prefix is
// within the rkey charset and collision-safe at this scale. (These records live
// in a non-bsky collection the PDS doesn't lexicon-validate, so a custom rkey is
// accepted — same as our fixed `skyreader-links` publication rkey.)
export async function subscriptionRkey(publicationUri: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicationUri));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return `sub-${hex}`;
}

export async function writeAtmosphereSubscription(
  session: Session,
  publicationUri: string
): Promise<PDSResult<PutRecordResponse>> {
  const rkey = await subscriptionRkey(publicationUri);
  const record: SubscriptionRecord = {
    $type: SUBSCRIPTION_COLLECTION,
    publication: publicationUri,
    createdAt: new Date().toISOString(),
  };
  return createPDSClient(session).putRecord(SUBSCRIPTION_COLLECTION, rkey, record);
}

export async function deleteAtmosphereSubscription(
  session: Session,
  publicationUri: string
): Promise<PDSResult<void>> {
  const rkey = await subscriptionRkey(publicationUri);
  return createPDSClient(session).deleteRecord(SUBSCRIPTION_COLLECTION, rkey);
}

// Whether the user already has a subscription record for this publication. A
// missing record reads as not-subscribed (getRecord returns success:false for a
// 404); a transient error also reads as false, which is safe — the caller's
// follow-up write is idempotent.
export async function getAtmosphereSubscription(
  session: Session,
  publicationUri: string
): Promise<boolean> {
  const rkey = await subscriptionRkey(publicationUri);
  const result = await createPDSClient(session).getRecord(SUBSCRIPTION_COLLECTION, rkey);
  return result.success;
}
