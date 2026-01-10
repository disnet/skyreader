import type { Env, ShareWithAuthor } from '../types';
import { getSessionFromRequest, importPrivateKey, createDPoPProof } from '../services/oauth';

export async function handleSocialFeed(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

  try {
    // Get shares from users the current user follows
    const query = `
      SELECT
        s.id, s.author_did, s.record_uri, s.record_cid,
        s.item_url, s.item_title, s.item_author, s.item_description,
        s.item_image, s.note, s.tags, s.indexed_at, s.created_at,
        u.handle, u.display_name, u.avatar_url
      FROM shares s
      JOIN follows_cache f ON f.following_did = s.author_did
      JOIN users u ON u.did = s.author_did
      WHERE f.follower_did = ?
        AND s.created_at < ?
      ORDER BY s.created_at DESC
      LIMIT ?
    `;

    const cursorTimestamp = cursor ? parseInt(cursor, 10) : Date.now() * 1000;
    const results = await env.DB.prepare(query)
      .bind(session.did, cursorTimestamp, limit + 1)
      .all();

    const hasMore = results.results.length > limit;
    const shares = results.results.slice(0, limit).map((row: Record<string, unknown>) => ({
      id: row.id as number,
      authorDid: row.author_did as string,
      recordUri: row.record_uri as string,
      recordCid: row.record_cid as string,
      itemUrl: row.item_url as string,
      itemTitle: row.item_title as string | undefined,
      itemAuthor: row.item_author as string | undefined,
      itemDescription: row.item_description as string | undefined,
      itemImage: row.item_image as string | undefined,
      note: row.note as string | undefined,
      tags: row.tags ? JSON.parse(row.tags as string) : undefined,
      indexedAt: row.indexed_at as number,
      createdAt: row.created_at as number,
      handle: row.handle as string,
      displayName: row.display_name as string | undefined,
      avatarUrl: row.avatar_url as string | undefined,
    })) as ShareWithAuthor[];

    const nextCursor = hasMore && shares.length > 0
      ? shares[shares.length - 1].createdAt.toString()
      : null;

    return new Response(JSON.stringify({ shares, cursor: nextCursor }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Social feed error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch social feed' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export async function handleSyncFollows(request: Request, env: Env): Promise<Response> {
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

  try {
    // Fetch all follows from Bluesky
    const allFollows: string[] = [];
    let cursor: string | undefined;

    const privateKeyJwk = JSON.parse(session.dpopPrivateKey);
    const privateKey = await importPrivateKey(privateKeyJwk);
    const publicKeyJwk = { ...privateKeyJwk };
    delete publicKeyJwk.d;

    do {
      const followsUrl = `${session.pdsUrl}/xrpc/app.bsky.graph.getFollows?actor=${session.did}&limit=100${cursor ? `&cursor=${cursor}` : ''}`;

      let dpopProof = await createDPoPProof(
        privateKey,
        publicKeyJwk,
        'GET',
        followsUrl,
        undefined,
        session.accessToken
      );

      let response = await fetch(followsUrl, {
        headers: {
          Authorization: `DPoP ${session.accessToken}`,
          DPoP: dpopProof,
        },
      });

      // Handle DPoP nonce requirement
      if (!response.ok && response.status === 401) {
        const errorData = await response.json().catch(() => null) as { error?: string } | null;
        const dpopNonce = response.headers.get('DPoP-Nonce');

        if (errorData?.error === 'use_dpop_nonce' && dpopNonce) {
          dpopProof = await createDPoPProof(
            privateKey,
            publicKeyJwk,
            'GET',
            followsUrl,
            dpopNonce,
            session.accessToken
          );

          response = await fetch(followsUrl, {
            headers: {
              Authorization: `DPoP ${session.accessToken}`,
              DPoP: dpopProof,
            },
          });
        }
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch follows: ${response.status}`);
      }

      const data = await response.json() as {
        follows: { did: string; handle: string; displayName?: string; avatar?: string }[];
        cursor?: string;
      };

      for (const follow of data.follows) {
        allFollows.push(follow.did);

        // Upsert user info
        await env.DB.prepare(`
          INSERT INTO users (did, handle, display_name, avatar_url, pds_url, updated_at)
          VALUES (?, ?, ?, ?, '', unixepoch())
          ON CONFLICT(did) DO UPDATE SET
            handle = excluded.handle,
            display_name = excluded.display_name,
            avatar_url = excluded.avatar_url,
            updated_at = unixepoch()
        `).bind(
          follow.did,
          follow.handle,
          follow.displayName || null,
          follow.avatar || null
        ).run();
      }

      cursor = data.cursor;
    } while (cursor);

    // Update follows cache - delete old and insert new
    await env.DB.prepare('DELETE FROM follows_cache WHERE follower_did = ?')
      .bind(session.did)
      .run();

    // Batch insert follows
    const batchSize = 50;
    for (let i = 0; i < allFollows.length; i += batchSize) {
      const batch = allFollows.slice(i, i + batchSize);
      const placeholders = batch.map(() => '(?, ?)').join(', ');
      const values = batch.flatMap((did) => [session.did, did]);

      await env.DB.prepare(
        `INSERT INTO follows_cache (follower_did, following_did) VALUES ${placeholders}`
      ).bind(...values).run();
    }

    // Update user's last synced timestamp
    await env.DB.prepare(
      'UPDATE users SET last_synced_at = unixepoch() WHERE did = ?'
    ).bind(session.did).run();

    return new Response(JSON.stringify({ synced: allFollows.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Sync follows error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to sync follows' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export async function handleFollowedUsers(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const results = await env.DB.prepare(`
      SELECT u.did, u.handle, u.display_name, u.avatar_url
      FROM follows_cache f
      JOIN users u ON u.did = f.following_did
      WHERE f.follower_did = ?
      ORDER BY u.handle ASC
    `).bind(session.did).all();

    const users = results.results.map((row: Record<string, unknown>) => ({
      did: row.did as string,
      handle: row.handle as string,
      displayName: row.display_name as string | undefined,
      avatarUrl: row.avatar_url as string | undefined,
    }));

    return new Response(JSON.stringify({ users }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Get followed users error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch followed users' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export async function handlePopularShares(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const period = url.searchParams.get('period') || 'week';

  // Calculate time threshold based on period
  let timeThreshold: number;
  const now = Date.now();
  switch (period) {
    case 'day':
      timeThreshold = now - 24 * 60 * 60 * 1000;
      break;
    case 'month':
      timeThreshold = now - 30 * 24 * 60 * 60 * 1000;
      break;
    case 'week':
    default:
      timeThreshold = now - 7 * 24 * 60 * 60 * 1000;
  }

  try {
    const query = `
      SELECT
        s.id, s.author_did, s.record_uri, s.record_cid,
        s.item_url, s.item_title, s.item_author, s.item_description,
        s.item_image, s.note, s.tags, s.indexed_at, s.created_at,
        u.handle, u.display_name, u.avatar_url,
        COUNT(*) OVER (PARTITION BY s.item_url) as share_count
      FROM shares s
      JOIN users u ON u.did = s.author_did
      WHERE s.created_at > ?
        AND s.created_at < ?
      ORDER BY share_count DESC, s.created_at DESC
      LIMIT ?
    `;

    const cursorTimestamp = cursor ? parseInt(cursor, 10) : Date.now() * 1000;
    const results = await env.DB.prepare(query)
      .bind(timeThreshold, cursorTimestamp, limit + 1)
      .all();

    const hasMore = results.results.length > limit;
    const shares = results.results.slice(0, limit).map((row: Record<string, unknown>) => ({
      id: row.id as number,
      authorDid: row.author_did as string,
      recordUri: row.record_uri as string,
      recordCid: row.record_cid as string,
      itemUrl: row.item_url as string,
      itemTitle: row.item_title as string | undefined,
      itemAuthor: row.item_author as string | undefined,
      itemDescription: row.item_description as string | undefined,
      itemImage: row.item_image as string | undefined,
      note: row.note as string | undefined,
      tags: row.tags ? JSON.parse(row.tags as string) : undefined,
      indexedAt: row.indexed_at as number,
      createdAt: row.created_at as number,
      handle: row.handle as string,
      displayName: row.display_name as string | undefined,
      avatarUrl: row.avatar_url as string | undefined,
      shareCount: row.share_count as number,
    }));

    const nextCursor = hasMore && shares.length > 0
      ? shares[shares.length - 1].createdAt.toString()
      : null;

    return new Response(JSON.stringify({ shares, cursor: nextCursor }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Popular shares error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch popular shares' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
