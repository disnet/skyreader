import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';

interface DiscoverUser {
  did: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  shareCount: number;
}

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export async function handleDiscover(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
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

  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 50) : 20;

  try {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - THIRTY_DAYS_SECONDS;

    // Get users with shares in last 30 days, excluding:
    // - Current user
    // - Users already followed via Bluesky
    // - Users already followed via in-app follows
    let result = await env.DB.prepare(`
      SELECT
        u.did,
        u.handle,
        u.display_name as displayName,
        u.avatar_url as avatarUrl,
        COUNT(s.id) as shareCount
      FROM shares s
      JOIN users u ON u.did = s.author_did
      WHERE s.created_at > ?
        AND u.did != ?
        AND u.did NOT IN (
          SELECT following_did FROM follows_cache WHERE follower_did = ?
          UNION
          SELECT following_did FROM inapp_follows WHERE follower_did = ?
        )
      GROUP BY u.did
      ORDER BY RANDOM()
      LIMIT ?
    `).bind(thirtyDaysAgo, session.did, session.did, session.did, limit).all<{
      did: string;
      handle: string;
      displayName: string | null;
      avatarUrl: string | null;
      shareCount: number;
    }>();

    // Fallback 1: if no users with recent shares, get users who have ever shared
    if (result.results.length === 0) {
      result = await env.DB.prepare(`
        SELECT
          u.did,
          u.handle,
          u.display_name as displayName,
          u.avatar_url as avatarUrl,
          COUNT(s.id) as shareCount
        FROM shares s
        JOIN users u ON u.did = s.author_did
        WHERE u.did != ?
          AND u.did NOT IN (
            SELECT following_did FROM follows_cache WHERE follower_did = ?
            UNION
            SELECT following_did FROM inapp_follows WHERE follower_did = ?
          )
        GROUP BY u.did
        ORDER BY RANDOM()
        LIMIT ?
      `).bind(session.did, session.did, session.did, limit).all<{
        did: string;
        handle: string;
        displayName: string | null;
        avatarUrl: string | null;
        shareCount: number;
      }>();
    }

    // Fallback 2: if still no users, get any logged-in users
    if (result.results.length === 0) {
      result = await env.DB.prepare(`
        SELECT
          u.did,
          u.handle,
          u.display_name as displayName,
          u.avatar_url as avatarUrl,
          0 as shareCount
        FROM users u
        WHERE u.pds_url IS NOT NULL
          AND u.pds_url != ''
          AND u.did != ?
          AND u.did NOT IN (
            SELECT following_did FROM follows_cache WHERE follower_did = ?
            UNION
            SELECT following_did FROM inapp_follows WHERE follower_did = ?
          )
        ORDER BY RANDOM()
        LIMIT ?
      `).bind(session.did, session.did, session.did, limit).all<{
        did: string;
        handle: string;
        displayName: string | null;
        avatarUrl: string | null;
        shareCount: number;
      }>();
    }

    const users: DiscoverUser[] = result.results.map(row => ({
      did: row.did,
      handle: row.handle,
      displayName: row.displayName || undefined,
      avatarUrl: row.avatarUrl || undefined,
      shareCount: row.shareCount,
    }));

    return new Response(JSON.stringify({ users }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Discover error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to fetch discover users' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
