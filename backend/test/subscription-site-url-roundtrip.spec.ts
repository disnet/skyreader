import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { syncSubscriptions } from '../src/services/subscription-sync';
import { upsertSubscriptionFromRecord } from '../src/durable-objects/jetstream-poller';
import type { Session } from '../src/types';

// A linkblog connected to an existing publication has an arbitrary rkey, so
// `subscriptions_cache.site_url` (the author's public linkblog page) is the only
// durable tell that a followed publication is a linkblog. It has to survive the
// full loop: D1 → PDS record → Jetstream commit → D1. Drop it at either end and
// the follower's source pill silently reverts to "Blog" one sync later — for
// exactly the Atmospheric-sync users the follower migration back-fills it for.

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const TEST_DID = 'did:plc:sitrurlreader';
const AUTHOR_DID = 'did:plc:sitrurlauthor';
const COLLECTION = 'app.skyreader.feed.subscription';
const RECORD_URI = `at://${TEST_DID}/${COLLECTION}/linkblogfollow1`;
const PUBLICATION = `at://${AUTHOR_DID}/site.standard.publication/leaflet-essays`;
const LINKBLOG_PAGE = `https://linkblogs.skyreader.app/${AUTHOR_DID}/`;

function createTestSession(): Session {
  return {
    did: TEST_DID,
    handle: 'reader.bsky.social',
    pdsUrl: 'https://test.pds.example',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    dpopPrivateKey: JSON.stringify(TEST_DPOP_KEY),
    expiresAt: Date.now() + 3600000,
  };
}

async function insertFollow(overrides?: { siteUrl?: string | null }) {
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache
       (user_did, record_uri, feed_url, title, site_url, category, created_at, source_type,
        subject_did, active, atmosphere_previous_feed_url, atmosphere_synced)
     VALUES (?, ?, ?, 'Author''s links', ?, 'Reading', unixepoch(), 'atproto.documents', ?, 0, ?, unixepoch())`
  )
    .bind(
      TEST_DID,
      RECORD_URI,
      PUBLICATION,
      overrides?.siteUrl === undefined ? LINKBLOG_PAGE : overrides.siteUrl,
      AUTHOR_DID,
      `at://${AUTHOR_DID}/site.standard.publication/skyreader-links`
    )
    .run();
}

async function readFollow() {
  return env.DB.prepare(
    `SELECT feed_url, title, site_url, category, active, atmosphere_previous_feed_url
     FROM subscriptions_cache WHERE record_uri = ?`
  )
    .bind(RECORD_URI)
    .first<{
      feed_url: string;
      title: string | null;
      site_url: string | null;
      category: string | null;
      active: number;
      atmosphere_previous_feed_url: string | null;
    }>();
}

describe('subscription siteUrl round-trip', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await env.DB.prepare('DELETE FROM subscriptions_cache WHERE user_did = ?').bind(TEST_DID).run();
    await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(TEST_DID).run();
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())`
    )
      .bind(TEST_DID, 'reader.bsky.social', 'https://test.pds.example')
      .run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('pushes siteUrl and category to the PDS record', async () => {
    await insertFollow();

    let written: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('listRecords')) {
        return { ok: true, headers: new Headers(), json: async () => ({ records: [] }) };
      }
      if (url.includes('applyWrites')) {
        const body = JSON.parse(String(init?.body)) as {
          writes: Array<{ value: Record<string, unknown> }>;
        };
        written = body.writes[0]?.value;
        return {
          ok: true,
          headers: new Headers(),
          json: async () => ({
            commit: { cid: 'bafycommit', rev: 'rev1' },
            results: [{ uri: RECORD_URI, cid: 'bafyreipushed' }],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await syncSubscriptions(createTestSession(), env);

    expect(result.success).toBe(true);
    expect(written?.siteUrl).toBe(LINKBLOG_PAGE);
    expect(written?.category).toBe('Reading');
  });

  it('keeps site_url and pending migration state when Jetstream mirrors the commit back', async () => {
    await insertFollow();

    // The record as it comes off the firehose for a device that pushed before the
    // column existed: no siteUrl at all.
    await upsertSubscriptionFromRecord(env.DB, TEST_DID, RECORD_URI, {
      $type: COLLECTION,
      feedUrl: PUBLICATION,
      title: "Author's links",
      sourceType: 'atproto.documents',
      subjectDid: AUTHOR_DID,
      createdAt: new Date().toISOString(),
    });

    const row = await readFollow();
    expect(row?.site_url).toBe(LINKBLOG_PAGE);
    // The superseded follow edge still has to be deleted by the Atmosphere
    // reconcile, and a parked feed must not silently reactivate.
    expect(row?.atmosphere_previous_feed_url).toBe(
      `at://${AUTHOR_DID}/site.standard.publication/skyreader-links`
    );
    expect(row?.active).toBe(0);
  });

  it('takes the record siteUrl when it carries one, and mirrors changed fields', async () => {
    await insertFollow({ siteUrl: null });

    await upsertSubscriptionFromRecord(env.DB, TEST_DID, RECORD_URI, {
      $type: COLLECTION,
      feedUrl: PUBLICATION,
      title: 'Renamed',
      siteUrl: LINKBLOG_PAGE,
      category: 'Links',
      sourceType: 'atproto.documents',
      subjectDid: AUTHOR_DID,
      createdAt: new Date().toISOString(),
    });

    const row = await readFollow();
    expect(row?.site_url).toBe(LINKBLOG_PAGE);
    expect(row?.title).toBe('Renamed');
    expect(row?.category).toBe('Links');
  });

  it('inserts a row, with its siteUrl, for a record it has never seen', async () => {
    await upsertSubscriptionFromRecord(env.DB, TEST_DID, RECORD_URI, {
      $type: COLLECTION,
      feedUrl: PUBLICATION,
      title: "Author's links",
      siteUrl: LINKBLOG_PAGE,
      sourceType: 'atproto.documents',
      subjectDid: AUTHOR_DID,
      createdAt: new Date().toISOString(),
    });

    const row = await readFollow();
    expect(row?.feed_url).toBe(PUBLICATION);
    expect(row?.site_url).toBe(LINKBLOG_PAGE);
    expect(row?.active).toBe(1);
  });
});
