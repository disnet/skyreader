import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { generateTid } from '../utils/tid';

interface LabelRow {
  item_key: string;
  item_type: string;
  label: string;
  props: string | null;
  rkey: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function encodeCursor(updatedAt: number, id: number): string {
  return btoa(`${updatedAt}:${id}`);
}

function decodeCursor(cursor: string): { updatedAt: number; id: number } | null {
  try {
    const decoded = atob(cursor);
    const [updatedAtStr, idStr] = decoded.split(':');
    const updatedAt = Number(updatedAtStr);
    const id = Number(idStr);
    if (isNaN(updatedAt) || isNaN(id)) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

// GET /api/labels - Get all labels for the current user
export async function handleGetLabels(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const labelFilter = url.searchParams.get('label');
  // `?labels=a,b,c` restricts to a set of label types — used by the managed
  // sync so its delta isn't bloated with unrelated `read` rows that share this
  // table. Combinable with `label` (single), though callers use one or neither.
  const labelsFilter = (url.searchParams.get('labels') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const itemTypeFilter = url.searchParams.get('itemType');
  const cursor = url.searchParams.get('cursor');
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(Math.max(1, Number(limitParam) || DEFAULT_LIMIT), MAX_LIMIT);
  // Delta sync: `?since=<unix_seconds>` returns only rows changed since the
  // client's cursor (updated_at strictly greater). Omit it for a full fetch.
  const sinceParam = url.searchParams.get('since');
  const since = sinceParam !== null ? parseInt(sinceParam, 10) : NaN;

  try {
    let query = `SELECT id, item_key, item_type, label, props, rkey, created_at, updated_at, deleted_at
      FROM item_labels_cache
      WHERE user_did = ?`;
    const params: (string | number)[] = [session.did];

    if (labelFilter) {
      query += ' AND label = ?';
      params.push(labelFilter);
    }
    if (labelsFilter.length > 0) {
      query += ` AND label IN (${labelsFilter.map(() => '?').join(', ')})`;
      params.push(...labelsFilter);
    }
    if (itemTypeFilter) {
      query += ' AND item_type = ?';
      params.push(itemTypeFilter);
    }
    if (Number.isFinite(since)) {
      // Delta: include tombstones (deleted_at set) so the client can replay
      // deletions made on other devices. The row stays until GC purges it.
      query += ' AND updated_at > ?';
      params.push(since);
    } else {
      // Full snapshot: live rows only — a fresh client has nothing to remove.
      query += ' AND deleted_at IS NULL';
    }

    if (cursor) {
      const parsed = decodeCursor(cursor);
      if (!parsed) {
        return new Response(JSON.stringify({ error: 'Invalid cursor' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      query += ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
      params.push(parsed.updatedAt, parsed.updatedAt, parsed.id);
    }

    query += ' ORDER BY updated_at DESC, id DESC';
    query += ' LIMIT ?';
    params.push(limit + 1);

    const result = await env.DB.prepare(query)
      .bind(...params)
      .all<LabelRow & { id: number }>();

    const hasMore = result.results.length > limit;
    const rows = hasMore ? result.results.slice(0, limit) : result.results;

    const labels = rows.map((row) => ({
      itemKey: row.item_key,
      itemType: row.item_type,
      label: row.label,
      props: row.props ? JSON.parse(row.props) : {},
      rkey: row.rkey,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    }));

    const nextCursor = hasMore
      ? encodeCursor(rows[rows.length - 1].updated_at, rows[rows.length - 1].id)
      : undefined;

    return new Response(JSON.stringify({ labels, cursor: nextCursor }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to get labels:', error);
    return new Response(JSON.stringify({ error: 'Failed to get labels' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

interface AddLabelRequest {
  itemKey: string;
  itemType: string;
  label: string;
  props?: Record<string, unknown>;
}

// POST /api/labels - Add or update a label
export async function handleAddLabel(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: AddLabelRequest;
  try {
    body = (await request.json()) as AddLabelRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { itemKey, itemType, label, props } = body;

  if (!itemKey || !itemType || !label) {
    return new Response(JSON.stringify({ error: 'itemKey, itemType, and label are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rkey = generateTid();
  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB.prepare(
      `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_did, item_key, label) DO UPDATE SET
         props = excluded.props,
         updated_at = excluded.updated_at,
         deleted_at = NULL`
    )
      .bind(
        session.did,
        itemKey,
        itemType,
        label,
        props ? JSON.stringify(props) : null,
        rkey,
        now,
        now
      )
      .run();

    return new Response(JSON.stringify({ success: true, rkey }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to add label:', error);
    return new Response(JSON.stringify({ error: 'Failed to add label' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

interface DeleteLabelRequest {
  itemKey: string;
  label: string;
}

// DELETE /api/labels - Remove a label
export async function handleDeleteLabel(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: DeleteLabelRequest;
  try {
    body = (await request.json()) as DeleteLabelRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { itemKey, label } = body;

  if (!itemKey || !label) {
    return new Response(JSON.stringify({ error: 'itemKey and label are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Soft-delete (tombstone): bump updated_at and set deleted_at so the row
    // surfaces in other devices' `?since=` deltas as a removal. A later re-add
    // resurrects it (ON CONFLICT clears deleted_at); the hourly cron GCs old
    // tombstones. `read` positions are owned by the reading route and are still
    // hard-deleted there — they never reach this handler.
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'UPDATE item_labels_cache SET deleted_at = ?, updated_at = ? WHERE user_did = ? AND item_key = ? AND label = ?'
    )
      .bind(now, now, session.did, itemKey, label)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to delete label:', error);
    return new Response(JSON.stringify({ error: 'Failed to delete label' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

interface BulkAddLabelsRequest {
  labels: Array<{
    itemKey: string;
    itemType: string;
    label: string;
    props?: Record<string, unknown>;
  }>;
}

// POST /api/labels/bulk - Bulk add labels
export async function handleBulkAddLabels(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: BulkAddLabelsRequest;
  try {
    body = (await request.json()) as BulkAddLabelsRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { labels } = body;

  if (!labels || !Array.isArray(labels) || labels.length === 0) {
    return new Response(JSON.stringify({ error: 'labels array is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (labels.length > 500) {
    return new Response(JSON.stringify({ error: 'Too many labels (max 500)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const now = Math.floor(Date.now() / 1000);

  try {
    const statements = labels.map((item) => {
      const rkey = generateTid();
      return env.DB.prepare(
        `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_did, item_key, label) DO UPDATE SET
           props = excluded.props,
           updated_at = excluded.updated_at,
           deleted_at = NULL`
      ).bind(
        session.did,
        item.itemKey,
        item.itemType,
        item.label,
        item.props ? JSON.stringify(item.props) : null,
        rkey,
        now,
        now
      );
    });

    await env.DB.batch(statements);

    return new Response(JSON.stringify({ success: true, count: labels.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to bulk add labels:', error);
    return new Response(JSON.stringify({ error: 'Failed to bulk add labels' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
