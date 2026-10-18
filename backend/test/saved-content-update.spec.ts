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

describe('GET /api/saved/updates — in-place edits the list refresh cannot see', () => {
  beforeEach(() => reset());

  function getUpdates(since: number) {
    return new IncomingRequest(`http://localhost/api/saved/updates?since=${since}`, {
      headers: { Cookie: `session_id=${SESSION}`, Origin: env.FRONTEND_URL },
    });
  }

  it('stamps updated_at on a content upgrade and returns the row after it', async () => {
    await call(post({ url: URL, rkey: 'aaaaaaaaaaaaa', content: '<p>Stub</p>' }));
    expect((await getRow()).updated_at).toBeNull();

    const before = await call(getUpdates(0));
    expect(before.status).toBe(200);
    expect(before.body.articles).toEqual([]);
    const mark = before.body.next as number;

    await call(
      post({
        url: URL,
        rkey: 'bbbbbbbbbbbbb',
        updateContent: true,
        title: 'Full',
        content: '<p>Full</p>',
      })
    );
    const row = await getRow();
    expect(row.updated_at).toBeGreaterThanOrEqual(mark);

    const after = await call(getUpdates(mark - 1));
    expect(after.body.more).toBe(false);
    expect(after.body.articles).toHaveLength(1);
    const item = after.body.articles[0];
    expect(item.rkey).toBe('aaaaaaaaaaaaa');
    expect(item.title).toBe('Full');
    expect(item.updatedAt).toBe(new Date(row.updated_at).toISOString());
    expect(item).not.toHaveProperty('content');

    // The mark trails the clock by a safety margin, so a just-made edit is
    // offered again (the client skips it by updatedAt) rather than risked.
    expect(after.body.next).toBeLessThan(row.updated_at);
    const again = await call(getUpdates(after.body.next));
    expect(again.body.articles.map((a: any) => a.rkey)).toEqual(['aaaaaaaaaaaaa']);

    // Once the edit is older than the margin it drops out.
    const later = await call(getUpdates(row.updated_at));
    expect(later.body.articles).toEqual([]);
  });

  it('exposes updatedAt on the list endpoint', async () => {
    await call(post({ url: URL, rkey: 'aaaaaaaaaaaaa', content: '<p>Stub</p>' }));
    await call(
      post({ url: URL, rkey: 'bbbbbbbbbbbbb', updateContent: true, content: '<p>Full</p>' })
    );
    const res = await call(
      new IncomingRequest('http://localhost/api/saved', {
        headers: { Cookie: `session_id=${SESSION}`, Origin: env.FRONTEND_URL },
      })
    );
    expect(res.body.articles[0].updatedAt).toEqual(expect.any(String));
  });
});

// A URL that served a PDF is saved with its reflowed text and typed 'pdf', so the
// reader (and later citation export) can tell it apart from a web page.
describe('POST /api/saved — content type of a URL save', () => {
  beforeEach(() => reset());

  it("types a PDF extraction 'pdf'", async () => {
    const { status } = await call(
      post({ url: URL, rkey: 'aaaaaaaaaaaaa', contentType: 'pdf', content: '<p>Text.</p>' })
    );
    expect(status).toBe(200);
    expect((await getRow()).content_type).toBe('pdf');
  });

  it("types anything else 'webpage', ignoring an unknown contentType", async () => {
    await call(post({ url: URL, rkey: 'aaaaaaaaaaaaa', contentType: 'article' }));
    expect((await getRow()).content_type).toBe('webpage');
  });

  it("re-types a save 'pdf' when an upgrade turns out to be a PDF, and only then", async () => {
    await call(post({ url: URL, rkey: 'aaaaaaaaaaaaa', content: '<p>Could not fetch</p>' }));

    await call(
      post({ url: URL, rkey: 'bbbbbbbbbbbbb', updateContent: true, content: '<p>Better</p>' })
    );
    expect((await getRow()).content_type).toBe('webpage');

    await call(
      post({
        url: URL,
        rkey: 'ccccccccccccc',
        updateContent: true,
        contentType: 'pdf',
        content: '<p>PDF text</p>',
      })
    );
    expect((await getRow()).content_type).toBe('pdf');
  });

  it("re-types a 'pdf' save as a web page when an HTML body replaces it", async () => {
    await call(
      post({ url: URL, rkey: 'aaaaaaaaaaaaa', contentType: 'pdf', content: '<p>PDF text</p>' })
    );

    // A metadata-only upgrade leaves the PDF's body, and its type, alone.
    await call(post({ url: URL, rkey: 'bbbbbbbbbbbbb', updateContent: true, title: 'Paper' }));
    expect((await getRow()).content_type).toBe('pdf');

    await call(
      post({ url: URL, rkey: 'ccccccccccccc', updateContent: true, content: '<p>Landing</p>' })
    );
    expect((await getRow()).content_type).toBe('webpage');
  });
});

describe('POST /api/saved — the page’s declared DOI', () => {
  beforeEach(() => reset());

  it('stores a DOI on a URL save, and keeps it when an upgrade names none', async () => {
    await call(
      post({
        url: URL,
        rkey: 'aaaaaaaaaaaaa',
        content: '<p>Text</p>',
        doi: '10.1145/3290605.3300233',
      })
    );
    expect((await getRow()).doi).toBe('10.1145/3290605.3300233');

    await call(
      post({ url: URL, rkey: 'bbbbbbbbbbbbb', updateContent: true, content: '<p>Better</p>' })
    );
    expect((await getRow()).doi).toBe('10.1145/3290605.3300233');

    await call(
      post({
        url: URL,
        rkey: 'ccccccccccccc',
        updateContent: true,
        content: '<p>Best</p>',
        doi: '10.1145/3290605.3300234',
      })
    );
    expect((await getRow()).doi).toBe('10.1145/3290605.3300234');
  });

  it('stores it on a feed save', async () => {
    await call(
      post({ url: URL, rkey: 'aaaaaaaaaaaaa', fromFeed: true, itemGuid: 'g1', doi: '10.1000/xyz' })
    );
    expect((await getRow()).doi).toBe('10.1000/xyz');
  });

  it('drops anything that is not a DOI and nothing more', async () => {
    for (const [i, doi] of [
      'see 10.1000/xyz',
      '10.1000/xyz.',
      'https://doi.org/10.1000/xyz',
      `10.1000/${'x'.repeat(400)}`,
      42,
    ].entries()) {
      await reset();
      await call(post({ url: URL, rkey: `aaaaaaaaaaaa${i}`, content: '<p>Text</p>', doi }));
      expect((await getRow()).doi).toBeNull();
    }
  });
});
