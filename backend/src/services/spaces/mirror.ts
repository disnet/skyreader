/**
 * Flag-gated, best-effort mirror of D1 saves into the user's personal atproto
 * Space. Spike code — see `docs/plans/SPACES_SAVES_SPIKE.md`.
 *
 * Rules this file exists to hold:
 *
 *  - **D1 stays canonical.** The mirror is a projection. Nothing here is ever
 *    awaited by an HTTP handler; every entry point swallows its own failures.
 *  - **Dead in production.** `SPACES_SAVES_ENABLED` is a `.dev.vars`-only var,
 *    absent from `wrangler.toml`. Every entry point checks it first, before any
 *    import-level work or D1 read, so with the flag unset the cost is one string
 *    comparison.
 *  - **Silent on ordinary PDSes.** No real PDS implements Spaces today. The
 *    capability probe caches its verdict (including the negative one) per isolate
 *    so a flag-on developer against bsky.social pays one failed call, not one per
 *    save.
 */

import type { Env, Session } from '../../types';
import { createPDSClient } from '../pds-client';
import { SpacesClient, PERSONAL_SPACE_APP_ACCESS, PERSONAL_SPACE_POLICY } from './client';
import { savedRowToSpaceRecord, type SavedRowForSpace } from './record';
import { SAVED_COLLECTION, SAVED_SPACE_SKEY, SAVED_SPACE_TYPE, savedSpaceRef } from './refs';
import {
  isSpaceAccessDenied,
  isSpaceAlreadyExists,
  isSpaceNotFound,
  isSpaceRequestRejected,
  isSpacesUnsupported,
  sessionCall,
} from './transport';

/** The one switch. Absent in `wrangler.toml`, so production never enters this file. */
export function spacesSavesEnabled(env: Env): boolean {
  return env.SPACES_SAVES_ENABLED === 'true';
}

/** A space client bound to the user's own PDS via their session. */
export function spacesClientForSession(session: Session): SpacesClient {
  return new SpacesClient(sessionCall(createPDSClient(session)));
}

/**
 * Why a space is or isn't available. Callers that only mirror treat every
 * non-`available` reason alike; the diff route reports them separately so a
 * transient failure isn't mistaken for "this PDS has no space".
 */
export type SavedSpaceStatus =
  'available' | 'missing' | 'unsupported' | 'denied' | 'rejected' | 'failed';

export interface SavedSpaceResolution {
  /** The space ref, or null when it isn't available. */
  space: string | null;
  status: SavedSpaceStatus;
}

interface CapabilityVerdict extends SavedSpaceResolution {
  checkedAt: number;
  ttlMs: number;
}

const CAPABILITY_TTL_MS = 10 * 60 * 1000;
/** For verdicts we can't fully trust (an ambiguous `InvalidRequest`). */
const SHORT_CAPABILITY_TTL_MS = 60 * 1000;
const capabilityCache = new Map<string, CapabilityVerdict>();

/** Test seam. */
export function clearSpaceCapabilityCache(): void {
  capabilityCache.clear();
}

/** Drop a verdict the PDS has just contradicted (e.g. the space is gone). */
function evictSpaceCapability(did: string): void {
  capabilityCache.delete(did);
}

function cacheCapability(did: string, verdict: CapabilityVerdict): void {
  // Sweep expired verdicts so the map is bounded by recently active users, not
  // every DID the isolate has ever seen (same policy as the credential cache).
  const now = Date.now();
  for (const [key, entry] of capabilityCache) {
    if (now - entry.checkedAt >= entry.ttlMs) capabilityCache.delete(key);
  }
  capabilityCache.set(did, verdict);
}

/**
 * Resolve (and, once, create) the user's saved-space.
 *
 * Personal space: the authority is the user's own DID, so there is no third
 * party to ask and no membership to grant — the owner is a member by
 * construction. `getSpace` is the probe; `createSpace` runs only when it says
 * the space isn't there.
 *
 * Returns null for "not available", which covers both "this PDS doesn't do
 * Spaces" and "the call failed" — the caller treats them identically.
 *
 * `create: false` makes this a pure probe (for read-only callers like the diff
 * route and unsaves): a missing space returns null, uncached, instead of being
 * created.
 */
export async function ensureSavedSpace(
  session: Session,
  client: SpacesClient = spacesClientForSession(session),
  options: { create?: boolean } = {}
): Promise<string | null> {
  return (await resolveSavedSpace(session, client, options)).space;
}

/** `ensureSavedSpace`, plus the reason when the space isn't available. */
export async function resolveSavedSpace(
  session: Session,
  client: SpacesClient = spacesClientForSession(session),
  { create = true }: { create?: boolean } = {}
): Promise<SavedSpaceResolution> {
  const cached = capabilityCache.get(session.did);
  if (cached && Date.now() - cached.checkedAt < cached.ttlMs) {
    return { space: cached.space, status: cached.status };
  }

  const space = savedSpaceRef(session.did);
  let verdict: string | null = null;
  let status: SavedSpaceStatus = 'available';
  let cacheVerdict = true;
  let ttlMs = CAPABILITY_TTL_MS;

  try {
    await client.getSpace(space);
    verdict = space;
  } catch (error) {
    if (isSpaceNotFound(error) && !create) {
      // Read-only probe: nothing to report yet, and nothing worth caching.
      status = 'missing';
      cacheVerdict = false;
    } else if (isSpaceNotFound(error)) {
      try {
        const created = await client.createSpace({
          spaceType: SAVED_SPACE_TYPE,
          skey: SAVED_SPACE_SKEY,
          readPolicy: PERSONAL_SPACE_POLICY,
          writePolicy: PERSONAL_SPACE_POLICY,
          appAccess: PERSONAL_SPACE_APP_ACCESS,
        });
        verdict = created.uri || space;
      } catch (createError) {
        if (isSpaceAlreadyExists(createError)) {
          // A concurrent save created it between our probe and our create.
          verdict = space;
        } else {
          // Creation may have failed after the capability probe succeeded. Let a
          // later save retry instead of turning that outage into a negative TTL.
          status = 'failed';
          cacheVerdict = false;
          console.warn('[spaces] createSpace failed', describe(createError));
        }
      }
    } else if (isSpacesUnsupported(error)) {
      // Expected for ordinary PDSes. Cache this so a developer with the spike
      // enabled pays for the capability probe only once per TTL.
      status = 'unsupported';
      console.warn('[spaces] PDS does not support Spaces', describe(error));
    } else if (isSpaceAccessDenied(error)) {
      // Includes an OAuth session with no space scope — stable for the TTL.
      status = 'denied';
      console.warn('[spaces] getSpace unavailable', describe(error));
    } else if (isSpaceRequestRejected(error)) {
      // Either an ordinary PDS refusing an unknown method, or a Spaces PDS
      // rejecting our parameters (e.g. a space-ref format change between alpha
      // releases). Don't claim which; cache briefly so neither case floods.
      status = 'rejected';
      ttlMs = SHORT_CAPABILITY_TTL_MS;
      console.warn('[spaces] getSpace rejected the request', describe(error));
    } else {
      // A network or server failure says nothing about capability. Do not turn
      // it into a ten-minute negative verdict; the next save should retry.
      status = 'failed';
      cacheVerdict = false;
      console.warn('[spaces] getSpace failed transiently', describe(error));
    }
  }

  if (cacheVerdict) {
    cacheCapability(session.did, { space: verdict, status, checkedAt: Date.now(), ttlMs });
  }
  return { space: verdict, status };
}

const SAVED_ROW_COLUMNS =
  'rkey, url, title, author, description, content_type, domain, image, word_count, published_at, saved_at, source, item_guid';

/**
 * Mirror one save into the space. Call inside `ctx.waitUntil` — it never throws
 * and never returns anything the request path should branch on.
 */
export async function mirrorSaveToSpace(
  env: Env,
  session: Session,
  rkey: string,
  /** Test seam; built only once the flag check has passed. */
  injectedClient?: SpacesClient
): Promise<void> {
  if (!spacesSavesEnabled(env)) return;

  try {
    const row = await env.DB.prepare(
      `SELECT ${SAVED_ROW_COLUMNS} FROM saved_articles WHERE user_did = ? AND rkey = ?`
    )
      .bind(session.did, rkey)
      .first<SavedRowForSpace>();

    if (!row) return;

    // One client for every call below, so a DPoP nonce learned on one is reused
    // by the next. (PDSClient instances don't share nonces, so on a warm
    // capability cache — no probe — the put itself takes the nonce challenge.)
    const client = injectedClient ?? spacesClientForSession(session);
    let space = await ensureSavedSpace(session, client);
    if (!space) return;

    const record = savedRowToSpaceRecord(row);
    const put = (target: string) =>
      client.putRecord({
        space: target,
        repo: session.did,
        collection: SAVED_COLLECTION,
        // Same rkey as D1, so the mapping between the two stores is implicit and
        // no migration or join table is needed.
        rkey: row.rkey,
        record: record as unknown as Record<string, unknown>,
      });

    try {
      await put(space);
    } catch (error) {
      if (!isSpaceNotFound(error)) throw error;
      // The cached verdict is stale — the space was deleted or reset since. Drop
      // it, re-resolve (recreating the space), and retry once.
      evictSpaceCapability(session.did);
      space = await ensureSavedSpace(session, client);
      if (!space) return;
      await put(space);
    }

    // Mirror writes and deletes run as unordered waitUntil tasks, so an unsave
    // can finish its deleteRecord before this put lands. Re-check D1 and retract
    // the record if the save is already gone — D1 is canonical.
    const stillSaved = await env.DB.prepare(
      'SELECT 1 FROM saved_articles WHERE user_did = ? AND rkey = ?'
    )
      .bind(session.did, rkey)
      .first();
    if (!stillSaved) {
      await client.deleteRecord({ space, repo: session.did, collection: SAVED_COLLECTION, rkey });
    }
  } catch (error) {
    console.warn('[spaces] mirrorSaveToSpace failed', { rkey, error: describe(error) });
  }
}

/**
 * Remove saves from the space. Same contract as `mirrorSaveToSpace`.
 *
 * Takes every rkey an unsave removed so they share one probe and one client
 * (one DPoP nonce) rather than racing N of each. Never creates the space: a
 * missing space has nothing to delete.
 */
export async function mirrorDeleteFromSpace(
  env: Env,
  session: Session,
  rkeys: string | string[],
  /** Test seam; built only once the flag check has passed. */
  injectedClient?: SpacesClient
): Promise<void> {
  if (!spacesSavesEnabled(env)) return;
  const keys = typeof rkeys === 'string' ? [rkeys] : rkeys;
  if (keys.length === 0) return;

  try {
    const client = injectedClient ?? spacesClientForSession(session);
    const space = await ensureSavedSpace(session, client, { create: false });
    if (!space) return;

    for (const rkey of keys) {
      try {
        await client.deleteRecord({ space, repo: session.did, collection: SAVED_COLLECTION, rkey });
      } catch (error) {
        if (isSpaceNotFound(error)) {
          // The space is gone, so the records are too. Drop the stale verdict.
          evictSpaceCapability(session.did);
          return;
        }
        console.warn('[spaces] mirrorDeleteFromSpace failed', { rkey, error: describe(error) });
      }
    }
  } catch (error) {
    console.warn('[spaces] mirrorDeleteFromSpace failed', { rkeys: keys, error: describe(error) });
  }
}

/**
 * Read every mirrored save row for a user, in the shape the record mapping wants.
 * Backed saves (record_uri NULL) are never mirrored, so counting them would report
 * drift no mirror path can ever close.
 */
export async function readSavedRowsForSpace(env: Env, did: string): Promise<SavedRowForSpace[]> {
  const result = await env.DB.prepare(
    `SELECT ${SAVED_ROW_COLUMNS} FROM saved_articles
     WHERE user_did = ? AND record_uri IS NOT NULL ORDER BY saved_at DESC`
  )
    .bind(did)
    .all<SavedRowForSpace>();
  return result.results ?? [];
}

function describe(error: unknown): string {
  if (error instanceof Error)
    return `${(error as { code?: string }).code ?? error.name}: ${error.message}`;
  return String(error);
}
