import type { Env } from '../types';

interface ProfileInfo {
  handle: string;
  displayName?: string;
  avatar?: string;
}

async function fetchProfileInfo(did: string): Promise<ProfileInfo | null> {
  try {
    const response = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      console.warn(`[JetstreamFollows] Failed to fetch profile for ${did}: ${response.status}`);
      return null;
    }

    const data = await response.json() as {
      handle: string;
      displayName?: string;
      avatar?: string;
    };

    return {
      handle: data.handle,
      displayName: data.displayName,
      avatar: data.avatar,
    };
  } catch (error) {
    console.error(`[JetstreamFollows] Error fetching profile for ${did}:`, error);
    return null;
  }
}

interface JetstreamFollowEvent {
  did: string;
  time_us: number;
  kind: 'commit' | 'identity' | 'account';
  commit?: {
    rev: string;
    operation: 'create' | 'update' | 'delete';
    collection: string;
    rkey: string;
    record?: {
      $type: string;
      subject: string;
      createdAt: string;
    };
    cid?: string;
  };
}

export interface FollowsPollResult {
  processed: number;
  errors: number;
  cursor?: string;
}

const POLL_TIMEOUT_MS = 30000; // 30 seconds max
const IDLE_TIMEOUT_MS = 2000; // 2 seconds without events = caught up
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const MAX_WANTED_DIDS = 100; // URL length limit consideration

async function getActiveUserDids(env: Env): Promise<string[]> {
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - SEVEN_DAYS_SECONDS;

  const result = await env.DB.prepare(`
    SELECT did FROM users
    WHERE pds_url != ''
      AND pds_url IS NOT NULL
      AND last_active_at > ?
  `).bind(sevenDaysAgo).all<{ did: string }>();

  return result.results.map(r => r.did);
}

interface FollowEventTimings {
  profileFetch: number;
  dbWrite: number;
}

async function processFollowEvent(env: Env, event: JetstreamFollowEvent): Promise<FollowEventTimings> {
  const timings: FollowEventTimings = { profileFetch: 0, dbWrite: 0 };
  const { did: followerDid, commit } = event;
  if (!commit || commit.collection !== 'app.bsky.graph.follow') return timings;

  const { operation, rkey, record } = commit;

  if (operation === 'create' && record) {
    const followingDid = record.subject;

    // Insert into follows_cache with rkey for deletion handling
    let dbStart = Date.now();
    await env.DB.prepare(`
      INSERT OR REPLACE INTO follows_cache (follower_did, following_did, rkey, created_at)
      VALUES (?, ?, ?, unixepoch())
    `).bind(followerDid, followingDid, rkey).run();

    // Fetch profile info for the followed user
    const profileStart = Date.now();
    const profile = await fetchProfileInfo(followingDid);
    timings.profileFetch = Date.now() - profileStart;

    // Upsert the followed user to users table with profile info
    dbStart = Date.now();
    await env.DB.prepare(`
      INSERT INTO users (did, handle, display_name, avatar_url, pds_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', unixepoch(), unixepoch())
      ON CONFLICT(did) DO UPDATE SET
        handle = CASE WHEN excluded.handle != excluded.did THEN excluded.handle ELSE users.handle END,
        display_name = COALESCE(excluded.display_name, users.display_name),
        avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
        updated_at = unixepoch()
    `).bind(
      followingDid,
      profile?.handle || followingDid,
      profile?.displayName || null,
      profile?.avatar || null
    ).run();
    timings.dbWrite = Date.now() - dbStart;

    console.log(`[JetstreamFollows] ${followerDid} followed ${profile?.handle || followingDid}`);

  } else if (operation === 'delete') {
    // Delete from follows_cache using rkey
    const dbStart = Date.now();
    const result = await env.DB.prepare(`
      DELETE FROM follows_cache
      WHERE follower_did = ? AND rkey = ?
    `).bind(followerDid, rkey).run();
    timings.dbWrite = Date.now() - dbStart;

    // Only log if we actually deleted something (avoids duplicate logs from cursor buffer)
    if (result.meta.changes > 0) {
      console.log(`[JetstreamFollows] ${followerDid} unfollowed (rkey: ${rkey})`);
    }
  }

  return timings;
}

export async function pollJetstreamFollows(env: Env): Promise<FollowsPollResult> {
  const timings: Record<string, number> = {};
  let startTime = Date.now();

  // Get active user DIDs for filtering
  const activeUsers = await getActiveUserDids(env);
  timings.activeUsersQuery = Date.now() - startTime;

  if (activeUsers.length === 0) {
    console.log('[JetstreamFollows] No active users to poll for');
    return { processed: 0, errors: 0 };
  }

  if (activeUsers.length > MAX_WANTED_DIDS) {
    console.warn(`[JetstreamFollows] ${activeUsers.length} active users exceeds limit of ${MAX_WANTED_DIDS}, using first ${MAX_WANTED_DIDS}`);
  }

  const usersToWatch = activeUsers.slice(0, MAX_WANTED_DIDS);
  timings.activeUsers = usersToWatch.length;
  console.log(`[JetstreamFollows] Polling for ${usersToWatch.length} active users`);

  // Get cursor from D1 (separate from share poller cursor)
  startTime = Date.now();
  const cursorResult = await env.DB.prepare(
    'SELECT value FROM sync_state WHERE key = ?'
  ).bind('jetstream_follows_cursor').first<{ value: string }>();
  timings.cursorQuery = Date.now() - startTime;

  const wsUrl = new URL('wss://jetstream2.us-east.bsky.network/subscribe');
  wsUrl.searchParams.append('wantedCollections', 'app.bsky.graph.follow');

  // Add wantedDids parameter - filter to only our active users
  for (const did of usersToWatch) {
    wsUrl.searchParams.append('wantedDids', did);
  }

  // Use existing cursor if available, otherwise establish baseline
  let lastCursor: string;
  if (cursorResult?.value) {
    wsUrl.searchParams.set('cursor', cursorResult.value);
    lastCursor = cursorResult.value;
    console.log(`[JetstreamFollows] Starting from cursor ${cursorResult.value}`);
  } else {
    // No cursor yet - save current time as baseline after this poll
    lastCursor = (Date.now() * 1000).toString();
    console.log('[JetstreamFollows] Starting fresh poll, will establish baseline cursor');
  }

  let processed = 0;
  let errors = 0;
  let cleanedUp = false;
  let lastEventTime = Date.now();

  // Accumulated event timings
  let totalProfileFetch = 0;
  let totalDbWrite = 0;
  let wsConnectTime = 0;
  const wsConnectStart = Date.now();

  return new Promise((resolve) => {
    startTime = Date.now();

    // Timeout to ensure we don't run forever
    const pollTimeout = setTimeout(() => {
      console.log(`[JetstreamFollows] Poll timeout after ${POLL_TIMEOUT_MS}ms`);
      cleanup();
    }, POLL_TIMEOUT_MS);

    // Check for idle (caught up)
    const idleCheck = setInterval(() => {
      if (Date.now() - lastEventTime > IDLE_TIMEOUT_MS) {
        console.log(`[JetstreamFollows] Caught up (idle for ${IDLE_TIMEOUT_MS}ms)`);
        cleanup();
      }
    }, 500);

    let ws: WebSocket | null = null;

    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;

      clearTimeout(pollTimeout);
      clearInterval(idleCheck);

      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close errors
        }
        ws = null;
      }

      // Save cursor (either last event time, or baseline if no events)
      const cursorSaveStart = Date.now();
      await env.DB.prepare(
        'INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())'
      ).bind('jetstream_follows_cursor', lastCursor).run();
      timings.cursorSave = Date.now() - cursorSaveStart;

      timings.wsConnect = wsConnectTime;
      timings.total = Date.now() - startTime;
      timings.profileFetch = totalProfileFetch;
      timings.dbWrite = totalDbWrite;
      timings.processed = processed;
      timings.errors = errors;

      console.log(`[JetstreamFollows] Poll complete: timings=${JSON.stringify(timings)}`);

      resolve({ processed, errors, cursor: lastCursor });
    };

    try {
      ws = new WebSocket(wsUrl.toString());

      ws.addEventListener('open', () => {
        wsConnectTime = Date.now() - wsConnectStart;
        console.log(`[JetstreamFollows] Connected in ${wsConnectTime}ms`);
        lastEventTime = Date.now();
      });

      ws.addEventListener('message', async (event) => {
        lastEventTime = Date.now();

        try {
          const data = JSON.parse(event.data as string) as JetstreamFollowEvent;

          // Update cursor to last seen event
          lastCursor = data.time_us.toString();

          // Process the event
          if (data.kind === 'commit' && data.commit?.collection === 'app.bsky.graph.follow') {
            const eventTimings = await processFollowEvent(env, data);
            totalProfileFetch += eventTimings.profileFetch;
            totalDbWrite += eventTimings.dbWrite;
            processed++;
          }
        } catch (error) {
          console.error('[JetstreamFollows] Error processing event:', error);
          errors++;
        }
      });

      ws.addEventListener('close', () => {
        console.log('[JetstreamFollows] Disconnected');
        cleanup();
      });

      ws.addEventListener('error', (error) => {
        console.error('[JetstreamFollows] WebSocket error:', error);
        cleanup();
      });
    } catch (error) {
      console.error('[JetstreamFollows] Failed to connect:', error);
      cleanup();
    }
  });
}
