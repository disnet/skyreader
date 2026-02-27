import type { Env, Share, Document } from '../types';
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

interface ShareRecord {
  $type?: string;
  feedUrl?: string;
  itemUrl: string;
  itemTitle?: string;
  itemAuthor?: string;
  itemDescription?: string;
  content?: string;
  itemImage?: string;
  itemGuid?: string;
  itemPublishedAt?: string;
  note?: string;
  tags?: string[];
  createdAt?: string;
  reshareOf?: { uri: string; authorDid: string };
}

interface ShareListRecordsResponse {
  records: Array<{
    uri: string;
    cid: string;
    value: ShareRecord;
  }>;
  cursor?: string;
}

/**
 * Backfill shares from a user's PDS
 * Called after creating an atproto.shares subscription
 */
export async function backfillSharesForUser(env: Env, authorDid: string): Promise<void> {
  console.log(`[backfill] Starting share backfill for ${authorDid}`);

  try {
    const pdsUrl = await resolvePdsUrl(authorDid);
    if (!pdsUrl) {
      console.log(`[backfill] Could not resolve PDS URL for ${authorDid}`);
      return;
    }

    const collection = 'app.skyreader.social.share';
    let cursor: string | undefined;
    let totalInserted = 0;
    const maxPages = 10;
    let pageCount = 0;

    // Ensure user exists (for FK constraint)
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (did, handle, pds_url, created_at, updated_at)
       VALUES (?, ?, '', unixepoch(), unixepoch())`
    )
      .bind(authorDid, authorDid)
      .run();

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
        console.error(`[backfill] Failed to fetch shares from ${pdsUrl}: ${response.status}`);
        break;
      }

      const data = (await response.json()) as ShareListRecordsResponse;

      for (const record of data.records) {
        const share = record.value;
        const recordUri = record.uri;
        const recordCid = record.cid;

        const createdAtMs = share.createdAt ? new Date(share.createdAt).getTime() : Date.now();
        const itemPublishedAtMs = share.itemPublishedAt
          ? new Date(share.itemPublishedAt).getTime()
          : null;

        try {
          await env.DB.prepare(
            `INSERT INTO shares
             (author_did, record_uri, record_cid, feed_url, item_url, item_title,
              item_author, item_description, item_image, item_guid, item_published_at,
              note, tags, content, created_at, reshare_of_uri, reshare_of_author_did, reshare_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
             ON CONFLICT(record_uri) DO NOTHING`
          )
            .bind(
              authorDid,
              recordUri,
              recordCid,
              share.feedUrl || null,
              share.itemUrl,
              share.itemTitle || null,
              share.itemAuthor || null,
              share.itemDescription || null,
              share.itemImage || null,
              share.itemGuid || null,
              itemPublishedAtMs,
              share.note || null,
              share.tags ? JSON.stringify(share.tags) : null,
              share.content || null,
              createdAtMs,
              share.reshareOf?.uri || null,
              share.reshareOf?.authorDid || null
            )
            .run();
          totalInserted++;
        } catch (dbError) {
          console.error(`[backfill] Error inserting share ${recordUri}:`, dbError);
        }
      }

      if (!data.cursor || data.records.length === 0) {
        break;
      }
      cursor = data.cursor;
      pageCount++;
    }

    console.log(`[backfill] Completed shares for ${authorDid}: ${totalInserted} shares`);
  } catch (error) {
    console.error(`[backfill] Error backfilling shares for ${authorDid}:`, error);
  }
}

function isValidDid(did: string): boolean {
  return typeof did === 'string' && did.startsWith('did:');
}

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
  const includeDocuments = url.searchParams.get('include') === 'documents';

  try {
    // Get shares from users the current user follows via subscriptions
    const sharesQuery = `
      SELECT
        s.id, s.author_did, s.record_uri, s.record_cid,
        s.feed_url, s.item_url, s.item_title, s.item_author, s.item_description,
        s.item_image, s.item_guid, s.item_published_at,
        s.note, s.tags, s.content, s.indexed_at, s.created_at,
        s.reshare_of_uri, s.reshare_of_author_did, s.reshare_count
      FROM shares s
      WHERE s.author_did IN (
        SELECT subject_did FROM subscriptions_cache
        WHERE user_did = ? AND source_type = 'atproto.shares'
      )
        AND s.created_at < ?
      ORDER BY s.created_at DESC
      LIMIT ?
    `;

    const cursorTimestamp = cursor ? parseInt(cursor, 10) : Date.now() * 1000;
    const results = await env.DB.prepare(sharesQuery)
      .bind(session.did, cursorTimestamp, limit + 1)
      .all();

    const hasMoreShares = results.results.length > limit;
    const rawShares = results.results.slice(0, limit);
    const shares = rawShares.map((row: Record<string, unknown>) => ({
      id: row.id as number,
      authorDid: row.author_did as string,
      recordUri: row.record_uri as string,
      recordCid: row.record_cid as string,
      feedUrl: row.feed_url as string | undefined,
      itemUrl: row.item_url as string,
      itemTitle: row.item_title as string | undefined,
      itemAuthor: row.item_author as string | undefined,
      itemDescription: row.item_description as string | undefined,
      itemImage: row.item_image as string | undefined,
      itemGuid: row.item_guid as string | undefined,
      itemPublishedAt: row.item_published_at
        ? new Date(row.item_published_at as number).toISOString()
        : undefined,
      note: row.note as string | undefined,
      tags: row.tags ? JSON.parse(row.tags as string) : undefined,
      content: row.content as string | undefined,
      indexedAt: new Date((row.indexed_at as number) || Date.now()).toISOString(),
      createdAt: new Date(row.created_at as number).toISOString(),
      reshareOf:
        row.reshare_of_uri && row.reshare_of_author_did
          ? {
              uri: row.reshare_of_uri as string,
              authorDid: row.reshare_of_author_did as string,
            }
          : undefined,
      reshareCount: (row.reshare_count as number) || 0,
    })) as Share[];

    // Use raw timestamp for cursor (for pagination query)
    const lastRawShare = rawShares[rawShares.length - 1];
    let nextCursor =
      hasMoreShares && lastRawShare ? (lastRawShare.created_at as number).toString() : null;

    // Optionally include documents
    let documents: Document[] = [];
    if (includeDocuments) {
      const documentsQuery = `
        SELECT
          d.id, d.author_did, d.record_uri, d.site_uri, d.title,
          d.published_at, d.path, d.description, d.cover_image_cid,
          d.text_content, d.bsky_post_uri, d.tags, d.updated_at,
          d.canonical_url, d.content, d.indexed_at, d.created_at,
          pc.icon as site_icon
        FROM documents d
        LEFT JOIN publications_cache pc ON pc.publication_uri = d.site_uri
        WHERE EXISTS (
          SELECT 1 FROM subscriptions_cache sc
          WHERE sc.user_did = ?
            AND sc.source_type = 'atproto.documents'
            AND sc.subject_did = d.author_did
            AND (sc.feed_url = '' OR sc.feed_url IS NULL OR sc.feed_url = d.site_uri
              OR (sc.feed_url = '__freestanding__' AND (d.site_uri = '' OR d.site_uri IS NULL OR d.site_uri NOT LIKE 'at://%')))
        )
          AND d.published_at < ?
        ORDER BY d.published_at DESC
        LIMIT ?
      `;

      const docResults = await env.DB.prepare(documentsQuery)
        .bind(session.did, cursorTimestamp, limit + 1)
        .all();

      const hasMoreDocs = docResults.results.length > limit;
      const rawDocs = docResults.results.slice(0, limit);
      documents = rawDocs.map((row: Record<string, unknown>) => ({
        id: row.id as number,
        authorDid: row.author_did as string,
        recordUri: row.record_uri as string,
        siteUri: row.site_uri as string,
        title: row.title as string,
        publishedAt: new Date(row.published_at as number).toISOString(),
        path: row.path as string | undefined,
        description: row.description as string | undefined,
        coverImageCid: row.cover_image_cid as string | undefined,
        textContent: row.text_content as string | undefined,
        bskyPostUri: row.bsky_post_uri as string | undefined,
        tags: row.tags ? JSON.parse(row.tags as string) : undefined,
        updatedAt: row.updated_at ? new Date(row.updated_at as number).toISOString() : undefined,
        canonicalUrl: row.canonical_url as string | undefined,
        content: row.content ? JSON.parse(row.content as string) : undefined,
        indexedAt: new Date((row.indexed_at as number) || Date.now()).toISOString(),
        createdAt: new Date(row.created_at as number).toISOString(),
        siteIcon: row.site_icon as string | undefined,
      })) as Document[];

      // If documents have more to load, we need to account for that in cursor
      // For combined pagination, use the earlier of the two cursors
      if (
        hasMoreDocs &&
        (!nextCursor ||
          (rawDocs[rawDocs.length - 1]?.published_at as number) < parseInt(nextCursor, 10))
      ) {
        nextCursor =
          (rawDocs[rawDocs.length - 1]?.published_at as number)?.toString() || nextCursor;
      }
    }

    const response: { shares: Share[]; documents?: Document[]; cursor: string | null } = {
      shares,
      cursor: nextCursor,
    };
    if (includeDocuments) {
      response.documents = documents;
    }

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Social feed error:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch social feed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// New grouped social feed endpoint for deduplication
export async function handleGroupedSocialFeed(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 50);

  try {
    // Get all shares from followed users, grouped by article
    const query = `
      SELECT
        s.id, s.author_did, s.record_uri, s.record_cid,
        s.feed_url, s.item_url, s.item_title, s.item_author, s.item_description,
        s.item_image, s.item_guid, s.item_published_at,
        s.note, s.tags, s.content, s.indexed_at, s.created_at,
        s.reshare_of_uri, s.reshare_of_author_did, s.reshare_count
      FROM shares s
      WHERE s.author_did IN (
        SELECT subject_did FROM subscriptions_cache
        WHERE user_did = ? AND source_type = 'atproto.shares'
      )
        AND s.created_at < ?
      ORDER BY s.created_at DESC
      LIMIT ?
    `;

    const cursorTimestamp = cursor ? parseInt(cursor, 10) : Date.now() * 1000;
    // Fetch extra to ensure we have enough after grouping
    const results = await env.DB.prepare(query)
      .bind(session.did, cursorTimestamp, (limit + 1) * 3)
      .all();

    // Group shares by item_url
    const groupMap = new Map<
      string,
      {
        itemUrl: string;
        itemTitle?: string;
        itemAuthor?: string;
        itemDescription?: string;
        itemImage?: string;
        itemGuid?: string;
        itemPublishedAt?: string;
        feedUrl?: string;
        content?: string;
        sharers: Array<{
          did: string;
          recordUri: string;
          createdAt: string;
          note?: string;
          reshareCount: number;
        }>;
        firstShareCreatedAt: number;
        latestShareCreatedAt: number;
      }
    >();

    for (const row of results.results) {
      const itemUrl = row.item_url as string;
      const createdAtMs = row.created_at as number;

      if (!groupMap.has(itemUrl)) {
        groupMap.set(itemUrl, {
          itemUrl,
          itemTitle: row.item_title as string | undefined,
          itemAuthor: row.item_author as string | undefined,
          itemDescription: row.item_description as string | undefined,
          itemImage: row.item_image as string | undefined,
          itemGuid: row.item_guid as string | undefined,
          itemPublishedAt: row.item_published_at
            ? new Date(row.item_published_at as number).toISOString()
            : undefined,
          feedUrl: row.feed_url as string | undefined,
          content: row.content as string | undefined,
          sharers: [],
          firstShareCreatedAt: createdAtMs,
          latestShareCreatedAt: createdAtMs,
        });
      }

      const group = groupMap.get(itemUrl)!;
      group.sharers.push({
        did: row.author_did as string,
        recordUri: row.record_uri as string,
        createdAt: new Date(createdAtMs).toISOString(),
        note: row.note as string | undefined,
        reshareCount: (row.reshare_count as number) || 0,
      });

      // Track earliest and latest share times
      if (createdAtMs < group.firstShareCreatedAt) {
        group.firstShareCreatedAt = createdAtMs;
      }
      if (createdAtMs > group.latestShareCreatedAt) {
        group.latestShareCreatedAt = createdAtMs;
      }
    }

    // Convert to array and sort by latest share time (most recent activity first)
    const groupedShares = Array.from(groupMap.values())
      .sort((a, b) => b.latestShareCreatedAt - a.latestShareCreatedAt)
      .slice(0, limit + 1);

    const hasMore = groupedShares.length > limit;
    const resultGroups = groupedShares.slice(0, limit);

    // Format for response
    const groups = resultGroups.map((g) => {
      // Sort sharers by createdAt ascending to find first sharer
      const sortedSharers = [...g.sharers].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

      return {
        itemUrl: g.itemUrl,
        itemTitle: g.itemTitle,
        itemAuthor: g.itemAuthor,
        itemDescription: g.itemDescription,
        itemImage: g.itemImage,
        itemGuid: g.itemGuid,
        itemPublishedAt: g.itemPublishedAt,
        feedUrl: g.feedUrl,
        content: g.content,
        sharers: sortedSharers,
        firstSharer: {
          did: sortedSharers[0].did,
          recordUri: sortedSharers[0].recordUri,
        },
        totalShareCount: sortedSharers.length,
        latestShareAt: new Date(g.latestShareCreatedAt).toISOString(),
      };
    });

    // Cursor is based on the latest share time of the last group
    const lastGroup = resultGroups[resultGroups.length - 1];
    const nextCursor = hasMore && lastGroup ? lastGroup.latestShareCreatedAt.toString() : null;

    return new Response(JSON.stringify({ groups, cursor: nextCursor }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Grouped social feed error:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch grouped social feed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
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
    // Profile data (handle, avatar) fetched by frontend directly from Bluesky
    const query = `
      SELECT
        s.id, s.author_did, s.record_uri, s.record_cid,
        s.feed_url, s.item_url, s.item_title, s.item_author, s.item_description,
        s.item_image, s.item_guid, s.item_published_at,
        s.note, s.tags, s.content, s.indexed_at, s.created_at,
        COUNT(*) OVER (PARTITION BY s.item_url) as share_count
      FROM shares s
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
    const rawShares = results.results.slice(0, limit);
    const shares = rawShares.map((row: Record<string, unknown>) => ({
      id: row.id as number,
      authorDid: row.author_did as string,
      recordUri: row.record_uri as string,
      recordCid: row.record_cid as string,
      feedUrl: row.feed_url as string | undefined,
      itemUrl: row.item_url as string,
      itemTitle: row.item_title as string | undefined,
      itemAuthor: row.item_author as string | undefined,
      itemDescription: row.item_description as string | undefined,
      itemImage: row.item_image as string | undefined,
      itemGuid: row.item_guid as string | undefined,
      itemPublishedAt: row.item_published_at
        ? new Date(row.item_published_at as number).toISOString()
        : undefined,
      note: row.note as string | undefined,
      tags: row.tags ? JSON.parse(row.tags as string) : undefined,
      content: row.content as string | undefined,
      indexedAt: new Date((row.indexed_at as number) || Date.now()).toISOString(),
      createdAt: new Date(row.created_at as number).toISOString(),
      shareCount: row.share_count as number,
    }));

    // Use raw timestamp for cursor (for pagination query)
    const lastRawShare = rawShares[rawShares.length - 1];
    const nextCursor =
      hasMore && lastRawShare ? (lastRawShare.created_at as number).toString() : null;

    return new Response(JSON.stringify({ shares, cursor: nextCursor }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Popular shares error:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch popular shares' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// GET /api/activity/reshares - Get activity for user's shares that were reshared
// Returns reshares grouped by article
export async function handleReshareActivity(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 50);

  try {
    // Use recursive CTE to find all reshares in chains that trace back to user's original shares
    // This handles: A shares -> B reshares A -> C reshares B -> A sees both B and C
    const query = `
      WITH RECURSIVE share_chain AS (
        -- Base case: user's own shares (the roots of chains we care about)
        SELECT
          record_uri,
          record_uri as root_uri,
          item_url as root_item_url,
          item_title as root_item_title,
          0 as depth
        FROM shares
        WHERE author_did = ?

        UNION ALL

        -- Recursive case: find reshares of shares in our chain
        SELECT
          s.record_uri,
          sc.root_uri,
          sc.root_item_url,
          sc.root_item_title,
          sc.depth + 1
        FROM shares s
        INNER JOIN share_chain sc ON s.reshare_of_uri = sc.record_uri
        WHERE sc.depth < 10  -- Limit chain depth to prevent infinite loops
      )
      SELECT
        resharer.author_did as resharer_did,
        resharer.record_uri as reshare_uri,
        resharer.created_at as reshared_at,
        sc.root_uri as original_uri,
        sc.root_item_url as item_url,
        sc.root_item_title as item_title
      FROM shares resharer
      INNER JOIN share_chain sc ON resharer.reshare_of_uri = sc.record_uri
      WHERE resharer.author_did != ?
      ORDER BY resharer.created_at DESC
    `;

    const results = await env.DB.prepare(query).bind(session.did, session.did).all();

    // Group reshares by article (item_url)
    const groupMap = new Map<
      string,
      {
        itemUrl: string;
        itemTitle?: string;
        originalUri: string;
        resharers: Array<{ did: string; resharedAt: string }>;
        latestReshareAt: number;
      }
    >();

    for (const row of results.results) {
      const itemUrl = row.item_url as string;
      const resharedAtMs = row.reshared_at as number;

      if (!groupMap.has(itemUrl)) {
        groupMap.set(itemUrl, {
          itemUrl,
          itemTitle: row.item_title as string | undefined,
          originalUri: row.original_uri as string,
          resharers: [],
          latestReshareAt: resharedAtMs,
        });
      }

      const group = groupMap.get(itemUrl)!;
      group.resharers.push({
        did: row.resharer_did as string,
        resharedAt: new Date(resharedAtMs).toISOString(),
      });

      if (resharedAtMs > group.latestReshareAt) {
        group.latestReshareAt = resharedAtMs;
      }
    }

    // Convert to array and sort by latest reshare time
    const allGroups = Array.from(groupMap.values()).sort(
      (a, b) => b.latestReshareAt - a.latestReshareAt
    );

    // Apply cursor-based pagination
    const cursorTimestamp = cursor ? parseInt(cursor, 10) : Date.now() * 1000;
    const filteredGroups = allGroups.filter((g) => g.latestReshareAt < cursorTimestamp);
    const hasMore = filteredGroups.length > limit;
    const resultGroups = filteredGroups.slice(0, limit);

    // Format response
    const activity = resultGroups.map((g) => ({
      originalShare: {
        uri: g.originalUri,
        itemUrl: g.itemUrl,
        itemTitle: g.itemTitle,
      },
      resharers: g.resharers,
      totalCount: g.resharers.length,
      latestReshareAt: new Date(g.latestReshareAt).toISOString(),
    }));

    const lastGroup = resultGroups[resultGroups.length - 1];
    const nextCursor = hasMore && lastGroup ? lastGroup.latestReshareAt.toString() : null;

    return new Response(JSON.stringify({ activity, cursor: nextCursor }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Reshare activity error:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch reshare activity' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
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
      return new Response(
        JSON.stringify({ did, publications: [], shareCount: 0, freestandingDocumentCount: 0 }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Query PDS in parallel for publications, shares, and documents
    const [pubResponse, sharesResponse, docsResponse] = await Promise.all([
      fetch(
        `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({
          repo: did,
          collection: 'site.standard.publication',
          limit: '100',
        })}`
      ),
      fetch(
        `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({
          repo: did,
          collection: 'app.skyreader.social.share',
          limit: '100',
        })}`
      ),
      fetch(
        `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({
          repo: did,
          collection: 'site.standard.document',
          limit: '100',
        })}`
      ),
    ]);

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

    interface SharesListResponse {
      records: Array<{ uri: string }>;
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

    let shareCount = 0;
    if (sharesResponse.ok) {
      const sharesData = (await sharesResponse.json()) as SharesListResponse;
      shareCount = sharesData.records.length;
    }

    // Count free-standing documents (not associated with any publication)
    let freestandingDocumentCount = 0;
    if (docsResponse.ok) {
      const docsData = (await docsResponse.json()) as {
        records: Array<{ uri: string; value: { site?: string } }>;
      };
      const publicationUris = new Set(publications.map((p) => p.uri));
      freestandingDocumentCount = docsData.records.filter(
        (r) => !r.value.site || !publicationUris.has(r.value.site)
      ).length;
    }

    return new Response(
      JSON.stringify({ did, publications, shareCount, freestandingDocumentCount }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Detect content error:', error);
    return new Response(JSON.stringify({ error: 'Failed to detect content' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
