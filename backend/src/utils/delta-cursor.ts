/**
 * The compound `(updated_at, id)` cursor shared by the two label deltas
 * (`GET /api/labels`, `GET /api/reading/positions`).
 *
 * `updated_at` has one-second resolution, so a cursor that is only a timestamp
 * cannot express "everything after this row". Both deltas used
 * `updated_at > since`, which silently drops every row written in the same
 * wall-clock second as the cursor's max — a real loss, because the client then
 * never asks for those rows again. Pairing the timestamp with the row's `id`
 * makes strictly-greater safe: same-second rows still differ by id.
 *
 * The wire form is the base64 `updatedAt:id` encoding the label pagination
 * cursor already used, so one decoder covers both.
 */
export interface DeltaCursor {
  updatedAt: number;
  id: number;
}

export function encodeDeltaCursor(updatedAt: number, id: number): string {
  return btoa(`${updatedAt}:${id}`);
}

export function decodeDeltaCursor(cursor: string): DeltaCursor | null {
  try {
    const [updatedAtStr, idStr] = atob(cursor).split(':');
    const updatedAt = Number(updatedAtStr);
    const id = Number(idStr);
    if (!Number.isFinite(updatedAt) || !Number.isFinite(id)) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

/**
 * Parse a `?since=` value that may be either form.
 *
 * A client on the previous release sends unix seconds; it is read as
 * `(since, 0)`, which re-delivers that second's rows exactly once. Harmless —
 * application is an idempotent upsert — and it is what lets the backend deploy
 * ahead of the frontend, as this repo always does.
 */
export function parseSince(raw: string | null): DeltaCursor | null {
  if (raw === null || raw === '') return null;
  if (/^\d+$/.test(raw)) return { updatedAt: parseInt(raw, 10), id: 0 };
  return decodeDeltaCursor(raw);
}

/** The larger of two compound cursors (either may be null). */
export function maxCursor(a: DeltaCursor | null, b: DeltaCursor | null): DeltaCursor | null {
  if (!a) return b;
  if (!b) return a;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.id >= b.id ? a : b;
}

/**
 * `(updated_at, id) > (?, ?)` in a form D1 plans well, plus its bind params.
 * Row-value comparisons are avoided deliberately — the expanded form uses
 * `idx_item_labels_user_updated` on every SQLite build we run against.
 */
export function afterCursorSql(column = 'updated_at', idColumn = 'id'): string {
  return `(${column} > ? OR (${column} = ? AND ${idColumn} > ?))`;
}

export function afterCursorParams(cursor: DeltaCursor): number[] {
  return [cursor.updatedAt, cursor.updatedAt, cursor.id];
}

/**
 * The user's own timestamp for a write, in unix ms, made safe to store.
 *
 * Clamped to server-now: a device whose clock runs fast would otherwise pin its
 * row against every later write from every other device, permanently. A
 * backward-skewed device just loses ties, which is exactly today's
 * arrival-ordered behaviour and therefore no regression. Missing or nonsense
 * input means "now" — an old client that sends nothing keeps working.
 */
export function clampClientUpdatedAt(value: unknown, nowMs: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return nowMs;
  return Math.min(Math.floor(value), nowMs);
}
