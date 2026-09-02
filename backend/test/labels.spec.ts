import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:labels123';
const TEST_SESSION_ID = 'test-session-labels';

async function setupTestUser() {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
  )
    .bind(TEST_DID, 'labels.bsky.social', 'https://test.pds.example')
    .run();

  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      TEST_SESSION_ID,
      TEST_DID,
      'labels.bsky.social',
      'https://test.pds.example',
      'test-access-token',
      'test-refresh-token',
      JSON.stringify({ kty: 'EC' }),
      Date.now() + 3600000
    )
    .run();
}

// Insert a label with an explicit updated_at (seconds) so delta boundaries are
// deterministic instead of clock-relative.
async function insertLabel(
  itemKey: string,
  opts: {
    updatedAt: number;
    label?: string;
    itemType?: string;
    props?: Record<string, unknown>;
  }
) {
  await env.DB.prepare(
    `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      TEST_DID,
      itemKey,
      opts.itemType ?? 'article',
      opts.label ?? 'tagged',
      JSON.stringify(opts.props ?? { tags: ['x'] }),
      `rk-${itemKey}`,
      opts.updatedAt,
      opts.updatedAt
    )
    .run();
}

function makeAuthRequest(path: string) {
  return new IncomingRequest(`http://localhost${path}`, {
    method: 'GET',
    headers: {
      Cookie: `session_id=${TEST_SESSION_ID}`,
      Origin: env.FRONTEND_URL,
    },
  });
}

type LabelsResponse = {
  labels: Array<{
    itemKey: string;
    itemType: string;
    label: string;
    props: Record<string, unknown>;
    updatedAt: number;
    deletedAt: number | null;
    clientUpdatedAt?: number | null;
  }>;
  cursor?: string;
  nextSince?: string;
  hasMore?: boolean;
};

async function getLabels(path: string): Promise<{ status: number; body: LabelsResponse }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(makeAuthRequest(path), env, ctx);
  await waitOnExecutionContext(ctx);
  const body = (await response.json()) as LabelsResponse;
  return { status: response.status, body };
}

// Issue a mutating request (POST add / DELETE) against /api/labels.
async function mutateLabels(method: 'POST' | 'DELETE', body: unknown): Promise<number> {
  const ctx = createExecutionContext();
  const request = new IncomingRequest('http://localhost/api/labels', {
    method,
    headers: {
      Cookie: `session_id=${TEST_SESSION_ID}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response.status;
}

describe('GET /api/labels', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupTestUser();
  });

  it('returns 401 without auth', async () => {
    const ctx = createExecutionContext();
    const request = new IncomingRequest('http://localhost/api/labels', {
      headers: { Origin: env.FRONTEND_URL },
    });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it('returns all managed label types in one unfiltered fetch', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertLabel('a', {
      updatedAt: now - 30,
      label: 'tagged',
      props: { tags: ['t'] },
    });
    await insertLabel('b', {
      updatedAt: now - 20,
      label: 'archived',
      props: { archivedAt: 1 },
    });
    await insertLabel('c', {
      updatedAt: now - 10,
      label: 'readProgress',
      props: { paragraphIndex: 2 },
    });

    const { status, body } = await getLabels('/api/labels');
    expect(status).toBe(200);
    // Newest-first ordering.
    expect(body.labels.map((l) => l.itemKey)).toEqual(['c', 'b', 'a']);
    expect(body.labels.map((l) => l.label)).toEqual(['readProgress', 'archived', 'tagged']);
  });

  it('filters by label when ?label= is provided', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertLabel('a', { updatedAt: now - 30, label: 'tagged' });
    await insertLabel('b', { updatedAt: now - 20, label: 'archived' });

    const { body } = await getLabels('/api/labels?label=archived');
    expect(body.labels.map((l) => l.itemKey)).toEqual(['b']);
  });

  it('restricts to a set of label types when ?labels= is provided', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertLabel('a', { updatedAt: now - 30, label: 'tagged' });
    await insertLabel('b', { updatedAt: now - 20, label: 'archived' });
    await insertLabel('c', { updatedAt: now - 10, label: 'read' });

    const { body } = await getLabels('/api/labels?labels=tagged,archived');
    expect(body.labels.map((l) => l.itemKey)).toEqual(['b', 'a']);
  });

  it('excludes unrelated label types (read) from a labels-filtered delta', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertLabel('tag', { updatedAt: now - 10, label: 'tagged' });
    await insertLabel('readrow', { updatedAt: now - 5, label: 'read' });

    const { body } = await getLabels(
      `/api/labels?labels=tagged,archived,readProgress&since=${now - 50}`
    );
    expect(body.labels.map((l) => l.itemKey)).toEqual(['tag']);
  });

  describe('delta sync (?since=)', () => {
    // A legacy numeric cursor is read as `(seconds, 0)`, so the cursor's own
    // second is re-delivered exactly once rather than dropped forever — the
    // same-second loss the compound cursor exists to fix. Application is an
    // idempotent upsert, so a single repeat costs nothing.
    it('re-delivers the cursor second with a legacy numeric cursor, then moves past it', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertLabel('at-cursor', { updatedAt: now - 100 });
      await insertLabel('after-cursor', { updatedAt: now - 50 });

      const { body } = await getLabels(`/api/labels?since=${now - 100}`);
      expect(body.labels.map((l) => l.itemKey)).toEqual(['at-cursor', 'after-cursor']);

      const { body: second } = await getLabels(
        `/api/labels?since=${encodeURIComponent(body.nextSince!)}`
      );
      expect(second.labels).toHaveLength(0);
    });

    it('delivers same-second rows exactly once across pages', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertLabel('same-1', { updatedAt: now - 10 });
      await insertLabel('same-2', { updatedAt: now - 10 });
      await insertLabel('same-3', { updatedAt: now - 10 });

      const seen: string[] = [];
      let since = '0';
      for (let page = 0; page < 5; page++) {
        const { body } = await getLabels(`/api/labels?since=${encodeURIComponent(since)}&limit=1`);
        seen.push(...body.labels.map((l) => l.itemKey));
        since = body.nextSince!;
        if (!body.hasMore) break;
      }

      expect(seen).toEqual(['same-1', 'same-2', 'same-3']);
    });

    it('echoes the caller cursor back on an empty delta rather than a clock reading', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertLabel('existing', { updatedAt: now - 100 });

      const { body } = await getLabels(`/api/labels?since=${now}`);
      expect(body.labels).toHaveLength(0);
      expect(atob(body.nextSince!)).toBe(`${now}:0`);
    });

    it('returns an empty delta when nothing is newer', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertLabel('existing', { updatedAt: now - 100 });

      const { body } = await getLabels(`/api/labels?since=${now}`);
      expect(body.labels).toHaveLength(0);
    });

    it('combines a label filter with a since cursor', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertLabel('old-tag', { updatedAt: now - 100, label: 'tagged' });
      await insertLabel('new-tag', { updatedAt: now - 10, label: 'tagged' });
      await insertLabel('new-archived', {
        updatedAt: now - 10,
        label: 'archived',
      });

      const { body } = await getLabels(`/api/labels?label=tagged&since=${now - 50}`);
      expect(body.labels.map((l) => l.itemKey)).toEqual(['new-tag']);
    });
  });

  describe('tombstones (soft delete)', () => {
    it('DELETE soft-deletes: the row surfaces in a delta with deletedAt set', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertLabel('tag-me', { updatedAt: now - 100, label: 'tagged' });

      expect(await mutateLabels('DELETE', { itemKey: 'tag-me', label: 'tagged' })).toBe(200);

      const { body } = await getLabels(`/api/labels?since=${now - 100}`);
      expect(body.labels).toHaveLength(1);
      expect(body.labels[0].itemKey).toBe('tag-me');
      expect(body.labels[0].deletedAt).toBeGreaterThan(0);
    });

    it('a full snapshot excludes tombstoned rows', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertLabel('keep', { updatedAt: now - 100, label: 'tagged' });
      await insertLabel('drop', { updatedAt: now - 100, label: 'tagged' });

      expect(await mutateLabels('DELETE', { itemKey: 'drop', label: 'tagged' })).toBe(200);

      const { body } = await getLabels('/api/labels');
      expect(body.labels.map((l) => l.itemKey)).toEqual(['keep']);
    });

    it('re-adding a deleted label resurrects it (clears the tombstone)', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertLabel('revive', {
        updatedAt: now - 100,
        label: 'tagged',
        props: { tags: ['a'] },
      });

      expect(await mutateLabels('DELETE', { itemKey: 'revive', label: 'tagged' })).toBe(200);
      expect(
        await mutateLabels('POST', {
          itemKey: 'revive',
          itemType: 'article',
          label: 'tagged',
          props: { tags: ['b'] },
        })
      ).toBe(200);

      const { body } = await getLabels('/api/labels');
      expect(body.labels).toHaveLength(1);
      expect(body.labels[0].itemKey).toBe('revive');
      expect(body.labels[0].deletedAt).toBeNull();
      expect(body.labels[0].props).toEqual({ tags: ['b'] });
    });
  });
});

// The user-time last-write-wins guard (migration 0076). Before it, the winner
// was whichever HTTP request arrived last, so a device draining an offline
// queue overwrote everything the user had done elsewhere in the meantime.
describe('/api/labels user-time last-write-wins', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupTestUser();
  });

  async function readRow(itemKey: string) {
    return env.DB.prepare(
      `SELECT props, deleted_at, client_updated_at FROM item_labels_cache
        WHERE user_did = ? AND item_key = ? AND label = 'tagged'`
    )
      .bind(TEST_DID, itemKey)
      .first<{ props: string; deleted_at: number | null; client_updated_at: number }>();
  }

  it('rejects a write whose user time is older than the stored one', async () => {
    const now = Date.now();
    await mutateLabels('POST', {
      itemKey: 'lww',
      itemType: 'article',
      label: 'tagged',
      props: { tags: ['recent'] },
      updatedAt: now,
    });
    // The late-draining queue: enqueued an hour ago, arriving now.
    await mutateLabels('POST', {
      itemKey: 'lww',
      itemType: 'article',
      label: 'tagged',
      props: { tags: ['stale'] },
      updatedAt: now - 3600_000,
    });

    const row = await readRow('lww');
    expect(JSON.parse(row!.props)).toEqual({ tags: ['recent'] });
  });

  it('accepts an equal user time so an idempotent retry still lands', async () => {
    const at = Date.now() - 1000;
    await mutateLabels('POST', {
      itemKey: 'retry',
      itemType: 'article',
      label: 'tagged',
      props: { tags: ['first'] },
      updatedAt: at,
    });
    await mutateLabels('POST', {
      itemKey: 'retry',
      itemType: 'article',
      label: 'tagged',
      props: { tags: ['second'] },
      updatedAt: at,
    });

    const row = await readRow('retry');
    expect(JSON.parse(row!.props)).toEqual({ tags: ['second'] });
  });

  it('applies the guard to deletes too, so a stale un-tag cannot win', async () => {
    const now = Date.now();
    await mutateLabels('POST', {
      itemKey: 'del',
      itemType: 'article',
      label: 'tagged',
      props: { tags: ['a'] },
      updatedAt: now,
    });
    await mutateLabels('DELETE', { itemKey: 'del', label: 'tagged', updatedAt: now - 3600_000 });

    const row = await readRow('del');
    expect(row!.deleted_at).toBeNull();
  });

  it('clamps a forward-skewed clock to server now instead of pinning the row', async () => {
    const future = Date.now() + 10 * 365 * 24 * 3600_000;
    await mutateLabels('POST', {
      itemKey: 'skew',
      itemType: 'article',
      label: 'tagged',
      props: { tags: ['from-the-future'] },
      updatedAt: future,
    });

    const row = await readRow('skew');
    expect(row!.client_updated_at).toBeLessThanOrEqual(Date.now());

    // A subsequent honest write still wins, which is the point of clamping.
    await mutateLabels('POST', {
      itemKey: 'skew',
      itemType: 'article',
      label: 'tagged',
      props: { tags: ['now'] },
      updatedAt: Date.now(),
    });
    expect(JSON.parse((await readRow('skew'))!.props)).toEqual({ tags: ['now'] });
  });
});

/**
 * Merging a guest's highlights into an account that already has some.
 *
 * Under plain replace semantics an article highlighted in BOTH contexts loses
 * one side wholesale: whichever `client_updated_at` is later wins the entire
 * array, and the other side's highlights are gone with no error anywhere. These
 * pin the union that makes signing in additive.
 */
describe("POST /api/labels mode: 'merge' (highlights)", () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupTestUser();
  });

  async function readHighlights(itemKey: string) {
    const row = await env.DB.prepare(
      `SELECT props, deleted_at, client_updated_at FROM item_labels_cache
        WHERE user_did = ? AND item_key = ? AND label = 'highlights'`
    )
      .bind(TEST_DID, itemKey)
      .first<{ props: string; deleted_at: number | null; client_updated_at: number }>();
    return {
      ids: (JSON.parse(row!.props).highlights as Array<{ id: string }>).map((h) => h.id).sort(),
      raw: JSON.parse(row!.props).highlights as Array<{ id: string; note?: string }>,
      deletedAt: row!.deleted_at,
      clientUpdatedAt: row!.client_updated_at,
    };
  }

  function hl(id: string, note?: string) {
    return { id, selector: { exact: id }, createdAt: 1, ...(note ? { note } : {}) };
  }

  async function write(
    itemKey: string,
    highlights: unknown[],
    updatedAt: number,
    mode?: 'merge'
  ): Promise<number> {
    return mutateLabels('POST', {
      itemKey,
      itemType: 'article',
      label: 'highlights',
      props: { highlights },
      updatedAt,
      ...(mode ? { mode } : {}),
    });
  }

  it('keeps both sides when the account row is NEWER than the guest write', async () => {
    const now = Date.now();
    // The account highlighted this article on another device, recently.
    await write('shared', [hl('account-1')], now);
    // The guest highlighted it days ago; the queue drains now.
    expect(await write('shared', [hl('guest-1')], now - 3 * 86400_000, 'merge')).toBe(200);

    // A replace would have been refused by the staleness guard, losing guest-1.
    expect((await readHighlights('shared')).ids).toEqual(['account-1', 'guest-1']);
  });

  it('keeps both sides when the guest write is NEWER than the account row', async () => {
    const now = Date.now();
    await write('shared2', [hl('account-1')], now - 3 * 86400_000);
    expect(await write('shared2', [hl('guest-1')], now, 'merge')).toBe(200);

    // A replace would have won wholesale here, losing account-1.
    expect((await readHighlights('shared2')).ids).toEqual(['account-1', 'guest-1']);
  });

  it('lets the incoming version win an id present on both sides', async () => {
    const now = Date.now();
    await write('dup', [hl('same', 'account note')], now);
    await write('dup', [hl('same', 'guest note')], now - 1000, 'merge');

    const { raw } = await readHighlights('dup');
    expect(raw).toHaveLength(1);
    expect(raw[0].note).toBe('guest note');
  });

  it('never lowers client_updated_at, so a later replace still wins normally', async () => {
    const now = Date.now();
    await write('cua', [hl('account-1')], now);
    await write('cua', [hl('guest-1')], now - 3 * 86400_000, 'merge');
    expect((await readHighlights('cua')).clientUpdatedAt).toBe(now);

    // A genuinely stale replace is still refused after the merge.
    await write('cua', [hl('stale-only')], now - 86400_000);
    expect((await readHighlights('cua')).ids).toEqual(['account-1', 'guest-1']);
  });

  it('does not resurrect highlights the reader deleted', async () => {
    const now = Date.now();
    await write('tomb', [hl('deleted-1')], now - 86400_000);
    await mutateLabels('DELETE', { itemKey: 'tomb', label: 'highlights', updatedAt: now });

    await write('tomb', [hl('guest-1')], now - 3 * 86400_000, 'merge');

    const merged = await readHighlights('tomb');
    expect(merged.ids).toEqual(['guest-1']);
    expect(merged.deletedAt).toBeNull();
  });

  it('creates the row when the account has no highlights on that article', async () => {
    expect(await write('fresh', [hl('guest-1')], Date.now(), 'merge')).toBe(200);
    expect((await readHighlights('fresh')).ids).toEqual(['guest-1']);
  });

  it('refuses merge for any label but highlights, rather than replacing quietly', async () => {
    const status = await mutateLabels('POST', {
      itemKey: 'wrong',
      itemType: 'article',
      label: 'tagged',
      props: { tags: ['x'] },
      updatedAt: Date.now(),
      mode: 'merge',
    });
    expect(status).toBe(400);
  });

  it('refuses merge when props.highlights is not an array', async () => {
    const status = await mutateLabels('POST', {
      itemKey: 'bad',
      itemType: 'article',
      label: 'highlights',
      props: { highlights: 'nope' },
      updatedAt: Date.now(),
      mode: 'merge',
    });
    expect(status).toBe(400);
  });

  // The union is by id, so an element without one has no defined behaviour —
  // and it used to be catastrophic: `NOT IN (… NULL)` is NULL for every row, so
  // one id-less incoming highlight silently dropped the reader's ENTIRE stored
  // array, on the one path written to prevent silent data loss.
  it.each([
    ['no id at all', { selector: { exact: 'x' } }],
    ['a non-string id', { id: 7, selector: { exact: 'x' } }],
    ['an empty id', { id: '', selector: { exact: 'x' } }],
    ['not an object', 'just a string'],
  ])('refuses a merge carrying a highlight with %s', async (_label, bad) => {
    const now = Date.now();
    await write('idless', [hl('account-1'), hl('account-2')], now);

    expect(await write('idless', [hl('guest-1'), bad], now, 'merge')).toBe(400);
    expect((await readHighlights('idless')).ids).toEqual(['account-1', 'account-2']);
  });

  // Belt and braces: even if such a write ever reached the SQL, the anti-join
  // is NULL-safe and keeps everything already stored.
  it('keeps the stored array when an id-less highlight reaches the merge SQL', async () => {
    const now = Date.now();
    await write('idless-sql', [hl('account-1'), hl('same')], now);

    await env.DB.prepare(
      `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
       VALUES (?, 'idless-sql', 'article', 'highlights', ?, 'rkeyxxxxxxxxx', unixepoch(), unixepoch(), ?)
       ON CONFLICT(user_did, item_key, label) DO UPDATE SET
         props = json_object('highlights', (
           SELECT json_group_array(json(value)) FROM (
             SELECT value FROM json_each(json_extract(excluded.props, '$.highlights'))
             UNION ALL
             SELECT value FROM json_each(json_extract(item_labels_cache.props, '$.highlights')) AS kept
              WHERE item_labels_cache.deleted_at IS NULL
                AND NOT EXISTS (
                  SELECT 1
                    FROM json_each(json_extract(excluded.props, '$.highlights')) AS incoming
                   WHERE json_extract(incoming.value, '$.id') IS
                         json_extract(kept.value, '$.id'))
           )
         )),
         updated_at = excluded.updated_at,
         client_updated_at = MAX(excluded.client_updated_at, COALESCE(item_labels_cache.client_updated_at, 0)),
         deleted_at = NULL`
    )
      .bind(
        TEST_DID,
        JSON.stringify({ highlights: [{ selector: { exact: 'no id' } }] }),
        now - 1000
      )
      .run();

    // Both stored highlights survive alongside the id-less incoming one; before
    // the NULL-safe anti-join, the stored array was wiped out entirely.
    const { raw } = await readHighlights('idless-sql');
    expect(
      raw
        .map((h) => h.id)
        .filter(Boolean)
        .sort()
    ).toEqual(['account-1', 'same']);
  });
});
