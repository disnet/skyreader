import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrateLinkblogFollowers } from '../src/routes/linkblog';

const AUTHOR_DID = 'did:plc:linkblog-author';
const FOLLOWER_DID = 'did:plc:linkblog-follower';
const DEFAULT_URI = `at://${AUTHOR_DID}/site.standard.publication/skyreader-links`;
const EXTERNAL_A = `at://${AUTHOR_DID}/site.standard.publication/external-a`;
const EXTERNAL_B = `at://${AUTHOR_DID}/site.standard.publication/external-b`;
const EXTERNAL_C = `at://${AUTHOR_DID}/site.standard.publication/external-c`;

async function insertSubscription(rkey: string, feedUrl: string) {
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache
       (user_did, record_uri, feed_url, title, created_at, source_type, subject_did,
        atmosphere_synced)
     VALUES (?, ?, ?, 'Linkblog', unixepoch(), 'atproto.documents', ?, unixepoch())`
  )
    .bind(
      FOLLOWER_DID,
      `at://${FOLLOWER_DID}/app.skyreader.feed.subscription/${rkey}`,
      feedUrl,
      AUTHOR_DID
    )
    .run();
}

async function subscriptions() {
  const result = await env.DB.prepare(
    `SELECT feed_url, atmosphere_synced, atmosphere_previous_feed_url
     FROM subscriptions_cache WHERE user_did = ? ORDER BY feed_url`
  )
    .bind(FOLLOWER_DID)
    .all<{
      feed_url: string;
      atmosphere_synced: number | null;
      atmosphere_previous_feed_url: string | null;
    }>();
  return result.results;
}

describe('linkblog follower target migration', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM subscriptions_cache WHERE user_did = ?')
      .bind(FOLLOWER_DID)
      .run();
    await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(FOLLOWER_DID).run();
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())`
    )
      .bind(FOLLOWER_DID, 'follower.test', 'https://test.pds.example')
      .run();
  });

  it.each([
    ['default to external', DEFAULT_URI, EXTERNAL_A],
    ['external to external', EXTERNAL_A, EXTERNAL_B],
    ['external to default', EXTERNAL_A, DEFAULT_URI],
  ])('migrates %s from the actual previous target', async (_label, previous, next) => {
    await insertSubscription('source', previous);

    await migrateLinkblogFollowers(env, AUTHOR_DID, previous, next);

    expect(await subscriptions()).toEqual([
      {
        feed_url: next,
        atmosphere_synced: null,
        atmosphere_previous_feed_url: previous,
      },
    ]);
  });

  it('keeps an existing destination row and removes the duplicate source row', async () => {
    await insertSubscription('source', EXTERNAL_A);
    await insertSubscription('destination', EXTERNAL_B);

    await migrateLinkblogFollowers(env, AUTHOR_DID, EXTERNAL_A, EXTERNAL_B);

    expect(await subscriptions()).toEqual([
      {
        feed_url: EXTERNAL_B,
        atmosphere_synced: null,
        atmosphere_previous_feed_url: EXTERNAL_A,
      },
    ]);
  });

  it('preserves the earliest pending URI across back-to-back switches', async () => {
    await insertSubscription('source', EXTERNAL_A);

    await migrateLinkblogFollowers(env, AUTHOR_DID, EXTERNAL_A, EXTERNAL_B);
    await migrateLinkblogFollowers(env, AUTHOR_DID, EXTERNAL_B, EXTERNAL_C);

    expect(await subscriptions()).toEqual([
      {
        feed_url: EXTERNAL_C,
        atmosphere_synced: null,
        atmosphere_previous_feed_url: EXTERNAL_A,
      },
    ]);
  });

  it('transfers the earliest pending URI when deduplicating a later destination', async () => {
    await insertSubscription('source', EXTERNAL_A);

    await migrateLinkblogFollowers(env, AUTHOR_DID, EXTERNAL_A, EXTERNAL_B);
    await insertSubscription('destination', EXTERNAL_C);
    await migrateLinkblogFollowers(env, AUTHOR_DID, EXTERNAL_B, EXTERNAL_C);

    expect(await subscriptions()).toEqual([
      {
        feed_url: EXTERNAL_C,
        atmosphere_synced: null,
        atmosphere_previous_feed_url: EXTERNAL_A,
      },
    ]);
  });
});
