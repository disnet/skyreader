// Zotero sync: Skyreader's saves and highlights pushed into the reader's Zotero
// library, through the Zotero Web API (https://www.zotero.org/support/dev/web_api/v3).
//
// The reader connects with an API key they make at zotero.org (library access,
// write access). Each page becomes an item in a "Skyreader" collection, with
// citation details (DOI, arXiv id, URL, accessed date), and its highlights and
// notes go in one child note that Skyreader keeps up to date. A paper already in
// the library (matched by DOI) gets the note instead of a duplicate item.
//
// Only Skyreader's note is ever rewritten. An item, once made, is the reader's:
// its fields aren't touched again, and one they delete in Zotero isn't made
// again. Removing something in Skyreader leaves it in Zotero.

import type { Env } from '../types';
import { collectExport } from './export/collect';
import { day, displayTitle, hostOf, splitAuthors, type ExportSource } from './export/render';
import { escapeHtml } from '../utils/html-text';
import { getUserTier } from './user-tier';
import { getLimitsForTier } from '../config/tier-limits';
import { sha256Hex } from '../utils/sha256';
import { log } from '../utils/logger';
import { openSecret } from '../utils/secret-box';

export const ZOTERO_API = 'https://api.zotero.org';
const COLLECTION_NAME = 'Skyreader';
// Objects per write (the Web API takes up to 50). Each write's results are
// recorded before the next, so a sync cut short loses at most one write.
const WRITE_BATCH = 20;
// Per sync, so one reader's sync stays well inside a Worker invocation's
// subrequest and D1 budget (each object written is ~3 D1 statements). A sync
// that runs out leaves its cursor alone and the next one carries on; what's
// done is skipped, since it's recorded as it's written.
const MAX_REQUESTS_PER_SYNC = 40;
const MAX_WRITES_PER_SYNC = 150;
// Between background syncs of one reader.
export const ZOTERO_SYNC_INTERVAL_SECONDS = 15 * 60;
// A sync holds its reader's lease at most this long.
const LEASE_SECONDS = 5 * 60;
// The cursor trails the sync by this much, as the highlight sync's does.
const CURSOR_OVERLAP_SECONDS = 60;

export interface ZoteroConnection {
  user_did: string;
  /** Sealed under ZOTERO_KEY_SECRET (utils/secret-box.ts). */
  api_key_sealed: string;
  zotero_user_id: string;
  zotero_username: string | null;
  scope: 'everything' | 'collections';
  collections: string;
  zotero_collection_key: string | null;
  cursor: number;
  sync_started_at: number | null;
  last_sync_at: number | null;
  last_error: string | null;
  /** Bumped when the scope or library changes, so a sync begun before can't move the cursor. */
  generation: number;
}

export class ZoteroError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

// ─── The Web API ───────────────────────────────────────────────────────────────

type WriteOutcome = { key: string; version: number } | { failed: number; message: string };

class ZoteroClient {
  requests = 0;

  constructor(
    private apiKey: string,
    private userId: string
  ) {}

  get exhausted() {
    return this.requests >= MAX_REQUESTS_PER_SYNC;
  }

  async call(path: string, init: RequestInit = {}): Promise<Response> {
    this.requests++;
    const response = await fetch(`${ZOTERO_API}/users/${this.userId}${path}`, {
      ...init,
      headers: {
        'Zotero-API-Key': this.apiKey,
        'Zotero-API-Version': '3',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (response.status === 403) {
      throw new ZoteroError(
        'Zotero refused the API key. Make a new one with write access and connect again.',
        403
      );
    }
    // Zotero asks clients to back off when it's busy; the next sync tries again.
    if (response.status === 429 || response.status === 503) {
      throw new ZoteroError('Zotero is busy. The next sync tries again.', 429);
    }
    if (response.headers.has('Backoff')) this.requests = MAX_REQUESTS_PER_SYNC;
    return response;
  }

  /** POST one batch; each result says the object's key and version, or why not. */
  async write(path: string, batch: Record<string, unknown>[]): Promise<WriteOutcome[]> {
    const response = await this.call(path, { method: 'POST', body: JSON.stringify(batch) });
    if (!response.ok) throw new ZoteroError(`Zotero answered ${response.status}.`, response.status);
    const body = (await response.json()) as {
      successful?: Record<string, { key: string; version: number }>;
      unchanged?: Record<string, string>;
      failed?: Record<string, { code: number; message: string }>;
    };
    return batch.map((object, j) => {
      const ok = body.successful?.[j];
      if (ok) return { key: ok.key, version: ok.version };
      const unchanged = body.unchanged?.[j];
      if (unchanged) return { key: unchanged, version: Number(object.version ?? 0) };
      const failed = body.failed?.[j];
      return { failed: failed?.code ?? 500, message: failed?.message ?? '' };
    });
  }

  async get(path: string): Promise<Response> {
    return this.call(path);
  }
}

/** The key's owner, checked for the access a sync needs. */
export async function verifyZoteroKey(
  apiKey: string
): Promise<{ userId: string; username: string | null }> {
  const response = await fetch(`${ZOTERO_API}/keys/current`, {
    headers: { 'Zotero-API-Key': apiKey, 'Zotero-API-Version': '3' },
  });
  if (response.status === 403 || response.status === 404) {
    throw new ZoteroError("Zotero doesn't know that key. Check it was copied whole.", 400);
  }
  if (!response.ok) throw new ZoteroError(`Zotero answered ${response.status}.`, 502);
  const body = (await response.json()) as {
    userID?: number;
    username?: string;
    access?: { user?: { library?: boolean; write?: boolean } };
  };
  if (!body.userID || !body.access?.user?.library || !body.access.user.write) {
    throw new ZoteroError(
      'That key needs “Allow library access” and “Allow write access” turned on.',
      400
    );
  }
  return { userId: String(body.userID), username: body.username ?? null };
}

// ─── Items and notes ───────────────────────────────────────────────────────────

function creators(author: string | undefined) {
  return splitAuthors(author).map((name) => {
    if (name.includes(',')) {
      const [lastName, firstName] = name.split(',').map((part) => part.trim());
      return { creatorType: 'author', lastName, firstName };
    }
    const parts = name.split(' ');
    if (parts.length === 1) return { creatorType: 'author', name };
    return {
      creatorType: 'author',
      firstName: parts.slice(0, -1).join(' '),
      lastName: parts.at(-1)!,
    };
  });
}

/**
 * A page as a Zotero item: a preprint for an arXiv paper, a journal article
 * for anything else with a DOI, a book for an EPUB, a document for a PDF, and
 * otherwise a web page. Only fields that item type has, or the write fails.
 */
export function zoteroItem(source: ExportSource, collectionKey: string | null) {
  const common = {
    title: displayTitle(source),
    creators: creators(source.author),
    date: day(source.publishedAt) ?? '',
    url: source.url ?? '',
    accessDate: source.url ? (day(source.savedAt) ?? '') : '',
    collections: collectionKey ? [collectionKey] : [],
  };
  if (source.arxivId) {
    return {
      itemType: 'preprint',
      ...common,
      DOI: source.doi ?? '',
      archiveID: `arXiv:${source.arxivId}`,
      repository: 'arXiv',
    };
  }
  if (source.doi) return { itemType: 'journalArticle', ...common, DOI: source.doi };
  const extra = source.filename && !source.url ? `Original file: ${source.filename}` : '';
  // 'book': one known only by its highlights, imported from Kindle or Readwise.
  if (source.contentType === 'epub' || source.contentType === 'book')
    return { itemType: 'book', ...common, extra };
  if (source.contentType === 'pdf' || !source.url)
    return { itemType: 'document', ...common, extra };
  return {
    itemType: 'webpage',
    ...common,
    websiteTitle: source.domain ?? hostOf(source.url) ?? '',
  };
}

const paragraphs = (text: string) =>
  text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');

/** Skyreader's child note: the page's highlights and notes, in reading order. */
export function zoteroNote(source: ExportSource): string {
  const out = ['<h1>Skyreader highlights</h1>'];
  if (source.highlights.length === 0) out.push('<p>No highlights yet.</p>');
  for (const highlight of source.highlights) {
    if (highlight.text.trim()) out.push(`<blockquote>${paragraphs(highlight.text)}</blockquote>`);
    if (highlight.note?.trim()) {
      out.push(paragraphs(highlight.note).replace('<p>', '<p><strong>Note:</strong> '));
    }
  }
  out.push(
    '<p><em>Skyreader keeps this note up to date. Write your own notes in a note of their own.</em></p>'
  );
  return `<div data-schema-version="9">${out.join('\n')}</div>`;
}

// ─── One reader's sync ─────────────────────────────────────────────────────────

interface ItemRow {
  source_key: string;
  item_key: string;
  note_key: string | null;
  note_version: number | null;
  note_hash: string | null;
  dropped: number;
}

type ItemState = Omit<ItemRow, 'source_key'>;

const newItem = (item_key: string, dropped = 0): ItemState => ({
  item_key,
  note_key: null,
  note_version: null,
  note_hash: null,
  dropped,
});

async function itemRows(env: Env, did: string, keys: string[]): Promise<Map<string, ItemRow>> {
  const found = new Map<string, ItemRow>();
  for (let i = 0; i < keys.length; i += 90) {
    const batch = keys.slice(i, i + 90);
    const rows = await env.DB.prepare(
      `SELECT source_key, item_key, note_key, note_version, note_hash, dropped FROM zotero_items
        WHERE user_did = ? AND source_key IN (${batch.map(() => '?').join(',')})`
    )
      .bind(did, ...batch)
      .all<ItemRow>();
    for (const row of rows.results ?? []) found.set(row.source_key, row);
  }
  return found;
}

const keysOf = (source: ExportSource) => source.keys ?? (source.id ? [source.id] : []);

/**
 * Pages' items (and notes) to record, each under every key the page goes by,
 * written in one D1 batch and mirrored into `rows` for the rest of the sync.
 */
async function recordItems(
  env: Env,
  did: string,
  rows: Map<string, ItemRow>,
  items: { source: ExportSource; item: ItemState }[]
): Promise<void> {
  const statements = items.flatMap(({ source, item }) =>
    keysOf(source).map((key) => {
      rows.set(key, { source_key: key, ...item });
      return env.DB.prepare(
        `INSERT INTO zotero_items (user_did, source_key, item_key, note_key, note_version, note_hash, dropped)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_did, source_key) DO UPDATE SET
           item_key = excluded.item_key, note_key = excluded.note_key,
           note_version = excluded.note_version, note_hash = excluded.note_hash,
           dropped = excluded.dropped`
      ).bind(
        did,
        key,
        item.item_key,
        item.note_key,
        item.note_version,
        item.note_hash,
        item.dropped
      );
    })
  );
  if (statements.length > 0) await env.DB.batch(statements);
}

/** The item already in the library with this DOI, if any. */
async function findByDoi(client: ZoteroClient, doi: string): Promise<string | null> {
  const response = await client.get(
    `/items/top?q=${encodeURIComponent(doi)}&qmode=everything&limit=10`
  );
  if (!response.ok) return null;
  const items = (await response.json()) as {
    key: string;
    data: { DOI?: string; extra?: string; deleted?: number };
  }[];
  const wanted = doi.toLowerCase();
  const match = items.find(
    ({ data }) =>
      !data.deleted &&
      (data.DOI?.toLowerCase() === wanted ||
        data.extra?.toLowerCase().includes(`doi: ${wanted}`) === true)
  );
  return match?.key ?? null;
}

async function ensureCollection(env: Env, client: ZoteroClient, conn: ZoteroConnection) {
  if (conn.zotero_collection_key) return conn.zotero_collection_key;
  const [made] = await client.write('/collections', [{ name: COLLECTION_NAME }]);
  if (!('key' in made)) throw new ZoteroError("Couldn't make the Skyreader collection.", 500);
  await env.DB.prepare('UPDATE zotero_connections SET zotero_collection_key = ? WHERE user_did = ?')
    .bind(made.key, conn.user_did)
    .run();
  conn.zotero_collection_key = made.key;
  return made.key;
}

/** Is the item still in the library, out of the trash? */
async function itemAlive(client: ZoteroClient, key: string): Promise<boolean> {
  const response = await client.get(`/items/${key}`);
  if (response.status === 404) return false;
  if (!response.ok) return true; // unsure: don't give the page up
  const body = (await response.json()) as { data?: { deleted?: number } };
  return !body.data?.deleted;
}

// A write Zotero refused for what the object is (a field it won't take), not
// for now: trying again would fail the same way.
const permanent = (code: number) => code >= 400 && code < 500 && code !== 409 && code !== 412;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ZoteroSyncResult {
  created: number;
  notes: number;
  /** Ran out of its allowance, or has something to retry; the next sync carries on. */
  partial: boolean;
}

/**
 * Push what changed since the connection's cursor. Each write is recorded as
 * it lands, so a sync cut short (or run twice) never makes an item twice.
 */
export async function syncZoteroConnection(
  env: Env,
  conn: ZoteroConnection
): Promise<ZoteroSyncResult> {
  const did = conn.user_did;
  const apiKey = env.ZOTERO_KEY_SECRET
    ? await openSecret(env.ZOTERO_KEY_SECRET, did, conn.api_key_sealed)
    : null;
  if (!apiKey) {
    throw new ZoteroError("Skyreader can't use your Zotero key any more. Paste a new one.", 401);
  }
  const client = new ZoteroClient(apiKey, conn.zotero_user_id);
  const startedAt = Math.floor(Date.now() / 1000);
  const collections = conn.scope === 'collections' ? parseCollections(conn.collections) : null;
  const result: ZoteroSyncResult = { created: 0, notes: 0, partial: false };
  if (collections && collections.length === 0) return result;
  let writes = 0;
  const spent = () => client.exhausted || writes >= MAX_WRITES_PER_SYNC;

  const doc = await collectExport(env, did, {
    since: conn.cursor,
    everySave: true,
    ...(collections ? { collections } : {}),
  });
  const sources = doc.sources.filter((s) => keysOf(s).length > 0);
  const rows = await itemRows(env, did, sources.flatMap(keysOf));
  const rowOf = (source: ExportSource) =>
    keysOf(source)
      .map((k) => rows.get(k))
      .find((r) => r);

  // Pages with no item yet: find the paper in the library, else make one. A
  // page whose highlights were all deleted before it had an item gets none.
  const pending = sources.filter(
    (s) => !rowOf(s) && !(s.kind === 'highlighted' && s.highlights.length === 0)
  );
  const collectionKey = pending.length > 0 ? await ensureCollection(env, client, conn) : null;
  for (const chunk of chunks(pending, WRITE_BATCH)) {
    const found: { source: ExportSource; item: ItemState }[] = [];
    const toMake: ExportSource[] = [];
    for (const source of chunk) {
      if (spent()) break;
      const existing = source.doi ? await findByDoi(client, source.doi) : null;
      if (existing) found.push({ source, item: newItem(existing) });
      else toMake.push(source);
    }
    const made: { source: ExportSource; item: ItemState }[] = [];
    if (toMake.length > 0 && !client.exhausted) {
      const outcomes = await client.write(
        '/items',
        toMake.map((s) => zoteroItem(s, collectionKey))
      );
      writes += toMake.length;
      outcomes.forEach((outcome, i) => {
        if ('key' in outcome) {
          made.push({ source: toMake[i], item: newItem(outcome.key) });
          result.created++;
        } else if (permanent(outcome.failed)) {
          // Recorded as dropped so it isn't retried every sync; it's in the log.
          log.warn('zotero_item_refused', { did, code: outcome.failed, message: outcome.message });
          made.push({ source: toMake[i], item: newItem('', 1) });
        } else {
          result.partial = true;
        }
      });
    }
    await recordItems(env, did, rows, [...found, ...made]);
    if (found.length + made.length < chunk.length) {
      result.partial = true;
      break;
    }
  }

  // Notes: made for pages with highlights, rewritten when they changed.
  const creates: { source: ExportSource; row: ItemRow; html: string; hash: string }[] = [];
  const updates: typeof creates = [];
  for (const source of sources) {
    const row = rowOf(source);
    if (!row || row.dropped) continue;
    if (!row.note_key && source.highlights.length === 0) continue;
    const html = zoteroNote(source);
    const hash = await sha256Hex(new TextEncoder().encode(html));
    if (hash === row.note_hash) continue;
    (row.note_key ? updates : creates).push({ source, row, html, hash });
  }

  for (const chunk of chunks(creates, WRITE_BATCH)) {
    if (spent()) {
      result.partial = true;
      break;
    }
    const outcomes = await client.write(
      '/items',
      chunk.map(({ row, html }) => ({ itemType: 'note', parentItem: row.item_key, note: html }))
    );
    writes += chunk.length;
    const recorded: { source: ExportSource; item: ItemState }[] = [];
    for (const [i, outcome] of outcomes.entries()) {
      const { source, row, hash } = chunk[i];
      if ('key' in outcome) {
        recorded.push({
          source,
          item: { ...row, note_key: outcome.key, note_version: outcome.version, note_hash: hash },
        });
        result.notes++;
      } else if (!client.exhausted && !(await itemAlive(client, row.item_key))) {
        // The reader deleted the item: leave the page out of Zotero from now on.
        recorded.push({ source, item: { ...row, dropped: 1 } });
      } else {
        result.partial = true;
      }
    }
    await recordItems(env, did, rows, recorded);
  }

  for (const { source, row, html, hash } of updates) {
    if (spent()) {
      result.partial = true;
      break;
    }
    const patch = (version: number | null) =>
      client.call(`/items/${row.note_key}`, {
        method: 'PATCH',
        body: JSON.stringify({ note: html }),
        headers: version !== null ? { 'If-Unmodified-Since-Version': String(version) } : {},
      });
    writes++;
    let response = await patch(row.note_version);
    if (response.status === 412 && !client.exhausted) {
      // Edited in Zotero since: the note is Skyreader's, so write over it.
      const current = await client.get(`/items/${row.note_key}`);
      if (current.ok) response = await patch(Number(current.headers.get('Last-Modified-Version')));
    }
    if (response.status === 404) {
      // The reader deleted the note. Kept back from the cursor, so the next sync
      // makes a new one (or finds the item gone and drops the page).
      await recordItems(env, did, rows, [
        { source, item: { ...row, note_key: null, note_version: null, note_hash: null } },
      ]);
      result.partial = true;
    } else if (response.ok) {
      const version = Number(response.headers.get('Last-Modified-Version')) || row.note_version;
      await recordItems(env, did, rows, [
        { source, item: { ...row, note_version: version, note_hash: hash } },
      ]);
      result.notes++;
    } else {
      result.partial = true;
    }
  }

  if (!result.partial) {
    // Only if the scope is still the one this sync ran with.
    await env.DB.prepare(
      'UPDATE zotero_connections SET cursor = ? WHERE user_did = ? AND generation = ?'
    )
      .bind(Math.max(startedAt - CURSOR_OVERLAP_SECONDS, 0), did, conn.generation)
      .run();
  }
  return result;
}

export function parseCollections(raw: string | null): string[] {
  try {
    const value = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Is a sync running for this reader? */
export const leaseHeld = (conn: Pick<ZoteroConnection, 'sync_started_at'>) =>
  conn.sync_started_at !== null &&
  conn.sync_started_at >= Math.floor(Date.now() / 1000) - LEASE_SECONDS;

/**
 * Sync one reader, under a lease so two syncs never run at once, and record how
 * it went on the connection. Null when another sync holds the lease.
 */
export async function runZoteroSync(env: Env, did: string): Promise<ZoteroSyncResult | null> {
  const now = Math.floor(Date.now() / 1000);
  const leased = await env.DB.prepare(
    `UPDATE zotero_connections SET sync_started_at = ?
      WHERE user_did = ? AND (sync_started_at IS NULL OR sync_started_at < ?)
      RETURNING *`
  )
    .bind(now, did, now - LEASE_SECONDS)
    .first<ZoteroConnection>();
  if (!leased) return null;

  let error: string | null = null;
  let result: ZoteroSyncResult = { created: 0, notes: 0, partial: true };
  try {
    if (!getLimitsForTier(await getUserTier(env, did)).liveIntegrations) {
      error = 'Zotero sync is part of the Supporter plan.';
    } else {
      result = await syncZoteroConnection(env, leased);
      log.info('zotero_sync', { did, ...result });
    }
  } catch (err) {
    error =
      err instanceof ZoteroError
        ? err.message
        : "Couldn't reach Zotero. The next sync tries again.";
    if (!(err instanceof ZoteroError)) log.error('zotero_sync_failed', { did, error: String(err) });
  } finally {
    // A scope changed mid-sync is due again straight away.
    await env.DB.prepare(
      `UPDATE zotero_connections SET sync_started_at = NULL, last_error = ?,
         last_sync_at = CASE WHEN generation = ? THEN ? END
        WHERE user_did = ?`
    )
      .bind(error, leased.generation, Math.floor(Date.now() / 1000), did)
      .run();
  }
  return result;
}

/**
 * The cron's share: the readers most overdue, a few at a time, stopping after
 * the first that had something to write, since one first sync can take most
 * of the invocation's budget.
 */
export async function syncDueZotero(env: Env, limit = 5): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(
    `SELECT user_did FROM zotero_connections
      WHERE (last_sync_at IS NULL OR last_sync_at < ?)
        AND (sync_started_at IS NULL OR sync_started_at < ?)
      ORDER BY COALESCE(last_sync_at, 0) ASC LIMIT ?`
  )
    .bind(now - ZOTERO_SYNC_INTERVAL_SECONDS, now - LEASE_SECONDS, limit)
    .all<{ user_did: string }>();
  for (const { user_did } of due.results ?? []) {
    const result = await runZoteroSync(env, user_did);
    if (result && result.created + result.notes > 0) break;
  }
}
