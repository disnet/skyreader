import type { Env, Session } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { pushShareToPds, deleteShareFromPds } from '../services/share-sync';

interface UserShareRow {
  record_uri: string;
  record_cid: string;
  feed_url: string | null;
  item_url: string;
  item_title: string | null;
  item_author: string | null;
  item_description: string | null;
  content: string | null;
  item_image: string | null;
  item_guid: string | null;
  item_published_at: number | null;
  note: string | null;
  created_at: number;
  reshare_of_uri: string | null;
  reshare_of_author_did: string | null;
  reshare_count: number;
}

// GET /api/shares/my - Get user's own shares
export async function handleGetMyShares(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Query user's shares from D1 (no PDS hydration needed)
    const result = await env.DB.prepare(
      `
      SELECT record_uri, record_cid, feed_url, item_url, item_title,
             item_author, item_description, content, item_image, item_guid,
             item_published_at, note, created_at,
             reshare_of_uri, reshare_of_author_did, reshare_count
      FROM shares
      WHERE author_did = ?
      ORDER BY created_at DESC
    `
    )
      .bind(session.did)
      .all<UserShareRow>();

    const shares = result.results.map((row) => ({
      recordUri: row.record_uri,
      recordCid: row.record_cid,
      feedUrl: row.feed_url,
      articleGuid: row.item_guid,
      articleUrl: row.item_url,
      articleTitle: row.item_title,
      articleAuthor: row.item_author,
      articleDescription: row.item_description,
      articleContent: row.content,
      articleImage: row.item_image,
      articlePublishedAt: row.item_published_at
        ? new Date(row.item_published_at).toISOString()
        : undefined,
      note: row.note,
      createdAt: new Date(row.created_at).toISOString(),
      reshareOf: row.reshare_of_uri
        ? {
            uri: row.reshare_of_uri,
            authorDid: row.reshare_of_author_did,
          }
        : undefined,
      reshareCount: row.reshare_count,
    }));

    return new Response(JSON.stringify({ shares }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to get user shares:', error);
    return new Response(JSON.stringify({ error: 'Failed to get shares' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

interface CreateShareRequest {
  rkey: string;
  itemUrl: string;
  feedUrl?: string;
  itemGuid?: string;
  itemTitle?: string;
  itemAuthor?: string;
  itemDescription?: string;
  content?: string;
  itemImage?: string;
  itemPublishedAt?: string;
  note?: string;
  tags?: string[];
  reshareOf?: {
    uri: string;
    authorDid: string;
  };
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// Traverse reshare chain and increment reshare_count on all shares in the chain
async function incrementReshareChainCounts(env: Env, startUri: string): Promise<void> {
  const visited = new Set<string>();
  let currentUri: string | null = startUri;

  while (currentUri && !visited.has(currentUri)) {
    visited.add(currentUri);

    // Increment reshare count for this share
    await env.DB.prepare('UPDATE shares SET reshare_count = reshare_count + 1 WHERE record_uri = ?')
      .bind(currentUri)
      .run();

    // Get the next share in the chain (what this share reshared)
    const chainResult: { reshare_of_uri: string | null } | null = await env.DB.prepare(
      'SELECT reshare_of_uri FROM shares WHERE record_uri = ?'
    )
      .bind(currentUri)
      .first();

    currentUri = chainResult?.reshare_of_uri || null;
  }
}

// POST /api/shares - Create a share
export async function handleCreateShare(
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

  let body: CreateShareRequest;
  try {
    body = (await request.json()) as CreateShareRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const {
    rkey,
    itemUrl,
    feedUrl,
    itemGuid,
    itemTitle,
    itemAuthor,
    itemDescription,
    content,
    itemImage,
    itemPublishedAt,
    note,
    tags,
    reshareOf,
  } = body;

  // Validate required fields
  if (!rkey || typeof rkey !== 'string') {
    return new Response(JSON.stringify({ error: 'rkey is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!itemUrl || typeof itemUrl !== 'string') {
    return new Response(JSON.stringify({ error: 'itemUrl is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!isValidUrl(itemUrl)) {
    return new Response(JSON.stringify({ error: 'itemUrl must be a valid URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const collection = 'app.skyreader.social.share';
    const recordUri = `at://${session.did}/${collection}/${rkey}`;
    const createdAt = Date.now();

    // Ensure user exists in users table
    await env.DB.prepare(
      `
			INSERT INTO users (did, handle, display_name, avatar_url, pds_url, updated_at)
			VALUES (?, ?, ?, ?, ?, unixepoch())
			ON CONFLICT(did) DO UPDATE SET
				handle = excluded.handle,
				display_name = COALESCE(excluded.display_name, users.display_name),
				avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
				updated_at = unixepoch()
			`
    )
      .bind(
        session.did,
        session.handle || session.did,
        session.displayName || null,
        session.avatarUrl || null,
        session.pdsUrl
      )
      .run();

    // Push to PDS first to get the CID
    const pdsResult = await pushShareToPds(session, rkey, {
      itemUrl,
      feedUrl,
      itemGuid,
      itemTitle,
      itemAuthor,
      itemDescription,
      content,
      itemImage,
      itemPublishedAt,
      note,
      tags,
      reshareOf,
    });

    let recordCid = '';
    let finalUri = recordUri;

    if (pdsResult.success) {
      recordCid = pdsResult.data.cid;
      finalUri = pdsResult.data.uri;
    } else {
      // Log the error but continue with local storage
      console.error('[CreateShare] Failed to push to PDS:', pdsResult.error);
    }

    await env.DB.prepare(
      `
			INSERT OR REPLACE INTO shares
			(author_did, record_uri, record_cid, feed_url, item_url, item_title,
			 item_author, item_description, item_image, item_guid, item_published_at, note, tags, content, created_at,
			 reshare_of_uri, reshare_of_author_did, reshare_count)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
			`
    )
      .bind(
        session.did,
        finalUri,
        recordCid,
        feedUrl || null,
        itemUrl,
        itemTitle || null,
        itemAuthor || null,
        itemDescription || null,
        itemImage || null,
        itemGuid || null,
        itemPublishedAt ? new Date(itemPublishedAt).getTime() : null,
        note || null,
        tags ? JSON.stringify(tags) : null,
        content || null,
        createdAt,
        reshareOf?.uri || null,
        reshareOf?.authorDid || null
      )
      .run();

    // If this is a reshare, increment reshare counts on the entire chain
    if (reshareOf?.uri) {
      await incrementReshareChainCounts(env, reshareOf.uri);
    }

    return new Response(
      JSON.stringify({
        rkey,
        uri: finalUri,
        cid: recordCid,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Create share error:', error);
    const errorMessage =
      error instanceof Error ? `${error.name}: ${error.message}` : 'Failed to create share';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// DELETE /api/shares/:rkey - Delete a share
export async function handleDeleteShare(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'DELETE') {
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

  // Extract rkey from URL path
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const rkey = pathParts[pathParts.length - 1];

  if (!rkey || rkey === 'shares') {
    return new Response(JSON.stringify({ error: 'rkey is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const collection = 'app.skyreader.social.share';
    const atUri = `at://${session.did}/${collection}/${rkey}`;

    // Delete from D1
    await env.DB.prepare('DELETE FROM shares WHERE record_uri = ?').bind(atUri).run();

    // Delete from PDS in background
    ctx.waitUntil(
      deleteShareFromPds(session, rkey).then((result) => {
        if (!result.success) {
          console.error('[DeleteShare] Failed to delete from PDS:', result.error);
        }
      })
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Delete share error:', error);
    const errorMessage =
      error instanceof Error ? `${error.name}: ${error.message}` : 'Failed to delete share';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// PATCH /api/shares/:rkey - Update the note (commentary) on an existing share.
// Body: { note: string } (empty string clears the note). We re-push the record
// to the PDS with the new note, preserving its original createdAt and all other
// article fields read back from D1, then update the cached note.
export async function handleUpdateShare(request: Request, env: Env): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  if (request.method !== 'PATCH') return json({ error: 'Method not allowed' }, 405);

  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const pathParts = new URL(request.url).pathname.split('/');
  const rkey = pathParts[pathParts.length - 1];
  if (!rkey || rkey === 'shares') return json({ error: 'rkey is required' }, 400);

  let body: { note?: string };
  try {
    body = (await request.json()) as { note?: string };
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof body.note !== 'string') return json({ error: 'note must be a string' }, 400);
  const note = body.note.trim();

  try {
    const collection = 'app.skyreader.social.share';
    const atUri = `at://${session.did}/${collection}/${rkey}`;

    const row = await env.DB.prepare(
      `SELECT record_uri, feed_url, item_url, item_title, item_author, item_description,
              content, item_image, item_guid, item_published_at, note, created_at,
              reshare_of_uri, reshare_of_author_did
       FROM shares WHERE author_did = ? AND record_uri = ?`
    )
      .bind(session.did, atUri)
      .first<UserShareRow>();

    if (!row) return json({ error: 'Share not found' }, 404);

    // Re-push to the PDS with the new note, preserving the original createdAt and
    // all article fields so only the commentary changes.
    const pdsResult = await pushShareToPds(session, rkey, {
      itemUrl: row.item_url,
      feedUrl: row.feed_url || undefined,
      itemGuid: row.item_guid || undefined,
      itemTitle: row.item_title || undefined,
      itemAuthor: row.item_author || undefined,
      itemDescription: row.item_description || undefined,
      content: row.content || undefined,
      itemImage: row.item_image || undefined,
      itemPublishedAt: row.item_published_at
        ? new Date(row.item_published_at).toISOString()
        : undefined,
      note: note || undefined,
      reshareOf:
        row.reshare_of_uri && row.reshare_of_author_did
          ? { uri: row.reshare_of_uri, authorDid: row.reshare_of_author_did }
          : undefined,
      createdAt: new Date(row.created_at).toISOString(),
    });
    if (!pdsResult.success) {
      console.error('[UpdateShare] Failed to push to PDS:', pdsResult.error);
      return json({ error: pdsResult.error }, pdsResult.retryable ? 503 : 502);
    }

    await env.DB.prepare('UPDATE shares SET note = ? WHERE author_did = ? AND record_uri = ?')
      .bind(note || null, session.did, atUri)
      .run();

    return json({ success: true, uri: pdsResult.data.uri, rkey });
  } catch (error) {
    console.error('Update share error:', error);
    const errorMessage =
      error instanceof Error ? `${error.name}: ${error.message}` : 'Failed to update share';
    return json({ error: errorMessage }, 500);
  }
}
