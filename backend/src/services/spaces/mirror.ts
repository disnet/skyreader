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
  isSpaceNotFound,
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

interface CapabilityVerdict {
  /** The space ref, or null when this PDS can't host one. */
  space: string | null;
  checkedAt: number;
}

const CAPABILITY_TTL_MS = 10 * 60 * 1000;
const capabilityCache = new Map<string, CapabilityVerdict>();

/** Test seam. */
export function clearSpaceCapabilityCache(): void {
  capabilityCache.clear();
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
 */
export async function ensureSavedSpace(
  session: Session,
  client: SpacesClient = spacesClientForSession(session)
): Promise<string | null> {
  const cached = capabilityCache.get(session.did);
  if (cached && Date.now() - cached.checkedAt < CAPABILITY_TTL_MS) {
    return cached.space;
  }

  const space = savedSpaceRef(session.did);
  let verdict: string | null = null;
  let cacheVerdict = true;

  try {
    await client.getSpace(space);
    verdict = space;
  } catch (error) {
    if (isSpaceNotFound(error)) {
      try {
        const created = await client.createSpace({
          type: SAVED_SPACE_TYPE,
          skey: SAVED_SPACE_SKEY,
          policy: PERSONAL_SPACE_POLICY,
          appAccess: PERSONAL_SPACE_APP_ACCESS,
        });
        verdict = created.uri || space;
      } catch (createError) {
        // Creation may have failed after the capability probe succeeded. Let a
        // later save retry instead of turning that outage into a negative TTL.
        cacheVerdict = false;
        console.warn('[spaces] createSpace failed', describe(createError));
      }
    } else if (isSpacesUnsupported(error)) {
      // Expected for ordinary PDSes. Cache this so a developer with the spike
      // enabled pays for the capability probe only once per TTL.
      console.warn('[spaces] PDS does not support Spaces', describe(error));
    } else if (isSpaceAccessDenied(error)) {
      console.warn('[spaces] getSpace unavailable', describe(error));
    } else {
      // A network or server failure says nothing about capability. Do not turn
      // it into a ten-minute negative verdict; the next save should retry.
      cacheVerdict = false;
      console.warn('[spaces] getSpace failed transiently', describe(error));
    }
  }

  if (cacheVerdict) capabilityCache.set(session.did, { space: verdict, checkedAt: Date.now() });
  return verdict;
}

const SAVED_ROW_COLUMNS =
  'rkey, url, title, author, description, content_type, domain, image, word_count, published_at, saved_at, source, item_guid';

/**
 * Mirror one save into the space. Call inside `ctx.waitUntil` — it never throws
 * and never returns anything the request path should branch on.
 */
export async function mirrorSaveToSpace(env: Env, session: Session, rkey: string): Promise<void> {
  if (!spacesSavesEnabled(env)) return;

  try {
    const row = await env.DB.prepare(
      `SELECT ${SAVED_ROW_COLUMNS} FROM saved_articles WHERE user_did = ? AND rkey = ?`
    )
      .bind(session.did, rkey)
      .first<SavedRowForSpace>();

    if (!row) return;

    const space = await ensureSavedSpace(session);
    if (!space) return;

    const record = savedRowToSpaceRecord(row);
    await spacesClientForSession(session).putRecord({
      space,
      repo: session.did,
      collection: SAVED_COLLECTION,
      // Same rkey as D1, so the mapping between the two stores is implicit and
      // no migration or join table is needed.
      rkey: row.rkey,
      record: record as unknown as Record<string, unknown>,
    });
  } catch (error) {
    console.warn('[spaces] mirrorSaveToSpace failed', { rkey, error: describe(error) });
  }
}

/** Remove one save from the space. Same contract as `mirrorSaveToSpace`. */
export async function mirrorDeleteFromSpace(
  env: Env,
  session: Session,
  rkey: string
): Promise<void> {
  if (!spacesSavesEnabled(env)) return;

  try {
    const space = await ensureSavedSpace(session);
    if (!space) return;

    await spacesClientForSession(session).deleteRecord({
      space,
      repo: session.did,
      collection: SAVED_COLLECTION,
      rkey,
    });
  } catch (error) {
    console.warn('[spaces] mirrorDeleteFromSpace failed', { rkey, error: describe(error) });
  }
}

/** Read every save row for a user, in the shape the record mapping wants. */
export async function readSavedRowsForSpace(env: Env, did: string): Promise<SavedRowForSpace[]> {
  const result = await env.DB.prepare(
    `SELECT ${SAVED_ROW_COLUMNS} FROM saved_articles WHERE user_did = ? ORDER BY saved_at DESC`
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
