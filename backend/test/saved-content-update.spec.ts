import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';
import { getLimitsForTier } from '../src/config/tier-limits';

// Route-level coverage for the updateContent flag on POST /api/saved: a re-save
// of an already-saved URL carrying fresh content upgrades the existing row in
// place (browser-extension live-DOM extraction beating a paywall stub) instead
// of returning 409.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:savedupdate';
const SESSION = 'sess-saved-update';
const URL = 'https://example.com/paywalled-article';

async function reset() {
  await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'su.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'su.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, GRANULAR_SCOPES)
    .run();
}

function post(body: unknown) {
  return new IncomingRequest('http://localhost/api/saved', {
    method: 'POST',
    headers: {
      Cookie: `session_id=${SESSION}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function call(req: Request): Promise<{ status: number; body: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function getRow() {
  return env.DB.prepare('SELECT * FROM saved_articles WHERE user_did = ? AND url = ?')
    .bind(DID, URL)
    .first<any>();
}

describe('POST /api/saved — updateContent upgrade of an existing save', () => {
  beforeEach(() => reset());

  it('still returns 409 for a duplicate without the flag', async () => {
    await call(post({ url: URL, rkey: 'aaaaaaaaaaaaa', title: 'Stub' }));
    const { status, body } = await call(
      post({ url: URL, rkey: 'bbbbbbbbbbbbb', content: '<p>Full text</p>' })
    );
    expect(status).toBe(409);
    expect(body.error).toBe('Article already saved');
  });

  it('returns 409 with the flag but no content (nothing to upgrade)', async () => {
    await call(post({ url: URL, rkey: 'aaaaaaaaaaaaa' }));
    const { status } = await call(
      post({ url: URL, rkey: 'bbbbbbbbbbbbb', updateContent: true, title: 'Better title only' })
    );
    expect(status).toBe(409);
  });

  it('upgrades content in place, keeping the original rkey', async () => {
    const first = await call(
      post({ url: URL, rkey: 'aaaaaaaaaaaaa', title: 'Stub', content: '<p>Subscribe to read</p>' })
    );
    expect(first.status).toBe(200);

    const { status, body } = await call(
      post({
        url: URL,
        rkey: 'bbbbbbbbbbbbb',
        updateContent: true,
        title: 'Full Title',
        author: 'Jane Writer',
        content: '<p>The whole article body.</p>',
        wordCount: 5,
        publishedAt: '2026-01-02T03:04:05.000Z',
      })
    );
    expect(status).toBe(200);
    expect(body.updated).toBe(true);
    expect(body.rkey).toBe('aaaaaaaaaaaaa'); // the existing save, not the new rkey

    const row = await getRow();
    expect(row.rkey).toBe('aaaaaaaaaaaaa');
    expect(row.title).toBe('Full Title');
    expect(row.author).toBe('Jane Writer');
    expect(row.content).toBe('<p>The whole article body.</p>');
    expect(row.word_count).toBe(5);
    expect(row.published_at).toBe(Date.parse('2026-01-02T03:04:05.000Z'));

    // Exactly one row — no second save was created.
    const count = await env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM saved_articles WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ cnt: number }>();
    expect(count!.cnt).toBe(1);
  });

  it('never blanks existing metadata with missing fields (COALESCE new-wins)', async () => {
    await call(
      post({
        url: URL,
        rkey: 'aaaaaaaaaaaaa',
        title: 'Original Title',
        author: 'Original Author',
        image: 'https://example.com/og.png',
      })
    );

    const { status } = await call(
      post({
        url: URL,
        rkey: 'bbbbbbbbbbbbb',
        updateContent: true,
        content: '<p>Body only, no metadata.</p>',
      })
    );
    expect(status).toBe(200);

    const row = await getRow();
    expect(row.content).toBe('<p>Body only, no metadata.</p>');
    expect(row.title).toBe('Original Title');
    expect(row.author).toBe('Original Author');
    expect(row.image).toBe('https://example.com/og.png');
  });

  it('does not count against the monthly URL-save limit', async () => {
    // The update path returns before the limit check; pin that by exhausting
    // the limit artificially and confirming updates still succeed.
    await call(post({ url: URL, rkey: 'aaaaaaaaaaaaa', content: '<p>Stub</p>' }));

    // Fill the month with url saves up to the free-tier cap.
    const limit = getLimitsForTier('free').maxUrlSavesPerMonth;
    for (let i = 1; i < limit; i++) {
      await env.DB.prepare(
        `INSERT INTO saved_articles (user_did, rkey, record_uri, url, source, saved_at, created_at)
         VALUES (?, ?, ?, ?, 'url', ?, ?)`
      )
        .bind(
          DID,
          `filler${i}xxxxxxx`,
          `at://${DID}/app.skyreader.feed.saved/filler${i}`,
          `https://example.com/filler-${i}`,
          Date.now(),
          Date.now()
        )
        .run();
    }

    // A fresh save is over the limit…
    const fresh = await call(
      post({ url: 'https://example.com/new-article', rkey: 'ccccccccccccc' })
    );
    expect(fresh.status).toBe(403);
    expect(fresh.body.error).toBe('url_save_limit_reached');

    // …but a content upgrade of an existing save still goes through.
    const upgrade = await call(
      post({ url: URL, rkey: 'ddddddddddddd', updateContent: true, content: '<p>Full</p>' })
    );
    expect(upgrade.status).toBe(200);
    expect(upgrade.body.updated).toBe(true);
  });
});
