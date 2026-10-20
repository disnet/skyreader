import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';
import { DEV_LOG_AUTHOR_DID, DEV_LOG_PUBLICATION_URI } from '../src/config/dev-log';
import { MAX_SEEN_PER_USER } from '../src/routes/notifications';
import { watchedDocumentAuthors } from '../src/services/document-store';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:notif123';
const OTHER_DID = 'did:plc:notif456';
const SESSIONS: Record<string, string> = {
  [TEST_DID]: 'test-session-notifications',
  [OTHER_DID]: 'test-session-notifications-2',
};

async function setupUser(did: string) {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
  )
    .bind(did, `${did.slice(8)}.bsky.social`, 'https://test.pds.example')
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      SESSIONS[did],
      did,
      `${did.slice(8)}.bsky.social`,
      'https://test.pds.example',
      'test-access-token',
      'test-refresh-token',
      JSON.stringify({ kty: 'EC' }),
      Date.now() + 3600000,
      GRANULAR_SCOPES
    )
    .run();
}

async function call(method: string, path: string, body?: unknown, did = TEST_DID) {
  const headers: Record<string, string> = {
    Origin: env.FRONTEND_URL,
    Cookie: `session_id=${SESSIONS[did]}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe('notification read-state', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM notification_seen').run();
    await env.DB.prepare('DELETE FROM notification_state').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupUser(TEST_DID);
    await setupUser(OTHER_DID);
  });

  it('starts empty and unprimed', async () => {
    const { status, body } = await call('GET', '/api/notifications/seen');
    expect(status).toBe(200);
    expect(body).toEqual({ ids: [], primed: false });
  });

  it('remembers seen ids and the first sync, per account', async () => {
    const posted = await call('POST', '/api/notifications/seen', {
      ids: ['at://did:plc:a/app.bsky.feed.post/1', 'at://did:plc:a/app.bsky.feed.post/1', 'x#2'],
      primed: true,
    });
    expect(posted.status).toBe(200);
    // A second device marking one of them again is a no-op, not an error.
    await call('POST', '/api/notifications/seen', { ids: ['x#2'] });

    const mine = await call('GET', '/api/notifications/seen');
    expect(mine.body.primed).toBe(true);
    expect([...mine.body.ids].sort()).toEqual(['at://did:plc:a/app.bsky.feed.post/1', 'x#2']);

    const theirs = await call('GET', '/api/notifications/seen', undefined, OTHER_DID);
    expect(theirs.body).toEqual({ ids: [], primed: false });
  });

  it('rejects malformed ids', async () => {
    for (const ids of ['nope', [1], [''], ['a'.repeat(513)], Array(201).fill('a')]) {
      const { status } = await call('POST', '/api/notifications/seen', { ids });
      expect(status).toBe(400);
    }
  });

  it('keeps only the newest ids per reader', async () => {
    const now = Date.now();
    const old = Array.from({ length: MAX_SEEN_PER_USER }, (_, i) =>
      env.DB.prepare(
        'INSERT INTO notification_seen (user_did, notification_id, seen_at) VALUES (?, ?, ?)'
      ).bind(TEST_DID, `old-${i}`, now - 100_000 + i)
    );
    await env.DB.batch(old);
    await call('POST', '/api/notifications/seen', { ids: ['new-1'] });

    const { body } = await call('GET', '/api/notifications/seen');
    expect(body.ids).toHaveLength(MAX_SEEN_PER_USER);
    expect(body.ids[0]).toBe('new-1');
    expect(body.ids).not.toContain('old-0');
  });

  it('requires a session', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new IncomingRequest('http://localhost/api/notifications/seen', {
        headers: { Origin: env.FRONTEND_URL },
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });
});

describe('Dev Log updates', () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function insertDocument(rkey: string, site: string, title: string, publishedAt: number) {
    const uri = `at://${DEV_LOG_AUTHOR_DID}/site.standard.document/${rkey}`;
    const record = {
      $type: 'site.standard.document',
      site,
      title,
      description: `About ${title}`,
      path: `/${rkey}`,
      publishedAt: new Date(publishedAt).toISOString(),
    };
    await env.DB.prepare(
      `INSERT INTO documents_v2 (record_uri, author_did, rkey, record_cid, site_uri, published_at, canonical_url, record_json, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        uri,
        DEV_LOG_AUTHOR_DID,
        rkey,
        `cid-${rkey}`,
        site,
        publishedAt,
        `https://skyreader-dev.leaflet.pub/${rkey}`,
        JSON.stringify(record),
        publishedAt
      )
      .run();
    return uri;
  }

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM documents_v2').run();
    await env.DB.prepare('DELETE FROM document_authors').run();
    await env.DB.prepare('DELETE FROM publications_cache_v2').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupUser(TEST_DID);
    const now = Date.now();
    // Listed just now and with fresh publication meta, so the request touches
    // no PDS.
    await env.DB.prepare(
      'INSERT INTO document_authors (author_did, last_listed_at, complete) VALUES (?, ?, 1)'
    )
      .bind(DEV_LOG_AUTHOR_DID, now)
      .run();
    for (const site of [
      DEV_LOG_PUBLICATION_URI,
      `at://${DEV_LOG_AUTHOR_DID}/site.standard.publication/links`,
    ]) {
      await env.DB.prepare(
        `INSERT INTO publications_cache_v2 (publication_uri, base_url, icon, name, theme, fonts, cached_at)
         VALUES (?, ?, NULL, ?, NULL, NULL, ?)`
      )
        .bind(site, 'https://skyreader-dev.leaflet.pub', 'Skyreader Dev Log', now)
        .run();
    }
  });

  it('serves the newest recent Dev Log posts and nothing else of the author', async () => {
    const now = Date.now();
    await insertDocument('3maaaaaaaaaa1', DEV_LOG_PUBLICATION_URI, 'Oldest', now - 40 * DAY);
    await insertDocument('3maaaaaaaaaa2', DEV_LOG_PUBLICATION_URI, 'One', now - 9 * DAY);
    const b = await insertDocument('3maaaaaaaaaa3', DEV_LOG_PUBLICATION_URI, 'Two', now - 5 * DAY);
    const c = await insertDocument(
      '3maaaaaaaaaa4',
      DEV_LOG_PUBLICATION_URI,
      'Three',
      now - 2 * DAY
    );
    const d = await insertDocument('3maaaaaaaaaa5', DEV_LOG_PUBLICATION_URI, 'Four', now - DAY);
    await insertDocument(
      '3maaaaaaaaaa6',
      `at://${DEV_LOG_AUTHOR_DID}/site.standard.publication/links`,
      'A linkblog post',
      now
    );

    const { status, body } = await call('GET', '/api/updates');
    expect(status).toBe(200);
    expect(body.updates.map((u: { uri: string }) => u.uri)).toEqual([d, c, b]);
    expect(body.updates[0]).toMatchObject({
      title: 'Four',
      description: 'About Four',
      url: expect.stringMatching(/^https:\/\//),
    });
  });

  it('is empty when the Dev Log has nothing recent', async () => {
    const { body } = await call('GET', '/api/updates');
    expect(body).toEqual({ updates: [] });
  });

  it('keeps the Dev Log author in the watched set', async () => {
    expect(await watchedDocumentAuthors(env)).toContain(DEV_LOG_AUTHOR_DID);
  });
});
