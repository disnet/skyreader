import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';

export interface UserSettings {
  /**
   * Atmospheric sync — the single opt-in for mirroring data to the user's PDS.
   * Turning it on stores the subscription/feed list on the PDS (portable and
   * publicly visible) AND keeps standard.site subscriptions reconciled (the
   * public graph edge is the same mirror, so it rides the same switch).
   */
  pdsSyncEnabled: boolean;
  lastPdsSyncSubscriptions: number | null;
  createdAt: number;
  updatedAt: number;
}

interface UserSettingsRow {
  user_did: string;
  pds_sync_enabled: number;
  last_pds_sync_subscriptions: number | null;
  created_at: number;
  updated_at: number;
}

function rowToSettings(row: UserSettingsRow | null): UserSettings {
  if (!row) {
    return {
      pdsSyncEnabled: false,
      lastPdsSyncSubscriptions: null,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    };
  }
  return {
    pdsSyncEnabled: row.pds_sync_enabled === 1,
    lastPdsSyncSubscriptions: row.last_pds_sync_subscriptions,
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

  let body: { pdsSyncEnabled?: boolean };
  try {
    body = (await request.json()) as {
      pdsSyncEnabled?: boolean;
    };
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Upsert the settings. The column is only written when present in the body
    // (COALESCE keeps the existing value for an omitted/null bind).
    await env.DB.prepare(
      `INSERT INTO user_settings (user_did, pds_sync_enabled, updated_at)
			 VALUES (?, ?, unixepoch())
			 ON CONFLICT(user_did) DO UPDATE SET
			   pds_sync_enabled = COALESCE(excluded.pds_sync_enabled, pds_sync_enabled),
			   updated_at = unixepoch()`
    )
      .bind(session.did, body.pdsSyncEnabled !== undefined ? (body.pdsSyncEnabled ? 1 : 0) : null)
      .run();

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
