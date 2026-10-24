import type { Env, Session } from '../types';
import { isValidRkey } from '../utils/validation';
import {
  backfillSavedUrlKeys,
  listSavedConnectionActivity,
  markSavedConnectionsSeen,
  SEMBLE_CONNECTION_COLLECTION,
} from '../services/semble-connections';
import { createPDSClient } from '../services/pds-client';
import { grantsScopes } from '../services/scope-check';
import { LIKE_SCOPES } from '../config/scopes';
import { insufficientScopesResponse } from './auth';
import { resolvePdsUrl } from '../utils/did-resolver';
import { getRecordPublicWithCid } from '../services/backing/read';
import { generateTid } from '../utils/tid';
import { log } from '../utils/logger';

/** Lexicon Community's shared like: a strongRef to any record. */
export const LIKE_COLLECTION = 'community.lexicon.interaction.like';

/**
 * Semble connections other people drew off the reader's saves
 * (services/semble-connections.ts, docs/plans/SEMBLE_CONNECTIONS.md).
 *
 *   GET  /api/saved/connections       — per-save activity: { items: [{ rkey, unseen, latestAt, seenAt, newest }] },
 *                                       `newest` describing a few of the unseen edges
 *   POST /api/saved/connections/seen  — { rkey }: the reader looked at that save's connections
 *   POST   /api/saved/connections/like — { uri }: like that connection → { liked: true }
 *   DELETE /api/saved/connections/like — { uri }: take the like back → { liked: false }
 *
 * A like is a community.lexicon.interaction.like in the reader's own repo whose
 * subject is a strongRef to the network.cosmik.connection, so any app reading
 * that shared lexicon sees it. `connection_likes` is the index ("have I liked
 * this?") and holds the rkey an unlike deletes. As with recommends, the row is
 * claimed before the PDS write so two taps racing mint one record.
 *
 * Small and whole: only saves with a connection appear, so the client fetches
 * the list rather than paging a delta.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function handleSavedConnections(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const userDid = session.did;

  if (path === '/api/saved/connections') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    // Older saves get their url_key here, a batch per call, the first times the
    // reader opens their Library; until then no connection can match them.
    await backfillSavedUrlKeys(env, userDid);
    const items = await listSavedConnectionActivity(env, userDid);
    return json({ items });
  }

  if (path === '/api/saved/connections/seen') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let body: { rkey?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const rkey = typeof body?.rkey === 'string' ? body.rkey : '';
    if (!isValidRkey(rkey)) return json({ error: 'Invalid rkey' }, 400);
    const marked = await markSavedConnectionsSeen(env, userDid, rkey);
    return json({ success: marked });
  }

  if (path === '/api/saved/connections/like') {
    if (request.method !== 'POST' && request.method !== 'DELETE') {
      return json({ error: 'Method not allowed' }, 405);
    }
    return handleLike(request, env, session);
  }

  return json({ error: 'Not found' }, 404);
}

async function handleLike(request: Request, env: Env, session: Session): Promise<Response> {
  if (!grantsScopes(session.grantedScopes, LIKE_SCOPES)) return insufficientScopesResponse();

  let body: { uri?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const uri = typeof body?.uri === 'string' ? body.uri : '';
  if (!uri.startsWith('at://')) return json({ error: 'Invalid uri' }, 400);

  const pds = createPDSClient(session);

  if (request.method === 'DELETE') {
    const row = await env.DB.prepare(
      'SELECT rkey FROM connection_likes WHERE user_did = ? AND subject_uri = ?'
    )
      .bind(session.did, uri)
      .first<{ rkey: string }>();
    if (!row) return json({ liked: false });
    const result = await pds.deleteRecord(LIKE_COLLECTION, row.rkey);
    if (!result.success) {
      if (/scope/i.test(result.error)) return insufficientScopesResponse();
      log.error('connection_unlike_failed', { pdsUrl: session.pdsUrl, error: result.error });
      return json({ error: result.error }, result.retryable ? 503 : 502);
    }
    await env.DB.prepare('DELETE FROM connection_likes WHERE user_did = ? AND rkey = ?')
      .bind(session.did, row.rkey)
      .run();
    return json({ liked: false });
  }

  // Only connections the poller kept, so the CID lookup below only ever asks a
  // curator the firehose named, never anyone a request does.
  const connection = await env.DB.prepare(
    'SELECT curator_did, cid FROM semble_connections WHERE uri = ?'
  )
    .bind(uri)
    .first<{ curator_did: string; cid: string | null }>();
  if (!connection) return json({ error: 'Connection not found' }, 404);

  // Looked up before the claim, so a slow curator PDS can't strand a row.
  let cid = connection.cid;
  if (!cid) {
    try {
      cid = await fetchConnectionCid(env, connection.curator_did, uri);
    } catch (e) {
      log.warn('connection_cid_lookup_failed', { uri, error: String(e) });
      return json({ error: 'Could not reach the connection’s server' }, 503);
    }
    if (!cid) return json({ error: 'Connection not found' }, 404);
  }

  const rkey = generateTid();
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO connection_likes (user_did, subject_uri, rkey, created_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(session.did, uri, rkey, Date.now())
    .run();
  if (!claim.meta.changes) return json({ liked: true });

  const release = () =>
    env.DB.prepare('DELETE FROM connection_likes WHERE user_did = ? AND rkey = ?')
      .bind(session.did, rkey)
      .run();

  const result = await pds.putRecord(LIKE_COLLECTION, rkey, {
    $type: LIKE_COLLECTION,
    subject: { uri, cid },
    createdAt: new Date().toISOString(),
  });
  if (!result.success) {
    // Release the claim so a retry can write; it never reached the repo.
    await release();
    if (/scope/i.test(result.error)) return insufficientScopesResponse();
    log.error('connection_like_failed', { pdsUrl: session.pdsUrl, error: result.error });
    return json({ error: result.error }, result.retryable ? 503 : 502);
  }
  return json({ liked: true }, 201);
}

/**
 * The connection's current CID, from the curator's PDS, for rows the poller
 * indexed before it kept CIDs. Kept on the row once found. Null when the record
 * is gone; throws when the curator's PDS can't be found or reached.
 */
async function fetchConnectionCid(
  env: Env,
  curatorDid: string,
  uri: string
): Promise<string | null> {
  const rkey = uri.split('/').pop() ?? '';
  if (!rkey) return null;
  const pdsUrl = await resolvePdsUrl(curatorDid);
  if (!pdsUrl) throw new Error(`no PDS for ${curatorDid}`);
  const record = await getRecordPublicWithCid(
    pdsUrl,
    curatorDid,
    SEMBLE_CONNECTION_COLLECTION,
    rkey
  );
  if (!record?.cid) return null;
  await env.DB.prepare('UPDATE semble_connections SET cid = ? WHERE uri = ?')
    .bind(record.cid, uri)
    .run();
  return record.cid;
}
