import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { createAppPassword, type AppPasswordScope } from '../src/services/app-passwords';
import {
  MAX_PUSH_FEEDS,
  PUSH_SOURCE_TYPE,
  pushFeedUrl,
  renderPushBody,
} from '../src/services/push-feeds';
import { isLocalOnlySubscription, ownsLocalOnlyFeed } from '../src/services/local-only-sources';

// Push feeds (services/push-feeds.ts, routes/push.ts): a reader's own feeds,
// filled by a script or agent with a push-scoped app password.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

let userSeq = 0;
async function createUser(
  tier: 'free' | 'supporter' = 'supporter',
  scope: AppPasswordScope = 'push'
) {
  userSeq++;
  const did = `did:plc:push${userSeq}x${Math.random().toString(36).slice(2, 8)}`;
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, ?, unixepoch())`
  )
    .bind(did, `${did}.test`, 'https://test.pds.example', tier)
    .run();
  const password = (await createAppPassword(env, did, 'Agent', scope))!.password;
  return { did, password };
}
type User = Awaited<ReturnType<typeof createUser>>;

async function push(user: User | { password: string }, body: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest('https://api.skyreader.test/api/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.password}`,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': `10.9.0.${userSeq}`,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function items(feedUrl: string) {
  const rows = await env.DB.prepare(
    'SELECT guid, item_json, published_at FROM feed_items WHERE feed_url = ? ORDER BY seq'
  )
    .bind(feedUrl)
    .all<{ guid: string; item_json: string; published_at: number }>();
  return rows.results.map((r) => ({ ...r, item: JSON.parse(r.item_json) }));
}

describe('push feeds', () => {
  it('makes the feed on the first post and renders Markdown', async () => {
    const user = await createUser();
    const res = await push(user, {
      feed: 'Weekly summary',
      title: 'Week 46',
      markdown: '## Read\n\n- *one*\n- [two](https://example.com/two)',
      author: 'My agent',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'created', feed: { name: 'Weekly summary' } });

    const feedUrl = await pushFeedUrl(user.did, 'Weekly summary');
    expect(feedUrl.startsWith(`push:${user.did}/`)).toBe(true);
    const sub = await env.DB.prepare(
      'SELECT title, source_type, active FROM subscriptions_cache WHERE user_did = ? AND feed_url = ?'
    )
      .bind(user.did, feedUrl)
      .first<{ title: string; source_type: string; active: number }>();
    expect(sub).toEqual({ title: 'Weekly summary', source_type: PUSH_SOURCE_TYPE, active: 1 });

    const [row] = await items(feedUrl);
    expect(row.guid.endsWith(`:${res.body.guid}`)).toBe(true);
    expect(row.item.url).toBe('');
    expect(row.item.author).toBe('My agent');
    expect(row.item.content).toContain('<h2>Read</h2>');
    expect(row.item.content).toContain('<a href="https://example.com/two">two</a>');
    expect(row.item.summary).toContain('one');
  });

  it('keeps one feed per name and ignores a guid it already has', async () => {
    const user = await createUser();
    const first = await push(user, { feed: 'Digest', title: 'A', markdown: 'one', guid: 'g1' });
    expect(first.status).toBe(201);
    expect(first.body.parked).toBe(false);
    // A retry, even with a changed body, adds nothing and changes nothing: the
    // timeline delivers an item once, so an edit would reach only some devices.
    const again = await push(user, { feed: '  digest ', title: 'B', markdown: 'two', guid: 'g1' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'duplicate', feed: { name: 'Digest' } });

    const feedUrl = await pushFeedUrl(user.did, 'Digest');
    const rows = await items(feedUrl);
    expect(rows).toHaveLength(1);
    expect(rows[0].item.content).toContain('one');
    const subs = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM subscriptions_cache WHERE user_did = ?'
    )
      .bind(user.did)
      .first<{ n: number }>();
    expect(subs!.n).toBe(1);
  });

  it('keeps the same guid in two feeds apart', async () => {
    const user = await createUser();
    await push(user, { feed: 'Builds', title: 'A', guid: '2026-11-16' });
    await push(user, { feed: 'Digest', title: 'B', guid: '2026-11-16' });
    const [a] = await items(await pushFeedUrl(user.did, 'Builds'));
    const [b] = await items(await pushFeedUrl(user.did, 'Digest'));
    // Read state is keyed by guid alone, so these must differ.
    expect(a.guid).not.toBe(b.guid);
    expect(a.item.guid).toBe(a.guid);
  });

  it('refuses Markdown that renders past the body cap', async () => {
    const user = await createUser();
    // Under the cap as written, over it once each "&" becomes "&amp;".
    const res = await push(user, { feed: 'F', title: 'x', markdown: '&'.repeat(1_500_000) });
    expect(res.status).toBe(400);
    // Refused before anything was made.
    const sub = await env.DB.prepare('SELECT 1 FROM subscriptions_cache WHERE user_did = ?')
      .bind(user.did)
      .first();
    expect(sub).toBeNull();
  });

  it('says so when the reader has the feed parked', async () => {
    const user = await createUser();
    await push(user, { feed: 'Parked one', title: 'a' });
    await env.DB.prepare('UPDATE subscriptions_cache SET active = 0 WHERE user_did = ?')
      .bind(user.did)
      .run();
    const res = await push(user, { feed: 'Parked one', title: 'b' });
    expect(res.status).toBe(201);
    expect(res.body.parked).toBe(true);
  });

  it('dates a post now when it claims the future', async () => {
    const user = await createUser();
    const before = Date.now();
    await push(user, { feed: 'F', title: 'Later', publishedAt: '2999-01-01T00:00:00Z' });
    const [row] = await items(await pushFeedUrl(user.did, 'F'));
    expect(row.published_at).toBeGreaterThanOrEqual(before);
    expect(row.published_at).toBeLessThanOrEqual(Date.now());
  });

  it('takes only a push-scoped password from a Supporter', async () => {
    for (const scope of ['full', 'highlights'] as const) {
      const res = await push(await createUser('supporter', scope), { feed: 'F', title: 'x' });
      expect(res.status).toBe(401);
    }
    expect((await push({ password: 'aaaa-bbbb-cccc-dddd-eeee' }, {})).status).toBe(401);
    const free = await push(await createUser('free'), { feed: 'F', title: 'x' });
    expect(free.status).toBe(403);
    expect(free.body.code).toBe('upgrade_required');
  });

  it('refuses a post it can’t use', async () => {
    const user = await createUser();
    for (const body of [
      { title: 'no feed' },
      { feed: 'F' },
      { feed: 'F', title: 'x', url: 'javascript:alert(1)' },
      { feed: 'F', title: 'x', markdown: 'a', html: '<p>a</p>' },
      { feed: 'F', title: 'x', publishedAt: 'yesterday' },
      { feed: 'F'.repeat(101), title: 'x' },
      [],
      'not json',
    ]) {
      expect((await push(user, body)).status).toBe(400);
    }
  });

  it(`stops at ${MAX_PUSH_FEEDS} feeds`, async () => {
    const user = await createUser();
    for (let i = 0; i < MAX_PUSH_FEEDS; i++) {
      expect((await push(user, { feed: `Feed ${i}`, title: 'x' })).status).toBe(201);
    }
    const over = await push(user, { feed: 'One more', title: 'x' });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('too_many_feeds');
    // An existing one still takes posts.
    expect((await push(user, { feed: 'Feed 0', title: 'y' })).status).toBe(201);
  });

  it('is private: local-only, and readable only by its owner', async () => {
    const user = await createUser();
    const feedUrl = await pushFeedUrl(user.did, 'Mine');
    expect(isLocalOnlySubscription(feedUrl, null)).toBe(true);
    expect(isLocalOnlySubscription('https://x.test/feed', PUSH_SOURCE_TYPE)).toBe(true);
    expect(await ownsLocalOnlyFeed(env, user.did, feedUrl)).toBe(true);
    expect(await ownsLocalOnlyFeed(env, 'did:plc:someoneelse', feedUrl)).toBe(false);
    expect(await ownsLocalOnlyFeed(env, null, feedUrl)).toBe(false);
  });

  it('passes HTML through for the reader’s sanitizer', () => {
    expect(renderPushBody({ html: '<p>hi</p>' })).toBe('<p>hi</p>');
    expect(renderPushBody({})).toBe('');
  });
});
