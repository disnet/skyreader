import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';

const ALLOWED_COLLECTIONS = ['app.skyreader.feed.subscription', 'app.skyreader.social.share'];

interface SubscriptionRow {
  record_uri: string;
  feed_url: string;
  title: string | null;
  created_at: number;
  source_type: string | null;
  subject_did: string | null;
  custom_title: string | null;
  custom_icon_url: string | null;
}

interface ShareRow {
  record_uri: string;
  record_cid: string;
  feed_url: string | null;
  item_url: string;
  item_title: string | null;
  item_author: string | null;
  item_description: string | null;
  item_image: string | null;
  item_guid: string | null;
  item_published_at: number | null;
  note: string | null;
  tags: string | null;
  created_at: number;
}

export async function handleRecordsList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const collection = url.searchParams.get('collection');

  if (!collection || !ALLOWED_COLLECTIONS.includes(collection)) {
    return new Response(JSON.stringify({ error: 'Invalid collection' }), {
      status: 400,
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
    let records: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];

    if (collection === 'app.skyreader.feed.subscription') {
      const result = await env.DB.prepare(
        'SELECT record_uri, feed_url, title, created_at, source_type, subject_did, custom_title, custom_icon_url FROM subscriptions_cache WHERE user_did = ?'
      )
        .bind(session.did)
        .all<SubscriptionRow>();

      records = result.results.map((row) => {
        // created_at should be unix seconds, but a previous bug stored milliseconds
        // via Jetstream. Detect and handle both: values > 10_000_000_000 are likely ms.
        const createdAtMs =
          row.created_at > 10_000_000_000 ? row.created_at : row.created_at * 1000;
        return {
          uri: row.record_uri,
          cid: '',
          value: {
            $type: collection,
            feedUrl: row.feed_url,
            title: row.title,
            createdAt: new Date(createdAtMs).toISOString(),
            sourceType: row.source_type || undefined,
            subjectDid: row.subject_did || undefined,
            customTitle: row.custom_title || undefined,
            customIconUrl: row.custom_icon_url || undefined,
          },
        };
      });
    } else if (collection === 'app.skyreader.social.share') {
      const result = await env.DB.prepare(
        `SELECT record_uri, record_cid, feed_url, item_url, item_title, item_author,
				        item_description, item_image, item_guid, item_published_at, note, tags, created_at
				 FROM shares WHERE author_did = ?`
      )
        .bind(session.did)
        .all<ShareRow>();

      records = result.results.map((row) => ({
        uri: row.record_uri,
        cid: row.record_cid,
        value: {
          $type: collection,
          feedUrl: row.feed_url,
          itemUrl: row.item_url,
          itemTitle: row.item_title,
          itemAuthor: row.item_author,
          itemDescription: row.item_description,
          itemImage: row.item_image,
          itemGuid: row.item_guid,
          itemPublishedAt: row.item_published_at
            ? new Date(row.item_published_at).toISOString()
            : undefined,
          note: row.note,
          tags: row.tags ? JSON.parse(row.tags) : undefined,
          createdAt: new Date(row.created_at).toISOString(),
        },
      }));
    }

    return new Response(JSON.stringify({ records }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Record list error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to list records' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
