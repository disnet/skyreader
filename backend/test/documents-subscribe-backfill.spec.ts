import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ensureLocalDocumentSubscription } from '../src/routes/subscriptions';
import { loadAuthorDocuments } from '../src/services/document-store';
import type { Env, Session } from '../src/types';

const READER = 'did:plc:subscribereader';
const AUTHOR = 'did:plc:linkblogauthor';
const PUBLICATION = `at://${AUTHOR}/site.standard.publication/pub`;
const SESSION = { did: READER } as Session;

/**
 * The author's PDS, holding one document. Everything else the subscribe path
 * touches (profile lookup, linkblog target) degrades to a default on a miss.
 */
function mockAuthorPds(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('plc.directory')) {
      return new Response(
        JSON.stringify({
          id: AUTHOR,
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.example',
            },
          ],
        })
      );
    }
    if (url.includes('listRecords') && url.includes('site.standard.document')) {
      return new Response(
        JSON.stringify({
          records: [
            {
              uri: `at://${AUTHOR}/site.standard.document/first`,
              cid: 'cid-first',
              value: {
                site: PUBLICATION,
                title: 'First post',
                path: '/first',
                publishedAt: '2026-01-01T00:00:00.000Z',
              },
            },
          ],
        })
      );
    }
    if (url.includes('listRecords')) return new Response(JSON.stringify({ records: [] }));
    return new Response('{}', { status: 404 });
  });
}

async function cleanup(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM documents_v2'),
    env.DB.prepare('DELETE FROM collections_v2'),
    env.DB.prepare('DELETE FROM document_authors'),
    env.DB.prepare('DELETE FROM publications_cache_v2'),
    env.DB.prepare('DELETE FROM subscriptions_cache'),
    env.DB.prepare('DELETE FROM users WHERE did = ?').bind(READER),
  ]);
}

describe('subscribing to a linkblog from the Atmosphere button', () => {
  beforeEach(async () => {
    await cleanup();
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url) VALUES (?, 'reader.test', 'https://pds.example')
       ON CONFLICT(did) DO NOTHING`
    )
      .bind(READER)
      .run();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  // Without this, the row lands with nothing behind it and every poll of the new
  // linkblog serves `status:'error'` until the hourly reconcile reaches that
  // author — the window the proxy never had, because it listed on first read.
  it('pulls the author’s back catalogue, not just the subscription row', async () => {
    mockAuthorPds();
    const scheduled: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => scheduled.push(p) } as ExecutionContext;

    await ensureLocalDocumentSubscription(env as Env, SESSION, ctx, PUBLICATION);
    await Promise.all(scheduled);

    const row = await env.DB.prepare(
      `SELECT subject_did FROM subscriptions_cache
        WHERE user_did = ? AND source_type = 'atproto.documents'`
    )
      .bind(READER)
      .first<{ subject_did: string }>();
    expect(row?.subject_did).toBe(AUTHOR);

    expect((await loadAuthorDocuments(env as Env, AUTHOR)).map((d) => d.title)).toEqual([
      'First post',
    ]);
    const author = await env.DB.prepare(
      'SELECT last_listed_at FROM document_authors WHERE author_did = ?'
    )
      .bind(AUTHOR)
      .first<{ last_listed_at: number | null }>();
    expect(author?.last_listed_at).toBeTruthy();
  });
});
