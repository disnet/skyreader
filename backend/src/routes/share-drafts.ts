import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';

// Cross-device linkblog share drafts. A draft is the unposted state of a share,
// keyed by the external article URL — the same key the linkblog dedups on. The
// body is an opaque JSON blob (blocks + article metadata + repostUri/itemKey)
// the backend never interprets, exactly like magazines' params/items. D1 only:
// drafts are private to the account and never become a PDS record; they go
// public only when the user posts, through the linkblog write path.
//
// Sync is delta-based like magazines: `?since=` returns rows changed at or
// after the client's cursor, tombstones included so deletions replay to other
// devices. The inclusive boundary is deliberate: updated_at has second
// precision, so a mutation can land in the same second after a client has
// checkpointed it. Clients merge the replayed boundary rows idempotently.
//
// Two clocks. `updated_at` is the server clock (unix seconds) and drives the
// delta cursor. `client_updated_at` is the client's ms clock and drives
// last-write-wins: unlike magazines (which upsert unconditionally) a draft is
// keystroke-level content, so an offline-queued write from a stale device must
// not clobber a newer edit made elsewhere.

interface ShareDraftRow {
  id: number;
  article_url: string;
  draft: string;
  client_updated_at: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
// A draft is prose plus a little article metadata; 64 KB is far more than any
// real one and keeps a runaway client from bloating rows.
const MAX_DRAFT_BYTES = 64 * 1024;
const MAX_ARTICLE_URL_LENGTH = 2048;

function encodeCursor(updatedAt: number, id: number): string {
  return btoa(`${updatedAt}:${id}`);
}

function decodeCursor(cursor: string): { updatedAt: number; id: number } | null {
  try {
    const [updatedAtStr, idStr] = atob(cursor).split(':');
    const updatedAt = Number(updatedAtStr);
    const id = Number(idStr);
    if (isNaN(updatedAt) || isNaN(id)) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rowToDraft(row: ShareDraftRow) {
  // A tombstone carries no body — the client only needs to know which draft
  // died and when, and shipping the last words of a deleted draft back out
  // would defeat the point of deleting it.
  const deleted = row.deleted_at !== null;
  return {
    articleUrl: row.article_url,
    draft: deleted ? null : JSON.parse(row.draft),
    clientUpdatedAt: row.client_updated_at,
    createdAt: row.created_at,
    serverUpdatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

// GET /api/linkblog/drafts - list drafts (full snapshot, or `?since=` delta)
export async function handleGetShareDrafts(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return unauthorized();

  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(Math.max(1, Number(limitParam) || DEFAULT_LIMIT), MAX_LIMIT);
  const sinceParam = url.searchParams.get('since');
  const since = sinceParam !== null ? parseInt(sinceParam, 10) : NaN;

  try {
    let query = `SELECT id, article_url, draft, client_updated_at, created_at, updated_at, deleted_at
      FROM share_drafts
      WHERE user_did = ?`;
    const params: (string | number)[] = [session.did];

    if (Number.isFinite(since)) {
      // Overlap the checkpoint second. A strict `>` can permanently miss a row
      // written later in the same second as the last sync. Pagination remains
      // collision-safe through the (updated_at, id) page cursor below.
      query += ' AND updated_at >= ?';
      params.push(since);
    } else {
      query += ' AND deleted_at IS NULL';
    }

    if (cursor) {
      const parsed = decodeCursor(cursor);
      if (!parsed) return json({ error: 'Invalid cursor' }, 400);
      query += ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
      params.push(parsed.updatedAt, parsed.updatedAt, parsed.id);
    }

    query += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
    params.push(limit + 1);

    const result = await env.DB.prepare(query)
      .bind(...params)
      .all<ShareDraftRow>();

    const hasMore = result.results.length > limit;
    const rows = hasMore ? result.results.slice(0, limit) : result.results;
    const drafts = rows.map(rowToDraft);
    const nextCursor = hasMore
      ? encodeCursor(rows[rows.length - 1].updated_at, rows[rows.length - 1].id)
      : undefined;

    return json({ drafts, cursor: nextCursor });
  } catch (error) {
    console.error('Failed to get share drafts:', error);
    return json({ error: 'Failed to get share drafts' }, 500);
  }
}

interface UpsertShareDraftRequest {
  articleUrl: string;
  draft: unknown;
  updatedAt: number;
}

// PUT /api/linkblog/drafts - create or replace a draft (last write wins)
export async function handleUpsertShareDraft(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return unauthorized();

  let body: UpsertShareDraftRequest;
  try {
    body = (await request.json()) as UpsertShareDraftRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { articleUrl, draft, updatedAt } = body;
  if (!articleUrl || typeof articleUrl !== 'string' || articleUrl.length > MAX_ARTICLE_URL_LENGTH) {
    return json({ error: 'articleUrl is required' }, 400);
  }
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
    return json({ error: 'draft must be an object' }, 400);
  }
  const clientUpdatedAt = Number(updatedAt);
  if (!Number.isFinite(clientUpdatedAt)) {
    return json({ error: 'updatedAt must be a number' }, 400);
  }

  const serialized = JSON.stringify(draft);
  if (new TextEncoder().encode(serialized).length > MAX_DRAFT_BYTES) {
    return json({ error: 'Draft too large' }, 413);
  }

  const now = Math.floor(Date.now() / 1000);

  try {
    // The guard is what makes an offline queue safe: a write carrying an older
    // client clock than the row already here is dropped rather than applied.
    // That still answers success — the newer content is already stored, and the
    // client's next delta hands it back.
    await env.DB.prepare(
      `INSERT INTO share_drafts (user_did, article_url, draft, client_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_did, article_url) DO UPDATE SET
         draft = excluded.draft,
         client_updated_at = excluded.client_updated_at,
         updated_at = excluded.updated_at,
         deleted_at = NULL
       WHERE excluded.client_updated_at >= share_drafts.client_updated_at`
    )
      .bind(session.did, articleUrl, serialized, clientUpdatedAt, now, now)
      .run();

    return json({ success: true, articleUrl });
  } catch (error) {
    console.error('Failed to upsert share draft:', error);
    return json({ error: 'Failed to upsert share draft' }, 500);
  }
}

interface DeleteShareDraftRequest {
  articleUrl: string;
  updatedAt?: number;
}

// DELETE /api/linkblog/drafts - soft-delete (tombstone) a draft. Posting or
// discarding a draft on one device clears it on the others through this.
export async function handleDeleteShareDraft(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return unauthorized();

  let body: DeleteShareDraftRequest;
  try {
    body = (await request.json()) as DeleteShareDraftRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.articleUrl || typeof body.articleUrl !== 'string') {
    return json({ error: 'articleUrl is required' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const clientUpdatedAt = Number.isFinite(Number(body.updatedAt))
    ? Number(body.updatedAt)
    : now * 1000;

  try {
    // Stamping client_updated_at with the deletion's client ms puts the delete
    // on the same LWW clock as edits, and the guard makes the rule symmetric
    // with upsert: a delete queued offline before an edit made elsewhere does
    // not destroy that newer edit. Losing a delete race just means the draft
    // comes back and the user discards it again; losing an edit race would mean
    // losing their words.
    //
    // The body is cleared, not just hidden: a discarded draft's text should not
    // sit in the tombstone for the 90 days before the cron sweeps it.
    await env.DB.prepare(
      `UPDATE share_drafts
       SET deleted_at = ?, updated_at = ?, client_updated_at = ?, draft = '{}'
       WHERE user_did = ? AND article_url = ? AND ? >= client_updated_at`
    )
      .bind(now, now, clientUpdatedAt, session.did, body.articleUrl, clientUpdatedAt)
      .run();
    // Deleting a draft that was never pushed (or is already gone) is a no-op,
    // not an error — the client's intent is satisfied either way.
    return json({ success: true });
  } catch (error) {
    console.error('Failed to delete share draft:', error);
    return json({ error: 'Failed to delete share draft' }, 500);
  }
}
