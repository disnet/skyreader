import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { generateTid } from '../utils/tid';
import {
  afterCursorParams,
  afterCursorSql,
  clampClientUpdatedAt,
  decodeDeltaCursor,
  encodeDeltaCursor,
  maxCursor,
  parseSince,
  type DeltaCursor,
} from '../utils/delta-cursor';

interface LabelRow {
  item_key: string;
  item_type: string;
  label: string;
  props: string | null;
  rkey: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  client_updated_at: number | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

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
  // Delta sync: `?since=` returns only rows changed since the client's cursor.
  // The cursor is compound — base64 `updatedAt:id` — so strictly-greater is
  // lossless across same-second rows; a bare unix-seconds value from the
  // previous release is still accepted (see parseSince). Omit for a full fetch.
  const since = parseSince(url.searchParams.get('since'));
  const isDelta = since !== null;

  try {
    let query = `SELECT id, item_key, item_type, label, props, rkey, created_at, updated_at, deleted_at, client_updated_at
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
    let parsedCursor: DeltaCursor | null = null;
    if (cursor) {
      parsedCursor = decodeDeltaCursor(cursor);
      if (!parsedCursor) {
        return new Response(JSON.stringify({ error: 'Invalid cursor' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (isDelta) {
      // Delta: include tombstones (deleted_at set) so the client can replay
      // deletions made on other devices. The row stays until GC purges it.
      //
      // Ordered ASCENDING, unlike the full snapshot: a delta is drained forward
      // from the client's cursor, so pages must be contiguous and the last row
      // of the last page is the new cursor. Pagination therefore uses the SAME
      // compound bound as `since` — whichever is larger — rather than a second,
      // opposite-direction predicate.
      const lower = maxCursor(since, parsedCursor)!;
      query += ` AND ${afterCursorSql()}`;
      params.push(...afterCursorParams(lower));
      query += ' ORDER BY updated_at ASC, id ASC';
    } else {
      // Full snapshot: live rows only — a fresh client has nothing to remove.
      query += ' AND deleted_at IS NULL';
      if (parsedCursor) {
        query += ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
        params.push(parsedCursor.updatedAt, parsedCursor.updatedAt, parsedCursor.id);
      }
      query += ' ORDER BY updated_at DESC, id DESC';
    }
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
      // The user's own action time (unix ms). The client compares it against
      // its local label before applying a remote row, so a late-arriving old
      // write can't overwrite a newer local one.
      clientUpdatedAt: row.client_updated_at,
    }));

    const last = rows[rows.length - 1];
    const nextCursor = hasMore && last ? encodeDeltaCursor(last.updated_at, last.id) : undefined;

    // The delta cursor to persist: the last row DELIVERED, or the caller's own
    // cursor when the page was empty. Never a clock reading — a cursor that
    // moved past rows the client didn't receive is exactly the silent loss this
    // endpoint is meant to be free of. Only meaningful in delta mode.
    const nextSince = isDelta
      ? last
        ? encodeDeltaCursor(last.updated_at, last.id)
        : encodeDeltaCursor(since.updatedAt, since.id)
      : undefined;

    return new Response(JSON.stringify({ labels, cursor: nextCursor, nextSince, hasMore }), {
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
  // When the USER made this change, unix ms. Optional: an older client omits it
  // and gets server-now, i.e. today's arrival-ordered behaviour.
  updatedAt?: number;
  // 'replace' (default) writes props as the authoritative set for this item.
  // 'merge' unions the incoming highlights into whatever is already stored.
  // See MERGE_HIGHLIGHTS_CONFLICT for when a client should ask for it.
  mode?: 'replace' | 'merge';
}

/**
 * The conflict clause every label write shares.
 *
 * `WHERE excluded.client_updated_at >= client_updated_at` is what makes the
 * winner the later USER action rather than the later HTTP request: a queue
 * draining an hour after the fact no longer overwrites what the user did on
 * another device in the meantime. `>=` (not `>`) so an idempotent retry of the
 * same write still lands.
 *
 * COALESCE covers a row an older Worker inserted mid-deploy with no value.
 */
const LABEL_UPSERT_CONFLICT = `ON CONFLICT(user_did, item_key, label) DO UPDATE SET
         props = excluded.props,
         updated_at = excluded.updated_at,
         client_updated_at = excluded.client_updated_at,
         deleted_at = NULL
       WHERE excluded.client_updated_at >= COALESCE(item_labels_cache.client_updated_at, 0)`;

/**
 * Union-by-id upsert for the `highlights` label.
 *
 * `LABEL_UPSERT_CONFLICT` treats props as one authoritative value, which is
 * right for a single reader's own timeline: a stale queue must not undo newer
 * work, and rewriting the array without a highlight is how removing one
 * propagates. It is wrong for merging two DISJOINT bodies of work, which is
 * what signing in from guest mode does. Under replace semantics, an article
 * highlighted both as a guest and in the account loses one side's highlights
 * wholesale: the later `client_updated_at` wins the entire array.
 *
 * A merge write is additive, so it carries neither hazard and needs neither
 * guard:
 *   - it always lands (refusing it on staleness IS the bug, and it can destroy
 *     nothing), while `client_updated_at` keeps the greater of the two so a
 *     later replace still wins normally;
 *   - on an id present in both sides the incoming one wins, matching the
 *     client's own inbound union;
 *   - a tombstoned row contributes nothing (`deleted_at IS NULL`), so merging
 *     never resurrects highlights the reader deleted.
 *
 * `updated_at` still advances, so the forward delta re-delivers the merged row
 * to every other device.
 */
const MERGE_HIGHLIGHTS_CONFLICT = `ON CONFLICT(user_did, item_key, label) DO UPDATE SET
         props = json_object('highlights', (
           SELECT json_group_array(json(value)) FROM (
             SELECT value FROM json_each(json_extract(excluded.props, '$.highlights'))
             UNION ALL
             SELECT value FROM json_each(json_extract(item_labels_cache.props, '$.highlights'))
              WHERE item_labels_cache.deleted_at IS NULL
                AND json_extract(value, '$.id') NOT IN (
                  SELECT json_extract(value, '$.id')
                    FROM json_each(json_extract(excluded.props, '$.highlights')))
           )
         )),
         updated_at = excluded.updated_at,
         client_updated_at = MAX(
           excluded.client_updated_at,
           COALESCE(item_labels_cache.client_updated_at, 0)
         ),
         deleted_at = NULL`;

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

  // Merge is defined only for `highlights`, whose props are an array of
  // id-bearing objects. Refuse rather than quietly replacing: a client asking
  // to merge something else has a bug, and silently doing the destructive
  // thing instead is how it would stay hidden.
  const merge = body.mode === 'merge';
  if (merge && label !== 'highlights') {
    return new Response(JSON.stringify({ error: "mode 'merge' is only valid for 'highlights'" }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (merge && !Array.isArray((props as { highlights?: unknown } | undefined)?.highlights)) {
    return new Response(
      JSON.stringify({ error: "mode 'merge' requires props.highlights to be an array" }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const rkey = generateTid();
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const clientUpdatedAt = clampClientUpdatedAt(body.updatedAt, nowMs);

  try {
    await env.DB.prepare(
      `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ${merge ? MERGE_HIGHLIGHTS_CONFLICT : LABEL_UPSERT_CONFLICT}`
    )
      .bind(
        session.did,
        itemKey,
        itemType,
        label,
        props ? JSON.stringify(props) : null,
        rkey,
        now,
        now,
        clientUpdatedAt
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
  updatedAt?: number;
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
    //
    // Guarded by the same user-time comparison as the upsert, so a late-draining
    // queue can't resurrect stale intent in EITHER direction: removing a label
    // is as much a user action as adding one.
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    const clientUpdatedAt = clampClientUpdatedAt(body.updatedAt, nowMs);
    await env.DB.prepare(
      `UPDATE item_labels_cache SET deleted_at = ?, updated_at = ?, client_updated_at = ?
        WHERE user_did = ? AND item_key = ? AND label = ?
          AND ? >= COALESCE(client_updated_at, 0)`
    )
      .bind(now, now, clientUpdatedAt, session.did, itemKey, label, clientUpdatedAt)
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
    updatedAt?: number;
  }>;
  // Per-request fallback for callers whose items share one intent time.
  updatedAt?: number;
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

  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);

  try {
    const statements = labels.map((item) => {
      const rkey = generateTid();
      const clientUpdatedAt = clampClientUpdatedAt(item.updatedAt ?? body.updatedAt, nowMs);
      return env.DB.prepare(
        `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ${LABEL_UPSERT_CONFLICT}`
      ).bind(
        session.did,
        item.itemKey,
        item.itemType,
        item.label,
        item.props ? JSON.stringify(item.props) : null,
        rkey,
        now,
        now,
        clientUpdatedAt
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
