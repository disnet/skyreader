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
      console.warn(`[JetstreamInappFollows] Failed to fetch profile for ${did}: ${response.status}`);
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
    console.error(`[JetstreamInappFollows] Error fetching profile for ${did}:`, error);
    return null;
  }
}

interface JetstreamInappFollowEvent {
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

export interface InappFollowsPollResult {
  processed: number;
  errors: number;
  cursor?: string;
}

const POLL_TIMEOUT_MS = 10000; // 10 seconds max for low-volume custom collection
const IDLE_TIMEOUT_MS = 2000; // 2 seconds without events = caught up

async function processInappFollowEvent(env: Env, event: JetstreamInappFollowEvent): Promise<void> {
  const { did: followerDid, commit } = event;
  if (!commit || commit.collection !== 'com.at-rss.social.follow') return;

  const { operation, rkey, record } = commit;

  if (operation === 'create' && record) {
    const followingDid = record.subject;

    // Insert into inapp_follows with rkey for deletion handling
    await env.DB.prepare(`
      INSERT OR REPLACE INTO inapp_follows (follower_did, following_did, rkey, record_uri, created_at)
      VALUES (?, ?, ?, ?, unixepoch())
    `).bind(followerDid, followingDid, rkey, `at://${followerDid}/com.at-rss.social.follow/${rkey}`).run();

    // Fetch profile info for the followed user
    const profile = await fetchProfileInfo(followingDid);

    // Upsert the followed user to users table with profile info
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

    console.log(`[JetstreamInappFollows] ${followerDid} followed ${profile?.handle || followingDid}`);

  } else if (operation === 'delete') {
    // Delete from inapp_follows using rkey
    const result = await env.DB.prepare(`
      DELETE FROM inapp_follows
      WHERE follower_did = ? AND rkey = ?
    `).bind(followerDid, rkey).run();

    // Only log if we actually deleted something
    if (result.meta.changes > 0) {
      console.log(`[JetstreamInappFollows] ${followerDid} unfollowed (rkey: ${rkey})`);
    }
  }
}

export async function pollJetstreamInappFollows(env: Env): Promise<InappFollowsPollResult> {
  // Get cursor from D1
  const cursorResult = await env.DB.prepare(
    'SELECT value FROM sync_state WHERE key = ?'
  ).bind('jetstream_inapp_follows_cursor').first<{ value: string }>();

  const wsUrl = new URL('wss://jetstream2.us-east.bsky.network/subscribe');
  wsUrl.searchParams.append('wantedCollections', 'com.at-rss.social.follow');

  // Use existing cursor if available, otherwise establish baseline
  let lastCursor: string;
  if (cursorResult?.value) {
    wsUrl.searchParams.set('cursor', cursorResult.value);
    lastCursor = cursorResult.value;
    console.log(`[JetstreamInappFollows] Starting from cursor ${cursorResult.value}`);
  } else {
    // No cursor yet - save current time as baseline after this poll
    lastCursor = (Date.now() * 1000).toString();
    console.log('[JetstreamInappFollows] Starting fresh poll, will establish baseline cursor');
  }

  let processed = 0;
  let errors = 0;
  let cleanedUp = false;
  let lastEventTime = Date.now();

  return new Promise((resolve) => {
    const startTime = Date.now();

    // Timeout to ensure we don't run forever
    const pollTimeout = setTimeout(() => {
      console.log(`[JetstreamInappFollows] Poll timeout after ${POLL_TIMEOUT_MS}ms`);
      cleanup();
    }, POLL_TIMEOUT_MS);

    // Check for idle (caught up)
    const idleCheck = setInterval(() => {
      if (Date.now() - lastEventTime > IDLE_TIMEOUT_MS) {
        console.log(`[JetstreamInappFollows] Caught up (idle for ${IDLE_TIMEOUT_MS}ms)`);
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
      await env.DB.prepare(
        'INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())'
      ).bind('jetstream_inapp_follows_cursor', lastCursor).run();

      const duration = Date.now() - startTime;
      console.log(`[JetstreamInappFollows] Poll complete: ${processed} processed, ${errors} errors, ${duration}ms`);

      resolve({ processed, errors, cursor: lastCursor });
    };

    try {
      ws = new WebSocket(wsUrl.toString());

      ws.addEventListener('open', () => {
        console.log('[JetstreamInappFollows] Connected');
        lastEventTime = Date.now();
      });

      ws.addEventListener('message', async (event) => {
        try {
          const data = JSON.parse(event.data as string) as JetstreamInappFollowEvent;

          // Only update idle timer on actual commit events, not control messages
          if (data.kind === 'commit') {
            lastEventTime = Date.now();
          }

          // Update cursor to last seen event
          if (data.time_us) {
            lastCursor = data.time_us.toString();
          }

          // Process the event
          if (data.kind === 'commit' && data.commit?.collection === 'com.at-rss.social.follow') {
            await processInappFollowEvent(env, data);
            processed++;
          }
        } catch (error) {
          console.error('[JetstreamInappFollows] Error processing event:', error);
          errors++;
        }
      });

      ws.addEventListener('close', () => {
        console.log('[JetstreamInappFollows] Disconnected');
        cleanup();
      });

      ws.addEventListener('error', (error) => {
        console.error('[JetstreamInappFollows] WebSocket error:', error);
        cleanup();
      });
    } catch (error) {
      console.error('[JetstreamInappFollows] Failed to connect:', error);
      cleanup();
    }
  });
}
