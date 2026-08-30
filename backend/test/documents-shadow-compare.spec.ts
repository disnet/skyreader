import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleDocumentShadowCompare } from '../src/routes/documents';
import { applyDocumentEvent } from '../src/services/document-store';
import type { Env } from '../src/types';

const SECRET = 'test-secret';
const READER = 'did:plc:comparereader';
const AUTHOR_A = 'did:plc:aaaaaaaaaaaaaaaa';
const AUTHOR_B = 'did:plc:bbbbbbbbbbbbbbbb';
const AUTHOR_C = 'did:plc:cccccccccccccccc';
const AUTHORS = [AUTHOR_A, AUTHOR_B, AUTHOR_C];

function testEnv(): Env {
  return { ...env, FEED_PROXY_URL: 'https://proxy.example', FEED_PROXY_SECRET: SECRET } as Env;
}

function compareRequest(body: unknown): Request {
  return new Request('https://api.example/api/internal/documents/shadow-compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': SECRET },
    body: JSON.stringify(body),
  });
}

/** The proxy's answer for whichever authors the route asked about. */
function mockProxy(entryFor: (did: string) => Record<string, unknown> | null): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { authors?: Array<{ did: string }> };
    const authors = (body.authors ?? [])
      .map((a) => entryFor(a.did))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    return new Response(JSON.stringify({ authors }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

async function seed(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url) VALUES (?, 'compare.test', 'https://pds.example')
     ON CONFLICT(did) DO NOTHING`
  )
    .bind(READER)
    .run();
  await env.DB.batch(
    AUTHORS.map((did, i) =>
      env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
         VALUES (?, ?, ?, 'atproto.documents', ?, unixepoch())`
      ).bind(
        READER,
        `at://reader/app.skyreader.feed.subscription/${i}`,
        `at://${did}/site.standard.publication/pub`,
        did
      )
    )
  );
}

async function cleanup(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM documents_v2'),
    env.DB.prepare('DELETE FROM document_authors'),
    env.DB.prepare('DELETE FROM subscriptions_cache'),
    env.DB.prepare('DELETE FROM users WHERE did = ?').bind(READER),
  ]);
}

describe('the shadow-compare cutover gate', () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  // The gate is "every subscribed author agrees", so a single call cannot be it:
  // without a cursor the endpoint compared the same first page forever and any
  // drift behind it was invisible.
  it('walks every subscribed author across pages', async () => {
    mockProxy((did) => ({ did, status: 'ready', documents: [] }));

    const first = (await (
      await handleDocumentShadowCompare(compareRequest({ limit: 2 }), testEnv())
    ).json()) as { compared: number; clean: boolean; cursor: string | null; remaining: number };
    expect(first.compared).toBe(2);
    expect(first.clean).toBe(true);
    expect(first.cursor).toBe(AUTHOR_B);
    expect(first.remaining).toBe(1);

    const second = (await (
      await handleDocumentShadowCompare(
        compareRequest({ limit: 2, cursor: first.cursor }),
        testEnv()
      )
    ).json()) as {
      compared: number;
      cursor: string | null;
      remaining: number;
      scopes: Array<{ did: string }>;
    };
    expect(second.compared).toBe(1);
    expect(second.scopes[0].did).toBe(AUTHOR_C);
    // Null cursor is what tells the operator the walk covered the whole set.
    expect(second.cursor).toBeNull();
    expect(second.remaining).toBe(0);
  });

  it('reports drift for an author on a later page', async () => {
    // AUTHOR_C is the one the proxy holds a document for and D1 does not — the
    // drift a first-page-only compare could never see.
    mockProxy((did) =>
      did === AUTHOR_C
        ? {
            did,
            status: 'ready',
            documents: [
              {
                authorDid: did,
                recordUri: `at://${did}/site.standard.document/only-on-proxy`,
                recordCid: 'cid-proxy',
                siteUri: '',
                title: 'Only on the proxy',
                publishedAt: '2026-01-01T00:00:00.000Z',
                createdAt: '2026-01-01T00:00:00.000Z',
                indexedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          }
        : { did, status: 'ready', documents: [] }
    );

    const firstPage = (await (
      await handleDocumentShadowCompare(compareRequest({ limit: 2 }), testEnv())
    ).json()) as { clean: boolean; cursor: string | null };
    expect(firstPage.clean).toBe(true);

    const lastPage = (await (
      await handleDocumentShadowCompare(
        compareRequest({ limit: 2, cursor: firstPage.cursor }),
        testEnv()
      )
    ).json()) as { clean: boolean; scopes: Array<{ missingInD1: string[] }> };
    expect(lastPage.clean).toBe(false);
    expect(lastPage.scopes[0].missingInD1).toEqual([
      `at://${AUTHOR_C}/site.standard.document/only-on-proxy`,
    ]);
  });

  // An author the proxy silently omits is not agreement, and counting it as such
  // would let the walk report a coverage it never had.
  it('counts an author the proxy did not answer for as drift', async () => {
    await applyDocumentEvent(
      env,
      {
        did: AUTHOR_A,
        commit: {
          operation: 'create',
          collection: 'site.standard.document',
          rkey: 'a',
          cid: 'cid-a',
          record: { title: 'A', path: '/a', publishedAt: '2026-01-01T00:00:00.000Z' },
        },
      },
      new Set([AUTHOR_A])
    );
    mockProxy((did) => (did === AUTHOR_A ? null : { did, status: 'ready', documents: [] }));

    const body = (await (
      await handleDocumentShadowCompare(compareRequest({ limit: 3 }), testEnv())
    ).json()) as {
      compared: number;
      clean: boolean;
      scopes: Array<{ did: string; clean: boolean; error?: string }>;
    };
    expect(body.compared).toBe(3);
    expect(body.clean).toBe(false);
    const missing = body.scopes.find((s) => s.did === AUTHOR_A);
    expect(missing?.clean).toBe(false);
    expect(missing?.error).toBe('No proxy entry returned');
  });

  it('rejects a request without the shared secret', async () => {
    const res = await handleDocumentShadowCompare(
      new Request('https://api.example/api/internal/documents/shadow-compare', { method: 'POST' }),
      testEnv()
    );
    expect(res.status).toBe(401);
  });
});
