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
