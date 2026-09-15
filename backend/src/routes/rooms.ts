/**
 * Reading Rooms spike — a public reading room IS a Semble/Margin collection.
 * See docs/plans/READING_ROOMS_SPIKE.md.
 *
 * The room's identity is the collection at-uri; membership (readAlong records)
 * is aggregated client-side via Constellation, so the backend's whole surface is:
 *  - GET  /api/rooms?uri=…   — resolve the collection into its article list
 *    (reuses the auth-free backing read path) plus per-article read counts.
 *  - POST /api/rooms         — start a room: create a collection in the caller's
 *    own repo and join it.
 *  - POST /api/rooms/read    — count a read made through the room surface.
 *  - POST /api/rooms/items   — add an article to the room's collection.
 *
 * Reads are counted ONLY through the room surface, never joined against existing
 * read state (joining must not retroactively disclose reading history). Counts
 * are aggregate and anonymous; per-user rows never leave D1.
 */

import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import {
  snapshotBackedCollection,
  getRecordPublicWithCid,
  type BackingProviderName,
} from '../services/backing/read';
import { createCollection, createMember, type SembleAccessType } from '../services/backing/write';
import { createPDSClient } from '../services/pds-client';
import { FeedProxyClient } from '../services/feed-proxy-client';
import { hasRequiredScopes, insufficientScopesResponse } from './auth';
import { MARGIN_SCOPES, READING_ROOM_SCOPES, SEMBLE_SCOPES } from '../config/scopes';
import { parseAtUri } from '../utils/canonical-url';
import { resolvePdsUrl } from '../utils/did-resolver';
import { normalizeArticleUrl } from '../utils/url-normalize';
import { generateTid } from '../utils/tid';

export const READ_ALONG_COLLECTION = 'app.skyreader.reading.readAlong';

// Client-minted TID, same shape the e2e seeds validate subscription rkeys against.
const TID_RE = /^[a-z0-9]{13,16}$/;

interface ReadAlongRecord {
  $type: string;
  subject: string;
  createdAt: string;
}

/** A trimmed non-empty string, or undefined — blank and absent are the same thing
 *  everywhere in this file. */
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

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
  /** when this article joined the collection (ISO), off its membership record */
  addedAt?: string;
  readCount: number;
  readByMe: boolean;
}

interface ResolvedCollection {
  ref: { did: string; collection: string; rkey: string };
  provider: BackingProviderName;
  record: Record<string, unknown>;
  cid: string;
}

/** Fetch the room's collection record from its owner's PDS (auth-free), or a
 *  Response describing why it can't be a room. */
async function resolveCollection(uri: string): Promise<ResolvedCollection | Response> {
  const ref = parseAtUri(uri);
  if (!ref) return json({ error: 'Invalid at-uri' }, 400);
  const provider = providerForCollection(ref.collection);
  if (!provider) return json({ error: `Unsupported collection type: ${ref.collection}` }, 400);
  const pds = await resolvePdsUrl(ref.did);
  if (!pds) return json({ error: 'Could not resolve collection owner' }, 502);
  const record = await getRecordPublicWithCid(pds, ref.did, ref.collection, ref.rkey);
  if (!record) return json({ error: 'Collection not found' }, 404);
  return { ref, provider, record: record.value, cid: record.cid };
}

/**
 * May this user add articles to the room?
 *
 * The rule is the collection's own, not ours: Semble's `accessType` is documented
 * as OPEN (anyone) / CLOSED (owner plus listed `collaborators`), so an open
 * collection is a room anyone can co-curate and a closed one is curator-led.
 * `at.margin.collection` carries no access field at all, so a Margin room is
 * owner-only — a stricter default is the right way to read a missing permission.
 */
function canAddTo(c: ResolvedCollection, did: string): boolean {
  if (c.ref.did === did) return true;
  if (c.provider !== 'semble') return false;
  const access = typeof c.record.accessType === 'string' ? c.record.accessType.toUpperCase() : '';
  if (access === 'OPEN') return true;
  const collaborators = Array.isArray(c.record.collaborators) ? c.record.collaborators : [];
  return collaborators.includes(did);
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

  try {
    const collection = await resolveCollection(uri);
    if (collection instanceof Response) return collection;
    const { ref, provider, record: collectionRecord } = collection;

    // includeForeign: a room's list is what everyone has added, and a contributor
    // can only write membership into their OWN repo — so the owner's repo alone
    // would hide (from everyone, the contributor included) every article added by
    // someone else. Backed saves deliberately don't ask for this.
    const snapshot = await snapshotBackedCollection(provider, ref.did, uri, {
      includeForeign: true,
    });

    // Both providers carry the display name as `name` and an optional
    // `description`. Blank is the same as absent here — a whitespace-only field
    // would otherwise render an empty line.
    const name = str(collectionRecord.name);
    const description = str(collectionRecord.description);

    const countRows = await env.DB.prepare(
      `SELECT url_normalized, COUNT(DISTINCT did) AS n,
              MAX(CASE WHEN did = ? THEN 1 ELSE 0 END) AS mine
         FROM room_reads WHERE collection_uri = ? GROUP BY url_normalized`
    )
      .bind(session.did, uri)
      .all<{ url_normalized: string; n: number; mine: number }>();
    const counts = new Map(countRows.results.map((r) => [r.url_normalized, r]));

    // A collection can name the same article twice (cross-repo duplicates); the
    // room shows each URL once. The snapshot comes back oldest-addition-first, so
    // first-seen is the earliest add — the room's order is the order it was built
    // in, and a re-add doesn't move an article to the end of the list.
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
        addedAt: m.addedAt,
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
      canAdd: canAddTo(collection, session.did),
      complete: snapshot.complete,
      items,
    });
  } catch (error) {
    console.error('[rooms] failed to resolve room:', error);
    return json({ error: 'Failed to resolve room' }, 502);
  }
}

/** Caps on what a room is called. Semble's lexicon sets no limit we know of;
 *  these keep a room row readable. */
export const ROOM_NAME_MAX = 120;
export const ROOM_DESCRIPTION_MAX = 500;

/**
 * POST /api/rooms — body { name, description?, provider?, access? }.
 * Starts a room: creates a collection in the caller's OWN repo, then joins it.
 *
 * The room is the collection, so this is the same record backed saves create,
 * with the room's own settings on it. `provider` defaults to Semble, the only
 * one whose collections carry an access rule: `access` "open" (anyone may add)
 * or "closed" (owner and collaborators; the default) sets Semble's
 * `accessType`. A Margin collection has no access field, so a Margin room is
 * owner-only whatever was asked, and it takes no description either — the
 * shape we write there is only what we've seen Margin itself write.
 *
 * Both scope sets are checked BEFORE anything is written, so a session that
 * lacks one comes back with nothing created rather than a collection it can't
 * join. The join is the creator's readAlong record, minted here (the client
 * has nothing to reconcile it against); if it fails after the collection
 * exists, the room is still returned with `joined: false` and the room page
 * offers Join as usual.
 */
export async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  let body: { name?: unknown; description?: unknown; provider?: unknown; access?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const providerRaw = body.provider ?? 'semble';
  if (providerRaw !== 'semble' && providerRaw !== 'margin') {
    return json({ error: 'provider must be "semble" or "margin"' }, 400);
  }
  const provider: BackingProviderName = providerRaw;

  const name = str(body.name);
  if (!name) return json({ error: 'Missing name field' }, 400);
  if (name.length > ROOM_NAME_MAX) {
    return json({ error: `name must be at most ${ROOM_NAME_MAX} characters` }, 400);
  }
  const description = str(body.description);
  if (description && description.length > ROOM_DESCRIPTION_MAX) {
    return json({ error: `description must be at most ${ROOM_DESCRIPTION_MAX} characters` }, 400);
  }
  let accessType: SembleAccessType = 'CLOSED';
  if (body.access !== undefined) {
    if (body.access === 'open') accessType = 'OPEN';
    else if (body.access === 'closed') accessType = 'CLOSED';
    else return json({ error: 'access must be "open" or "closed"' }, 400);
  }

  const providerScopes = provider === 'semble' ? SEMBLE_SCOPES : MARGIN_SCOPES;
  if (
    !hasRequiredScopes(session.grantedScopes, providerScopes) ||
    !hasRequiredScopes(session.grantedScopes, READING_ROOM_SCOPES)
  ) {
    return insufficientScopesResponse();
  }

  const pds = createPDSClient(session);
  let uri: string;
  try {
    const created = await createCollection(
      pds,
      provider,
      name,
      provider === 'semble' ? { accessType, description } : {}
    );
    uri = created.uri;
  } catch (error) {
    console.error('[rooms] failed to create room collection:', error);
    const message = error instanceof Error ? error.message : '';
    if (/scope/i.test(message)) return insufficientScopesResponse();
    return json({ error: 'Failed to create the room' }, 502);
  }

  const record: ReadAlongRecord = {
    $type: READ_ALONG_COLLECTION,
    subject: uri,
    createdAt: new Date().toISOString(),
  };
  const join = await pds.putRecord(READ_ALONG_COLLECTION, generateTid(), record);
  if (!join.success) {
    console.error('[rooms] created room but could not join it:', join.error);
  }

  return json(
    {
      uri,
      provider,
      name,
      description: provider === 'semble' ? description : undefined,
      access: provider === 'semble' ? (accessType === 'OPEN' ? 'open' : 'closed') : 'closed',
      joined: join.success,
    },
    201
  );
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

/**
 * POST /api/rooms/items — body { collectionUri, url, title?, description?,
 * author?, publishedAt? }. Adds an article to the room's collection.
 *
 * The membership record goes in the CALLER's repo (the only repo we can write),
 * which is exactly how an open collection is co-curated. Whether that is allowed
 * is the collection's own rule — see canAddTo — and it is enforced here rather
 * than left to the UI, since the endpoint is reachable without it.
 *
 * Metadata is optional because the two ways to add differ: an article picked out
 * of the reader's own library arrives with a title already, a pasted URL doesn't
 * and is extracted here (best effort — a title is worth one proxy round trip,
 * but a blocked page is still worth adding).
 */
export async function handleRoomAddItem(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: {
    collectionUri?: string;
    url?: string;
    title?: string;
    description?: string;
    author?: string;
    publishedAt?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body.collectionUri || typeof body.collectionUri !== 'string') {
    return json({ error: 'Missing collectionUri field' }, 400);
  }
  const rawUrl = str(body.url);
  if (!rawUrl) return json({ error: 'Missing url field' }, 400);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return json({ error: 'Invalid url' }, 400);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return json({ error: 'Only http(s) links can be added' }, 400);
  }
  const urlNormalized = normalizeArticleUrl(rawUrl);
  if (!urlNormalized) return json({ error: 'Invalid url' }, 400);

  try {
    const collection = await resolveCollection(body.collectionUri);
    if (collection instanceof Response) return collection;
    if (!canAddTo(collection, session.did)) {
      return json({ error: 'This room is not open for additions' }, 403);
    }

    const scopes = collection.provider === 'semble' ? SEMBLE_SCOPES : MARGIN_SCOPES;
    if (!hasRequiredScopes(session.grantedScopes, scopes)) {
      return insufficientScopesResponse();
    }

    let title = str(body.title);
    let description = str(body.description);
    let author = str(body.author);
    let publishedAt = str(body.publishedAt);
    let image: string | undefined;
    if (!title) {
      try {
        const extracted = await new FeedProxyClient(env).extract(rawUrl);
        title = str(extracted.title);
        description ??= str(extracted.description);
        author ??= str(extracted.author);
        publishedAt ??= str(extracted.published);
        image = str(extracted.image);
      } catch (error) {
        // A paywall, a 403, a page that isn't an article: the link is still worth
        // adding, it just shows as its URL until someone gives it a title.
        console.warn('[rooms] could not extract metadata for added url:', error);
      }
    }

    const handles = await createMember(
      createPDSClient(session),
      session.did,
      collection.provider,
      body.collectionUri,
      { url: rawUrl, title, description, author, publishedAt },
      { collectionCid: collection.cid }
    );

    // The room's own read counts are per-URL, so an article someone already read
    // here keeps its count when it's (re-)added.
    const row = await env.DB.prepare(
      `SELECT COUNT(DISTINCT did) AS n,
              MAX(CASE WHEN did = ? THEN 1 ELSE 0 END) AS mine
         FROM room_reads WHERE collection_uri = ? AND url_normalized = ?`
    )
      .bind(session.did, body.collectionUri, urlNormalized)
      .first<{ n: number; mine: number }>();

    const item: RoomItem = {
      url: rawUrl,
      urlNormalized,
      itemType: collection.provider === 'semble' ? 'network.cosmik.card' : 'at.margin.note',
      title,
      author,
      description,
      image,
      // The membership record was stamped a moment ago; saying so here keeps the
      // optimistically-rendered row sorting where a reload will put it.
      addedAt: new Date().toISOString(),
      readCount: row?.n ?? 0,
      readByMe: row?.mine === 1,
    };
    return json({ item, itemUri: handles.itemUri, linkUri: handles.linkUri });
  } catch (error) {
    console.error('[rooms] failed to add item:', error);
    const message = error instanceof Error ? error.message : 'Failed to add the article';
    if (/scope/i.test(message)) return insufficientScopesResponse();
    return json({ error: 'Failed to add the article' }, 502);
  }
}
