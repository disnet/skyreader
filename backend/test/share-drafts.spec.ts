import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:drafts123';
const TEST_SESSION_ID = 'test-session-drafts';
const OTHER_DID = 'did:plc:drafts456';
const OTHER_SESSION_ID = 'test-session-drafts-other';

async function insertUser(did: string, handle: string, sessionId: string) {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
  )
    .bind(did, handle, 'https://test.pds.example')
    .run();

  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      sessionId,
      did,
      handle,
      'https://test.pds.example',
      'test-access-token',
      'test-refresh-token',
      JSON.stringify({ kty: 'EC' }),
      Date.now() + 3600000
    )
    .run();
}

type DraftRecord = {
  articleUrl: string;
  draft: { blocks?: { kind: string; text: string }[] } | null;
  clientUpdatedAt: number;
  createdAt: number;
  serverUpdatedAt: number;
  deletedAt: number | null;
};

type DraftsResponse = { drafts: DraftRecord[]; cursor?: string; error?: string };

async function getDrafts(
  path: string,
  sessionId = TEST_SESSION_ID
): Promise<{ status: number; body: DraftsResponse }> {
  const ctx = createExecutionContext();
  const request = new IncomingRequest(`http://localhost${path}`, {
    headers: { Cookie: `session_id=${sessionId}`, Origin: env.FRONTEND_URL },
  });
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as DraftsResponse };
}

async function mutate(
  method: 'PUT' | 'DELETE',
  body: unknown,
  sessionId = TEST_SESSION_ID
): Promise<{ status: number; body: { success?: boolean; error?: string } }> {
  const ctx = createExecutionContext();
  const request = new IncomingRequest('http://localhost/api/linkblog/drafts', {
    method,
    headers: {
      Cookie: `session_id=${sessionId}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return {
    status: response.status,
    body: (await response.json()) as { success?: boolean; error?: string },
  };
}

function draftBody(text: string, url = 'https://example.com/a') {
  return {
    articleUrl: url,
    articleTitle: 'A post',
    blocks: [{ kind: 'text', text }],
    createdAt: 1,
    updatedAt: 2,
  };
}

// The server clock only has second resolution, so rows written in the same test
// tick share an updated_at. Backdate explicitly when a delta boundary matters.
async function backdate(articleUrl: string, updatedAt: number) {
  await env.DB.prepare(
    'UPDATE share_drafts SET updated_at = ? WHERE user_did = ? AND article_url = ?'
  )
    .bind(updatedAt, TEST_DID, articleUrl)
    .run();
}

describe('/api/linkblog/drafts', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM share_drafts').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await insertUser(TEST_DID, 'drafts.bsky.social', TEST_SESSION_ID);
    await insertUser(OTHER_DID, 'other.bsky.social', OTHER_SESSION_ID);
  });

  it('returns 401 without a session', async () => {
    const ctx = createExecutionContext();
    const request = new IncomingRequest('http://localhost/api/linkblog/drafts', {
      headers: { Origin: env.FRONTEND_URL },
    });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it('round-trips an upserted draft', async () => {
    const put = await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('hello'),
      updatedAt: 1000,
    });
    expect(put.status).toBe(200);

    const { status, body } = await getDrafts('/api/linkblog/drafts');
    expect(status).toBe(200);
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].articleUrl).toBe('https://example.com/a');
    expect(body.drafts[0].draft?.blocks?.[0].text).toBe('hello');
    expect(body.drafts[0].clientUpdatedAt).toBe(1000);
    expect(body.drafts[0].deletedAt).toBeNull();
  });

  it('never leaks another user’s drafts', async () => {
    await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('mine'),
      updatedAt: 1000,
    });

    const { body } = await getDrafts('/api/linkblog/drafts', OTHER_SESSION_ID);
    expect(body.drafts).toHaveLength(0);
  });

  it('a newer client clock replaces the stored draft', async () => {
    await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('first'),
      updatedAt: 1000,
    });
    await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('second'),
      updatedAt: 2000,
    });

    const { body } = await getDrafts('/api/linkblog/drafts');
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].draft?.blocks?.[0].text).toBe('second');
    expect(body.drafts[0].clientUpdatedAt).toBe(2000);
  });

  it('an older client clock is dropped, not applied (LWW guard)', async () => {
    await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('newer'),
      updatedAt: 5000,
    });
    // The shape an offline queue produces: a write composed before the newer
    // edit but delivered after it.
    const stale = await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('stale'),
      updatedAt: 1000,
    });
    expect(stale.status).toBe(200);
    expect(stale.body.success).toBe(true);

    const { body } = await getDrafts('/api/linkblog/drafts');
    expect(body.drafts[0].draft?.blocks?.[0].text).toBe('newer');
    expect(body.drafts[0].clientUpdatedAt).toBe(5000);
  });

  it('delete tombstones: hidden from the snapshot, replayed in the delta', async () => {
    await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('bye'),
      updatedAt: 1000,
    });
    await backdate('https://example.com/a', 500);

    const del = await mutate('DELETE', {
      articleUrl: 'https://example.com/a',
      updatedAt: 2000,
    });
    expect(del.status).toBe(200);

    const snapshot = await getDrafts('/api/linkblog/drafts');
    expect(snapshot.body.drafts).toHaveLength(0);

    const delta = await getDrafts('/api/linkblog/drafts?since=500');
    expect(delta.body.drafts).toHaveLength(1);
    expect(delta.body.drafts[0].deletedAt).not.toBeNull();
    // A tombstone carries no words.
    expect(delta.body.drafts[0].draft).toBeNull();
  });

  it('deleting a draft that was never pushed succeeds', async () => {
    const del = await mutate('DELETE', { articleUrl: 'https://example.com/never', updatedAt: 1 });
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
  });

  it('a newer write after a delete resurrects the draft', async () => {
    await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('v1'),
      updatedAt: 1000,
    });
    await mutate('DELETE', { articleUrl: 'https://example.com/a', updatedAt: 2000 });
    await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('v2'),
      updatedAt: 3000,
    });

    const { body } = await getDrafts('/api/linkblog/drafts');
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].draft?.blocks?.[0].text).toBe('v2');
    expect(body.drafts[0].deletedAt).toBeNull();
  });

  it('a write queued before a delete does not resurrect it', async () => {
    await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('v1'),
      updatedAt: 1000,
    });
    // Post clears the draft at t=2000; the composer's trailing throttle then
    // fires with the pre-post content it captured at t=1500.
    await mutate('DELETE', { articleUrl: 'https://example.com/a', updatedAt: 2000 });
    await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('late'),
      updatedAt: 1500,
    });

    const { body } = await getDrafts('/api/linkblog/drafts');
    expect(body.drafts).toHaveLength(0);
  });

  it('a stale delete does not destroy a newer edit', async () => {
    await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('newer edit'),
      updatedAt: 5000,
    });
    await mutate('DELETE', { articleUrl: 'https://example.com/a', updatedAt: 1000 });

    const { body } = await getDrafts('/api/linkblog/drafts');
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].draft?.blocks?.[0].text).toBe('newer edit');
  });

  it('paginates with a cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await mutate('PUT', {
        articleUrl: `https://example.com/${i}`,
        draft: draftBody(`draft ${i}`, `https://example.com/${i}`),
        updatedAt: 1000 + i,
      });
      await backdate(`https://example.com/${i}`, 1000 + i);
    }

    const first = await getDrafts('/api/linkblog/drafts?limit=2');
    expect(first.body.drafts).toHaveLength(2);
    expect(first.body.cursor).toBeTruthy();

    const seen = [...first.body.drafts.map((d) => d.articleUrl)];
    let cursor = first.body.cursor;
    while (cursor) {
      const page = await getDrafts(
        `/api/linkblog/drafts?limit=2&cursor=${encodeURIComponent(cursor)}`
      );
      seen.push(...page.body.drafts.map((d) => d.articleUrl));
      cursor = page.body.cursor;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects a malformed or oversized write', async () => {
    expect((await mutate('PUT', { draft: draftBody('x'), updatedAt: 1 })).status).toBe(400);
    expect(
      (await mutate('PUT', { articleUrl: 'https://example.com/a', draft: 'nope', updatedAt: 1 }))
        .status
    ).toBe(400);
    expect(
      (await mutate('PUT', { articleUrl: 'https://example.com/a', draft: draftBody('x') })).status
    ).toBe(400);

    const huge = await mutate('PUT', {
      articleUrl: 'https://example.com/a',
      draft: draftBody('x'.repeat(70 * 1024)),
      updatedAt: 1,
    });
    expect(huge.status).toBe(413);
  });
});
