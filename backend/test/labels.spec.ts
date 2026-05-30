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
  }>;
  cursor?: string;
};

async function getLabels(path: string): Promise<{ status: number; body: LabelsResponse }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(makeAuthRequest(path), env, ctx);
  await waitOnExecutionContext(ctx);
  const body = (await response.json()) as LabelsResponse;
  return { status: response.status, body };
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
    await insertLabel('a', { updatedAt: now - 30, label: 'tagged', props: { tags: ['t'] } });
    await insertLabel('b', { updatedAt: now - 20, label: 'archived', props: { archivedAt: 1 } });
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

  describe('delta sync (?since=)', () => {
    it('returns only rows changed strictly after the cursor', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertLabel('at-cursor', { updatedAt: now - 100 });
      await insertLabel('after-cursor', { updatedAt: now - 50 });

      const { body } = await getLabels(`/api/labels?since=${now - 100}`);
      expect(body.labels.map((l) => l.itemKey)).toEqual(['after-cursor']);
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
      await insertLabel('new-archived', { updatedAt: now - 10, label: 'archived' });

      const { body } = await getLabels(`/api/labels?label=tagged&since=${now - 50}`);
      expect(body.labels.map((l) => l.itemKey)).toEqual(['new-tag']);
    });
  });
});
