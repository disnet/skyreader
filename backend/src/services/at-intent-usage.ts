import type { Session } from '../types';
import { createPDSClient } from './pds-client';
import { generateTid } from '../utils/tid';
import { AT_INTENT_SCOPES } from '../config/scopes';
import { SKYREADER_APP_DID } from '../config/identity';

// AT Intents discovery footprint.
//
// When a person uses Skyreader, we write a `dev.at-intent.usage` record into THEIR repo
// that points back at Skyreader's app DID. That's the signal other Atmosphere apps and
// agents scan for to discover that this user uses Skyreader and resolve the
// `dev.at-intent.capability` records Skyreader publishes (see at-intent/capabilities.json).
//
// Self-asserted and best-effort: only an app the user has already granted repo write
// access can create one, and a failure here must never break the login flow — always
// call this fire-and-forget (ctx.waitUntil).

// Skyreader's atproto identity (the `app` value consumers resolve back from a usage
// record). Shared with the service-auth verifier — see config/identity.ts.
const APP_DID = SKYREADER_APP_DID;

const USAGE_COLLECTION = 'dev.at-intent.usage';
const USAGE_SCOPE = AT_INTENT_SCOPES[0]; // 'repo:dev.at-intent.usage'

interface UsageRecord {
  $type: string;
  app: string;
  lastSeenAt: string;
  createdAt: string;
}

function rkeyFromUri(uri: string): string {
  return uri.split('/').pop() || '';
}

// Write or refresh the usage footprint in the user's repo. Idempotent and deduped by
// `app` per the lexicon (which uses tid record keys, so we can't address the record by a
// fixed key): we list existing usage records, reuse the rkey of any that already points
// at our app DID (preserving its createdAt and only bumping lastSeenAt), and otherwise
// mint a fresh TID. Consumers age handlers out by lastSeenAt, so refreshing it on each
// login is the point.
export async function writeUsageRecord(session: Session): Promise<void> {
  // Skip silently if the user hasn't granted the usage write scope (e.g. a session that
  // predates AT_INTENT_SCOPES, or a PDS that didn't grant it).
  if (!session.grantedScopes?.split(' ').includes(USAGE_SCOPE)) {
    return;
  }

  const pds = createPDSClient(session);
  const now = new Date().toISOString();

  // Find an existing usage record for our app, if any.
  let rkey: string | null = null;
  let createdAt = now;
  const existing = await pds.listRecords<UsageRecord>(USAGE_COLLECTION);
  if (existing.success) {
    const mine = existing.data.records.find((r) => r.value?.app === APP_DID);
    if (mine) {
      rkey = rkeyFromUri(mine.uri);
      createdAt = mine.value.createdAt || now;
    }
  }
  // listRecords failing (e.g. the collection doesn't exist yet) just means "no record" —
  // fall through to a fresh create.

  const record: UsageRecord = {
    $type: USAGE_COLLECTION,
    app: APP_DID,
    lastSeenAt: now,
    createdAt,
  };

  const result = await pds.putRecord(USAGE_COLLECTION, rkey ?? generateTid(), record);
  if (!result.success) {
    console.error(`[at-intent] usage write failed for ${session.did}: ${result.error}`);
  }
}
