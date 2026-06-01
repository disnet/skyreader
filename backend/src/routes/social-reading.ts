import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';

export type SocialItemType = 'share' | 'document';

interface MarkSocialItemAsReadRequest {
  type: SocialItemType;
  rkey: string;
  itemUri: string;
  authorDid: string;
  itemUrl?: string;
  itemTitle?: string;
}

function isValidAtUri(uri: string): boolean {
  return typeof uri === 'string' && uri.startsWith('at://');
}

function isValidDid(did: string): boolean {
  return typeof did === 'string' && did.startsWith('did:');
}

function isValidItemType(type: string): type is SocialItemType {
  return type === 'share' || type === 'document';
}

// GET /api/social/read-positions - Get all social read positions
export async function handleGetSocialReadPositions(request: Request, env: Env): Promise<Response> {
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

  // Optional type filter
  const url = new URL(request.url);
  const typeFilter = url.searchParams.get('type');

  try {
    let query = `SELECT rkey, item_type, item_uri, author_did, item_url, item_title, read_at
			 FROM social_read_positions_cache
			 WHERE user_did = ?`;
    const bindings: (string | null)[] = [session.did];

    if (typeFilter && isValidItemType(typeFilter)) {
      query += ' AND item_type = ?';
      bindings.push(typeFilter);
    }

    const result = await env.DB.prepare(query)
      .bind(...bindings)
      .all<{
        rkey: string;
        item_type: string;
        item_uri: string;
        author_did: string;
        item_url: string | null;
        item_title: string | null;
        read_at: string;
      }>();

    return new Response(
      JSON.stringify({
        positions: result.results.map((row) => ({
          rkey: row.rkey,
          type: row.item_type,
          itemUri: row.item_uri,
          authorDid: row.author_did,
          itemUrl: row.item_url,
          itemTitle: row.item_title,
          readAt: row.read_at,
        })),
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Get social read positions error:', error);
    const errorMessage =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : 'Failed to get social read positions';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST /api/social/read-positions - Mark a social item as read (upsert)
export async function handleMarkSocialItemAsRead(request: Request, env: Env): Promise<Response> {
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

  let body: MarkSocialItemAsReadRequest;
  try {
    body = (await request.json()) as MarkSocialItemAsReadRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { type, rkey, itemUri, authorDid, itemUrl, itemTitle } = body;

  // Validate required fields
  if (!type || !isValidItemType(type)) {
    return new Response(JSON.stringify({ error: 'type must be "share" or "document"' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!rkey || typeof rkey !== 'string') {
    return new Response(JSON.stringify({ error: 'rkey is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!itemUri || typeof itemUri !== 'string') {
    return new Response(JSON.stringify({ error: 'itemUri is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!isValidAtUri(itemUri)) {
    return new Response(JSON.stringify({ error: 'itemUri must be a valid AT URI' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!authorDid || typeof authorDid !== 'string') {
    return new Response(JSON.stringify({ error: 'authorDid is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!isValidDid(authorDid)) {
    return new Response(JSON.stringify({ error: 'authorDid must be a valid DID' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const collection = `app.skyreader.social.${type}ReadPosition`;
    const recordUri = `at://${session.did}/${collection}/${rkey}`;
    const readAt = new Date().toISOString();

    await env.DB.prepare(
      `
			INSERT INTO social_read_positions_cache
			(user_did, rkey, record_uri, item_type, item_uri, author_did, item_url, item_title, read_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
			ON CONFLICT(user_did, item_uri) DO UPDATE SET
				rkey = excluded.rkey,
				record_uri = excluded.record_uri,
				item_type = excluded.item_type,
				item_url = excluded.item_url,
				item_title = excluded.item_title,
				read_at = excluded.read_at
			`
    )
      .bind(
        session.did,
        rkey,
        recordUri,
        type,
        itemUri,
        authorDid,
        itemUrl || null,
        itemTitle || null,
        readAt
      )
      .run();

    return new Response(
      JSON.stringify({
        rkey,
        uri: recordUri,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Mark social item as read error:', error);
    const errorMessage =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : 'Failed to mark social item as read';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST /api/social/read-positions/bulk - Mark multiple social items as read
export async function handleBulkMarkSocialItemsAsRead(
  request: Request,
  env: Env
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

  let body: {
    items: Array<{
      type: SocialItemType;
      rkey: string;
      itemUri: string;
      authorDid: string;
      itemUrl?: string;
      itemTitle?: string;
    }>;
  };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { items } = body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return new Response(JSON.stringify({ error: 'items array is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (items.length > 500) {
    return new Response(JSON.stringify({ error: 'Too many items (max 500)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate all items
  for (const item of items) {
    if (!item.type || !isValidItemType(item.type)) {
      return new Response(JSON.stringify({ error: 'Each item must have a valid type' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!item.rkey || !item.itemUri || !item.authorDid) {
      return new Response(
        JSON.stringify({ error: 'Each item must have rkey, itemUri, and authorDid' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    if (!isValidAtUri(item.itemUri)) {
      return new Response(JSON.stringify({ error: 'Each itemUri must be a valid AT URI' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!isValidDid(item.authorDid)) {
      return new Response(JSON.stringify({ error: 'Each authorDid must be a valid DID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  try {
    const readAt = new Date().toISOString();

    const statements = items.map((item) => {
      const collection = `app.skyreader.social.${item.type}ReadPosition`;
      const recordUri = `at://${session.did}/${collection}/${item.rkey}`;

      return env.DB.prepare(
        `
        INSERT INTO social_read_positions_cache
        (user_did, rkey, record_uri, item_type, item_uri, author_did, item_url, item_title, read_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(user_did, item_uri) DO UPDATE SET
          rkey = excluded.rkey,
          record_uri = excluded.record_uri,
          item_type = excluded.item_type,
          item_url = excluded.item_url,
          item_title = excluded.item_title,
          read_at = excluded.read_at
        `
      ).bind(
        session.did,
        item.rkey,
        recordUri,
        item.type,
        item.itemUri,
        item.authorDid,
        item.itemUrl || null,
        item.itemTitle || null,
        readAt
      );
    });

    await env.DB.batch(statements);

    return new Response(
      JSON.stringify({
        success: true,
        marked: items.length,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Bulk mark social items as read error:', error);
    const errorMessage =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : 'Failed to bulk mark social items as read';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// DELETE /api/social/read-positions/:rkey - Remove social read position
export async function handleMarkSocialItemAsUnread(request: Request, env: Env): Promise<Response> {
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

  if (!rkey || rkey === 'read-positions') {
    return new Response(JSON.stringify({ error: 'rkey is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await env.DB.prepare('DELETE FROM social_read_positions_cache WHERE user_did = ? AND rkey = ?')
      .bind(session.did, rkey)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Mark social item as unread error:', error);
    const errorMessage =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : 'Failed to mark social item as unread';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
