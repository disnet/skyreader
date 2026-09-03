/**
 * Reading Rooms spike — a public reading room IS a Semble/Margin collection.
 * See docs/plans/READING_ROOMS_SPIKE.md.
 *
 * The room's identity is the collection at-uri; membership (readAlong records)
 * is aggregated client-side via Constellation, so the backend's whole surface is:
 *  - GET  /api/rooms?uri=…   — resolve the collection into its article list
 *    (reuses the auth-free backing read path) plus per-article read counts.
 *  - POST /api/rooms/read    — count a read made through the room surface.
 *
 * Reads are counted ONLY through the room surface, never joined against existing
 * read state (joining must not retroactively disclose reading history). Counts
 * are aggregate and anonymous; per-user rows never leave D1.
 */

import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import {
  snapshotBackedCollection,
  getRecordPublic,
  type BackingProviderName,
} from '../services/backing/read';
import { createPDSClient } from '../services/pds-client';
import { hasRequiredScopes, insufficientScopesResponse } from './auth';
import { READING_ROOM_SCOPES } from '../config/scopes';
import { parseAtUri } from '../utils/canonical-url';
import { resolvePdsUrl } from '../utils/did-resolver';
import { normalizeArticleUrl } from '../utils/url-normalize';

export const READ_ALONG_COLLECTION = 'app.skyreader.reading.readAlong';

// Client-minted TID, same shape the e2e seeds validate subscription rkeys against.
const TID_RE = /^[a-z0-9]{13,16}$/;

interface ReadAlongRecord {
  $type: string;
  subject: string;
  createdAt: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Map a collection record's NSID to the backing provider that reads it. */
function providerForCollection(nsid: string): BackingProviderName | null {
  if (nsid === 'network.cosmik.collection') return 'semble';
  if (nsid === 'at.margin.collection') return 'margin';
  return null;
}

export interface RoomItem {
  url: string;
  urlNormalized: string;
  itemType: string;
  title?: string;
  author?: string;
  description?: string;
  image?: string;
  readCount: number;
  readByMe: boolean;
}

/**
 * GET /api/rooms?uri=<collection at-uri>
 * Resolves the collection record (title/description) and its article members,
 * annotated with room-scoped read counts. `complete: false` means the snapshot
 * was truncated or a member failed to resolve transiently — render what came
 * back, but don't present it as the whole list.
 */
export async function handleGetRoom(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const uri = new URL(request.url).searchParams.get('uri');
  if (!uri) return json({ error: 'Missing uri parameter' }, 400);

  const ref = parseAtUri(uri);
  if (!ref) return json({ error: 'Invalid at-uri' }, 400);

  const provider = providerForCollection(ref.collection);
  if (!provider) {
    return json({ error: `Unsupported collection type: ${ref.collection}` }, 400);
  }

  try {
    const pds = await resolvePdsUrl(ref.did);
    if (!pds) return json({ error: 'Could not resolve collection owner' }, 502);

    const [collectionRecord, snapshot] = await Promise.all([
      getRecordPublic(pds, ref.did, ref.collection, ref.rkey),
      snapshotBackedCollection(provider, ref.did, uri),
    ]);
    if (!collectionRecord) {
      return json({ error: 'Collection not found' }, 404);
    }

    // Both providers carry the display name as `name`; Semble also has `description`.
    const name = typeof collectionRecord.name === 'string' ? collectionRecord.name : undefined;
    const description =
      typeof collectionRecord.description === 'string' ? collectionRecord.description : undefined;

    const countRows = await env.DB.prepare(
      `SELECT url_normalized, COUNT(DISTINCT did) AS n,
              MAX(CASE WHEN did = ? THEN 1 ELSE 0 END) AS mine
         FROM room_reads WHERE collection_uri = ? GROUP BY url_normalized`
    )
      .bind(session.did, uri)
      .all<{ url_normalized: string; n: number; mine: number }>();
    const counts = new Map(countRows.results.map((r) => [r.url_normalized, r]));

    // A collection can name the same article twice (cross-repo duplicates); the
    // room shows each URL once.
    const seen = new Set<string>();
    const items: RoomItem[] = [];
    for (const m of snapshot.members) {
      if (seen.has(m.urlNormalized)) continue;
      seen.add(m.urlNormalized);
      const row = counts.get(m.urlNormalized);
      items.push({
        url: m.url,
        urlNormalized: m.urlNormalized,
        itemType: m.itemType,
        title: m.title,
        author: m.author,
        description: m.description,
        image: m.image,
        readCount: row?.n ?? 0,
        readByMe: row?.mine === 1,
      });
    }

    return json({
      uri,
      provider,
      ownerDid: ref.did,
      name,
      description,
      complete: snapshot.complete,
      items,
    });
  } catch (error) {
    console.error('[rooms] failed to resolve room:', error);
    return json({ error: 'Failed to resolve room' }, 502);
  }
}

/**
 * Join/leave — one path, method-dispatched (mirrors /api/atmosphere/subscription):
 *   GET    /api/rooms/join?uri=<at-uri>            → { joined }
 *   POST   /api/rooms/join { collectionUri, rkey } → { joined: true, uri }
 *   DELETE /api/rooms/join { collectionUri }       → { joined: false }
 *
 * Joining writes a public readAlong record to the user's OWN repo — that record
 * is the consent boundary that licenses showing their avatar on the room page.
 * The lexicon keys on tid, so leave/status go through a list-and-match on
 * `subject` rather than a deterministic rkey.
 */
export async function handleRoomJoin(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  let collectionUri = url.searchParams.get('uri') || undefined;
  let rkey: string | undefined;
  if (request.method === 'POST' || request.method === 'DELETE') {
    try {
      const body = (await request.json()) as { collectionUri?: string; rkey?: string };
      if (typeof body.collectionUri === 'string') collectionUri = body.collectionUri;
      if (typeof body.rkey === 'string') rkey = body.rkey;
    } catch {
      // No/invalid body — fall back to the query param above.
    }
  }

  const ref = collectionUri ? parseAtUri(collectionUri) : null;
  if (!collectionUri || !ref || !providerForCollection(ref.collection)) {
    return json({ error: 'collectionUri must be a Semble or Margin collection at-uri' }, 400);
  }

  const listMine = async () => {
    const result = await createPDSClient(session).listAllRecords<ReadAlongRecord>(
      READ_ALONG_COLLECTION,
      { maxPages: 5 }
    );
    if (!result.success) return null;
    return result.data.filter((r) => r.value.subject === collectionUri);
  };

  if (request.method === 'GET') {
    const mine = await listMine();
    if (mine === null) return json({ error: 'Could not read your repo' }, 502);
    return json({ joined: mine.length > 0 });
  }

  if (request.method === 'POST') {
    if (!hasRequiredScopes(session.grantedScopes, READING_ROOM_SCOPES)) {
      return insufficientScopesResponse();
    }
    if (!rkey || !TID_RE.test(rkey)) {
      return json({ error: 'Missing or invalid rkey (client-minted TID)' }, 400);
    }
    // Idempotent: an existing join for this collection is the answer, not a dupe.
    const mine = await listMine();
    if (mine && mine.length > 0) {
      return json({ joined: true, uri: mine[0].uri });
    }
    const record: ReadAlongRecord = {
      $type: READ_ALONG_COLLECTION,
      subject: collectionUri,
      createdAt: new Date().toISOString(),
    };
    const result = await createPDSClient(session).putRecord(READ_ALONG_COLLECTION, rkey, record);
    if (!result.success) {
      if (/scope/i.test(result.error)) return insufficientScopesResponse();
      return json({ error: result.error }, result.retryable ? 503 : 502);
    }
    return json({ joined: true, uri: result.data.uri });
  }

  if (request.method === 'DELETE') {
    if (!hasRequiredScopes(session.grantedScopes, READING_ROOM_SCOPES)) {
      return insufficientScopesResponse();
    }
    const mine = await listMine();
    if (mine === null) return json({ error: 'Could not read your repo' }, 502);
    for (const rec of mine) {
      const parsed = parseAtUri(rec.uri);
      if (!parsed) continue;
      const result = await createPDSClient(session).deleteRecord(
        READ_ALONG_COLLECTION,
        parsed.rkey
      );
      if (!result.success) {
        if (/scope/i.test(result.error)) return insufficientScopesResponse();
        return json({ error: result.error }, result.retryable ? 503 : 502);
      }
    }
    return json({ joined: false });
  }

  return json({ error: 'Method not allowed' }, 405);
}

/**
 * POST /api/rooms/read — body { collectionUri, url }.
 * Idempotent: one row per (collection, article, reader).
 */
export async function handleRoomRead(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: { collectionUri?: string; url?: string };
  try {
    body = (await request.json()) as { collectionUri?: string; url?: string };
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body.collectionUri || typeof body.collectionUri !== 'string') {
    return json({ error: 'Missing collectionUri field' }, 400);
  }
  if (!body.url || typeof body.url !== 'string') {
    return json({ error: 'Missing url field' }, 400);
  }
  const ref = parseAtUri(body.collectionUri);
  if (!ref || !providerForCollection(ref.collection)) {
    return json({ error: 'Invalid collectionUri' }, 400);
  }
  const urlNormalized = normalizeArticleUrl(body.url);
  if (!urlNormalized) {
    return json({ error: 'Invalid url' }, 400);
  }

  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO room_reads (collection_uri, url_normalized, did, read_at)
       VALUES (?, ?, ?, unixepoch())`
    )
      .bind(body.collectionUri, urlNormalized, session.did)
      .run();
    return json({ ok: true });
  } catch (error) {
    console.error('[rooms] failed to record read:', error);
    return json({ error: 'Failed to record read' }, 500);
  }
}
