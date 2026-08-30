import type { Env } from '../types';
import { getSessionFromRequest, getSessionIdFromRequest } from '../services/oauth';
import { getUserSettings, updateSyncTimestamp } from './settings';
import {
  syncSubscriptions,
  countDirtySubscriptions,
  type SyncResult as SubscriptionSyncResult,
} from '../services/subscription-sync';
import {
  reconcileAtmosphereSubscriptions,
  type AtmosphereSyncResult,
} from '../services/atmosphere-subscription-sync';

export interface FullSyncResult {
  success: boolean;
  subscriptions?: SubscriptionSyncResult;
  /** Present when Atmospheric subscription sync is enabled. */
  atmosphere?: AtmosphereSyncResult;
  error?: string;
  /** If true, there's more work to do - call sync again */
  hasMore?: boolean;
  /**
   * Set when the user's PDS moved (migration) and their tokens no longer work
   * against the new host — they must reconnect their account to resume sync.
   */
  needsReauth?: boolean;
}

export interface SyncStatusResponse {
  pdsSyncEnabled: boolean;
  lastSyncSubscriptions: number | null;
  /**
   * Subscriptions carrying a local edit that hasn't reached the PDS. Zero is the
   * steady state — every mutation write-throughs — so this is the honest answer
   * to "is my feed list in step?", which a last-synced timestamp never was.
   */
  pendingSubscriptions: number;
}

// POST /api/sync/full - Full sync (subscriptions only)
export async function handleFullSync(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') {
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

  // Check if PDS sync is enabled
  const settings = await getUserSettings(env, session.did);
  if (!settings.pdsSyncEnabled) {
    return new Response(
      JSON.stringify({
        error: 'PDS sync is not enabled',
        code: 'sync_disabled',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const result: FullSyncResult = { success: true };

  try {
    // Sync subscriptions. Pass the session id so the PDS client can self-heal a
    // stale host after a PDS migration (re-resolve + persist + retry).
    const sessionId = getSessionIdFromRequest(request) ?? undefined;
    const subResult = await syncSubscriptions(session, env, sessionId, (p) => ctx.waitUntil(p));
    result.subscriptions = subResult;

    if (subResult.success) {
      await updateSyncTimestamp(env, session.did, 'subscriptions');
    }

    if (subResult.hasMore) {
      result.hasMore = true;
    }

    if (subResult.needsReauth) {
      result.needsReauth = true;
    }

    result.success = subResult.success;

    // Reconcile standard.site follows ↔ Skyreader. This rides the same
    // Atmospheric-sync switch (the graph edges are the public mirror), so it
    // always runs while PDS sync is on — no separate opt-in.
    const atmoResult = await reconcileAtmosphereSubscriptions(session, env, ctx);
    result.atmosphere = atmoResult;
    if (atmoResult.hasMore) {
      result.hasMore = true;
    }
    // A reconcile failure shouldn't flip an otherwise-successful subscription
    // sync to failed (it's best-effort and self-heals next run); surface it via
    // the atmosphere field instead.

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Full sync error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Sync failed',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// POST /api/sync/subscriptions - Sync subscriptions only
export async function handleSyncSubscriptions(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') {
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

  // Check if PDS sync is enabled
  const settings = await getUserSettings(env, session.did);
  if (!settings.pdsSyncEnabled) {
    return new Response(
      JSON.stringify({
        error: 'PDS sync is not enabled',
        code: 'sync_disabled',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const sessionId = getSessionIdFromRequest(request) ?? undefined;
    const result = await syncSubscriptions(session, env, sessionId, (p) => ctx.waitUntil(p));

    if (result.success) {
      await updateSyncTimestamp(env, session.did, 'subscriptions');
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Subscription sync error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Sync failed',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// GET /api/sync/status - Get sync status
export async function handleSyncStatus(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const settings = await getUserSettings(env, session.did);

    const response: SyncStatusResponse = {
      pdsSyncEnabled: settings.pdsSyncEnabled,
      lastSyncSubscriptions: settings.lastPdsSyncSubscriptions,
      pendingSubscriptions: settings.pdsSyncEnabled
        ? await countDirtySubscriptions(env, session.did)
        : 0,
    };

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Get sync status error:', error);
    return new Response(JSON.stringify({ error: 'Failed to get sync status' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
