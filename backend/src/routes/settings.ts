import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';

/**
 * Which engine backs the user's saves (external-backed saves, one per account).
 * `'skyreader'` = the default: saves live only in D1, with no PDS record.
 * Otherwise the user's Saved list IS a foreign collection, identified by its at-uri.
 * See docs/plans/EXTERNAL_BACKED_SAVES_PLAN.md.
 */
export type SaveBacking =
  | { provider: 'skyreader' }
  | { provider: 'semble'; collectionUri: string }
  | { provider: 'margin'; collectionUri: string };

/**
 * Parse the stored `backing` column ('skyreader' | 'semble:<uri>' | 'margin:<uri>')
 * into a discriminated union. NULL / unknown / malformed all fall back to the
 * default 'skyreader' backing (fail safe — never silently treat a save as backed).
 */
export function parseBacking(raw: string | null | undefined): SaveBacking {
  if (!raw || raw === 'skyreader') return { provider: 'skyreader' };
  const sep = raw.indexOf(':');
  if (sep === -1) return { provider: 'skyreader' };
  const provider = raw.slice(0, sep);
  const collectionUri = raw.slice(sep + 1);
  if ((provider === 'semble' || provider === 'margin') && collectionUri.startsWith('at://')) {
    return { provider, collectionUri };
  }
  return { provider: 'skyreader' };
}

/** Serialize a SaveBacking back to the stored column form. */
export function serializeBacking(backing: SaveBacking): string {
  return backing.provider === 'skyreader'
    ? 'skyreader'
    : `${backing.provider}:${backing.collectionUri}`;
}

export interface UserSettings {
  /**
   * Atmospheric sync — the single opt-in for mirroring data to the user's PDS.
   * Turning it on stores the subscription/feed list on the PDS (portable and
   * publicly visible) AND keeps standard.site subscriptions reconciled (the
   * public graph edge is the same mirror, so it rides the same switch).
   */
  pdsSyncEnabled: boolean;
  lastPdsSyncSubscriptions: number | null;
  /** External-backed saves: which engine backs the Saved list (one per account). */
  backing: SaveBacking;
  /**
   * When the last backing poll last *completed* (ms), or null if none ever has.
   * Null means the local membership snapshot has never been verified against the
   * foreign collection — `GET /api/saved` won't serve it as authoritative.
   */
  lastSuccessfulBackingPoll: number | null;
  linkblogDisabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface UserSettingsRow {
  user_did: string;
  pds_sync_enabled: number;
  last_pds_sync_subscriptions: number | null;
  backing: string | null;
  last_successful_backing_poll: number | null;
  linkblog_disabled: number;
  created_at: number;
  updated_at: number;
}

function rowToSettings(row: UserSettingsRow | null): UserSettings {
  if (!row) {
    return {
      pdsSyncEnabled: false,
      lastPdsSyncSubscriptions: null,
      backing: { provider: 'skyreader' },
      lastSuccessfulBackingPoll: null,
      linkblogDisabled: false,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    };
  }
  return {
    pdsSyncEnabled: row.pds_sync_enabled === 1,
    lastPdsSyncSubscriptions: row.last_pds_sync_subscriptions,
    backing: parseBacking(row.backing),
    lastSuccessfulBackingPoll: row.last_successful_backing_poll,
    linkblogDisabled: row.linkblog_disabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/settings - Get user settings
export async function handleGetSettings(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const row = await env.DB.prepare(`SELECT * FROM user_settings WHERE user_did = ?`)
      .bind(session.did)
      .first<UserSettingsRow>();

    return new Response(JSON.stringify(rowToSettings(row)), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to get settings:', error);
    return new Response(JSON.stringify({ error: 'Failed to get settings' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// PUT /api/settings - Update user settings
export async function handleUpdateSettings(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'PUT') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { pdsSyncEnabled?: boolean; backing?: SaveBacking };
  try {
    body = (await request.json()) as {
      pdsSyncEnabled?: boolean;
      backing?: SaveBacking;
    };
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate + serialize the backing change, if present. This is the low-level
  // persistence primitive — the full enable flow (createCollection, one-time
  // export of existing native saves, backfill poll) wraps it in Phase 5. A
  // malformed value round-trips through parseBacking to 'skyreader' rather than
  // landing a junk column.
  let backingValue: string | null = null;
  if (body.backing !== undefined) {
    const parsed =
      body.backing.provider === 'skyreader'
        ? { provider: 'skyreader' as const }
        : parseBacking(serializeBacking(body.backing));
    if (body.backing.provider !== 'skyreader' && parsed.provider === 'skyreader') {
      return new Response(
        JSON.stringify({
          error: 'Invalid backing: expected { provider, collectionUri: at://... }',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    backingValue = serializeBacking(parsed);
  }

  try {
    // A backing change invalidates the local snapshot of the OLD collection: its
    // membership rows and unsave tombstones describe a collection that no longer
    // backs this account, and nothing else ever prunes them. Left in place, they
    // are what `GET /api/saved` serves the moment the next poll marks the new
    // backing verified. `disableBacking` — the other way out of a backing — does
    // the same teardown; this is the direct-API path to the same state change.
    // Compared through parse+serialize so a NULL or junk column reads as
    // 'skyreader', exactly as the rest of the code sees it.
    const before =
      backingValue !== null
        ? await env.DB.prepare(`SELECT backing FROM user_settings WHERE user_did = ?`)
            .bind(session.did)
            .first<{ backing: string | null }>()
        : null;
    const backingChanged =
      backingValue !== null && backingValue !== serializeBacking(parseBacking(before?.backing));

    // Upsert the settings. Each column is only written when present in the body
    // (COALESCE keeps the existing value for an omitted/null bind).
    const upsert = env.DB.prepare(
      `INSERT INTO user_settings (user_did, pds_sync_enabled, backing, updated_at)
			 VALUES (?, ?, ?, unixepoch())
			 ON CONFLICT(user_did) DO UPDATE SET
			   pds_sync_enabled = COALESCE(excluded.pds_sync_enabled, pds_sync_enabled),
			   last_backing_poll = CASE
			     WHEN excluded.backing IS NOT NULL AND excluded.backing IS NOT user_settings.backing
			       THEN NULL
			     ELSE user_settings.last_backing_poll
			   END,
			   last_successful_backing_poll = CASE
			     WHEN excluded.backing IS NOT NULL AND excluded.backing IS NOT user_settings.backing
			       THEN NULL
			     ELSE user_settings.last_successful_backing_poll
			   END,
			   backing = COALESCE(excluded.backing, backing),
			   updated_at = unixepoch()`
    ).bind(
      session.did,
      body.pdsSyncEnabled !== undefined ? (body.pdsSyncEnabled ? 1 : 0) : null,
      backingValue
    );

    await env.DB.batch(
      backingChanged
        ? [
            upsert,
            env.DB.prepare(`DELETE FROM backed_collection_members WHERE user_did = ?`).bind(
              session.did
            ),
            env.DB.prepare(`DELETE FROM backed_unsave_tombstones WHERE user_did = ?`).bind(
              session.did
            ),
          ]
        : [upsert]
    );

    // Fetch the updated settings
    const row = await env.DB.prepare(`SELECT * FROM user_settings WHERE user_did = ?`)
      .bind(session.did)
      .first<UserSettingsRow>();

    return new Response(JSON.stringify(rowToSettings(row)), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to update settings:', error);
    return new Response(JSON.stringify({ error: 'Failed to update settings' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Get user settings from database (for internal use)
 */
export async function getUserSettings(env: Env, did: string): Promise<UserSettings> {
  const row = await env.DB.prepare(`SELECT * FROM user_settings WHERE user_did = ?`)
    .bind(did)
    .first<UserSettingsRow>();

  return rowToSettings(row);
}

/**
 * Update the subscription sync timestamp.
 * Uses a prepared statement to avoid dynamic SQL interpolation.
 */
export async function updateSyncTimestamp(
  env: Env,
  did: string,
  collection: 'subscriptions'
): Promise<void> {
  if (collection === 'subscriptions') {
    await env.DB.prepare(
      `INSERT INTO user_settings (user_did, last_pds_sync_subscriptions, updated_at)
			 VALUES (?, unixepoch(), unixepoch())
			 ON CONFLICT(user_did) DO UPDATE SET
			   last_pds_sync_subscriptions = unixepoch(),
			   updated_at = unixepoch()`
    )
      .bind(did)
      .run();
  }
}
