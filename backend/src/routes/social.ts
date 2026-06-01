import type { Env, Document } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { resolvePdsUrl } from '../utils/did-resolver';
import { resolveCanonicalUrl } from '../utils/canonical-url';

interface DocumentRecord {
  $type: string;
  site: string;
  title: string;
  publishedAt: string;
  path?: string;
  description?: string;
  coverImage?: { ref: { $link: string }; mimeType: string };
  textContent?: string;
  bskyPostRef?: { uri: string; cid: string };
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  content?: {
    $type: string;
    pages?: unknown[];
  };
}

interface ListRecordsResponse {
  records: Array<{
    uri: string;
    cid: string;
    value: DocumentRecord;
  }>;
  cursor?: string;
}

/**
 * Backfill documents from a followed user's PDS
 * This is called after successfully creating a follow relationship
 */
export async function backfillDocumentsForUser(env: Env, authorDid: string): Promise<void> {
  console.log(`[backfill] Starting document backfill for ${authorDid}`);

  try {
    // Resolve the user's PDS URL
    const pdsUrl = await resolvePdsUrl(authorDid);
    if (!pdsUrl) {
      console.log(`[backfill] Could not resolve PDS URL for ${authorDid}`);
      return;
    }

    // Fetch their site.standard.document records (public endpoint)
    const collection = 'site.standard.document';
    let cursor: string | undefined;
    let totalInserted = 0;
    const maxPages = 10; // Safety limit
    let pageCount = 0;

    while (pageCount < maxPages) {
      const params = new URLSearchParams({
        repo: authorDid,
        collection,
        limit: '100',
      });
      if (cursor) {
        params.set('cursor', cursor);
      }

      const response = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`);
      if (!response.ok) {
        console.error(`[backfill] Failed to fetch documents from ${pdsUrl}: ${response.status}`);
        break;
      }

      const data = (await response.json()) as ListRecordsResponse;

      // Insert documents into D1
      for (const record of data.records) {
        const doc = record.value;
        const recordUri = record.uri;
        const recordCid = record.cid;

        // Parse dates
        const publishedAtMs = doc.publishedAt ? new Date(doc.publishedAt).getTime() : Date.now();
        const updatedAtMs = doc.updatedAt ? new Date(doc.updatedAt).getTime() : null;
        const createdAtMs = doc.createdAt ? new Date(doc.createdAt).getTime() : Date.now();

        // Extract cover image CID and bsky post URI
        const coverImageCid = doc.coverImage?.ref?.$link || null;
        const bskyPostUri = doc.bskyPostRef?.uri || null;

        // Resolve canonical URL from site + path
        const canonicalUrl = await resolveCanonicalUrl(doc.site || '', doc.path || '', env);

        // Serialize content field if present
        const contentJson = doc.content ? JSON.stringify(doc.content) : null;

        try {
          await env.DB.prepare(
            `
						INSERT INTO documents
						(author_did, record_uri, record_cid, site_uri, title, published_at, path, description,
						 cover_image_cid, text_content, bsky_post_uri, tags, updated_at, canonical_url, content, created_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(record_uri) DO NOTHING
						`
          )
            .bind(
              authorDid,
              recordUri,
              recordCid,
              doc.site || '',
              doc.title || '',
              publishedAtMs,
              doc.path || null,
              doc.description || null,
              coverImageCid,
              doc.textContent || null,
              bskyPostUri,
              doc.tags ? JSON.stringify(doc.tags) : null,
              updatedAtMs,
              canonicalUrl || null,
              contentJson,
              createdAtMs
            )
            .run();
          totalInserted++;
        } catch (dbError) {
          console.error(`[backfill] Error inserting document ${recordUri}:`, dbError);
        }
      }

      // Check for more pages
      if (!data.cursor || data.records.length === 0) {
        break;
      }
      cursor = data.cursor;
      pageCount++;
    }

    console.log(`[backfill] Completed for ${authorDid}: ${totalInserted} documents`);
  } catch (error) {
    console.error(`[backfill] Error backfilling documents for ${authorDid}:`, error);
  }
}

function isValidDid(did: string): boolean {
  return typeof did === 'string' && did.startsWith('did:');
}

// GET /api/social/detect-content?did={did} - Detect available content for a user
export async function handleDetectContent(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const did = url.searchParams.get('did');

  if (!did || !isValidDid(did)) {
    return new Response(JSON.stringify({ error: 'Valid did parameter is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const pdsUrl = await resolvePdsUrl(did);
    if (!pdsUrl) {
      return new Response(JSON.stringify({ did, publications: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Query PDS for the user's publications
    const pubResponse = await fetch(
      `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({
        repo: did,
        collection: 'site.standard.publication',
        limit: '100',
      })}`
    );

    interface PublicationBlobRef {
      ref: { $link: string };
      mimeType: string;
    }

    interface PublicationRecord {
      name?: string;
      url?: string;
      description?: string;
      icon?: PublicationBlobRef;
    }

    let publications: Array<{
      uri: string;
      name: string;
      url: string;
      description?: string;
      iconUrl?: string;
    }> = [];
    if (pubResponse.ok) {
      const pubData = (await pubResponse.json()) as {
        records: Array<{ uri: string; value: PublicationRecord }>;
      };
      publications = pubData.records.map((r) => {
        // Resolve icon blob to CDN URL
        let iconUrl: string | undefined;
        if (r.value.icon?.ref?.$link) {
          iconUrl = `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${r.value.icon.ref.$link}@jpeg`;
        }
        return {
          uri: r.uri,
          name: (r.value as PublicationRecord).name || '',
          url: (r.value as PublicationRecord).url || '',
          description: (r.value as PublicationRecord).description,
          iconUrl,
        };
      });
    }

    return new Response(JSON.stringify({ did, publications }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Detect content error:', error);
    return new Response(JSON.stringify({ error: 'Failed to detect content' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
