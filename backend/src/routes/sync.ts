import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { getUserSettings, updateSyncTimestamp } from './settings';
import {
  syncSubscriptions,
  type SyncResult as SubscriptionSyncResult,
} from '../services/subscription-sync';

export interface FullSyncResult {
  success: boolean;
  subscriptions?: SubscriptionSyncResult;
  error?: string;
  /** If true, there's more work to do - call sync again */
  hasMore?: boolean;
}

export interface SyncStatusResponse {
  pdsSyncEnabled: boolean;
  lastSyncSubscriptions: number | null;
}

// POST /api/sync/full - Full sync (subscriptions only)
export async function handleFullSync(request: Request, env: Env): Promise<Response> {
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
    // Sync subscriptions
    const subResult = await syncSubscriptions(session, env);
    result.subscriptions = subResult;

    if (subResult.success) {
      await updateSyncTimestamp(env, session.did, 'subscriptions');
    }

    if (subResult.hasMore) {
      result.hasMore = true;
    }

    result.success = subResult.success;

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
export async function handleSyncSubscriptions(request: Request, env: Env): Promise<Response> {
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
    const result = await syncSubscriptions(session, env);

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
