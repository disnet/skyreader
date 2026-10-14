import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { fillExtractedContent } from '../src/services/saved-content';
import type { ExtractedArticle } from '../src/services/feed-proxy-client';

// fillExtractedContent's content_type handling: a background fill leaves a URL
// save's type alone unless the URL turned out to serve a PDF.

const DID = 'did:plc:savedcontentfill';

const article = (over: Partial<ExtractedArticle> = {}): ExtractedArticle => ({
  title: 'T',
  author: null,
  description: null,
  content: '<p>Body.</p>',
  domain: 'example.com',
  image: null,
  published: null,
  wordCount: 1,
  ...over,
});

async function seed(rkey: string, contentType: string) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, content_type, saved_at, created_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'url')`
  )
    .bind(DID, rkey, `at://${DID}/x/${rkey}`, `https://example.com/${rkey}`, contentType, 1, 1)
    .run();
}

async function typeOf(rkey: string) {
  const row = await env.DB.prepare(
    'SELECT content_type FROM saved_articles WHERE user_did = ? AND rkey = ?'
  )
    .bind(DID, rkey)
    .first<{ content_type: string }>();
  return row?.content_type;
}

describe('fillExtractedContent content_type', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
  });

  it('leaves a web page save typed as it was', async () => {
    await seed('aaaaaaaaaaaaa', 'webpage');
    await fillExtractedContent(env, article(), { userDid: DID, rkey: 'aaaaaaaaaaaaa' });
    expect(await typeOf('aaaaaaaaaaaaa')).toBe('webpage');
  });

  it("types the save 'pdf' when the extraction came from a PDF", async () => {
    await seed('bbbbbbbbbbbbb', 'webpage');
    await fillExtractedContent(env, article({ contentType: 'pdf' }), {
      userDid: DID,
      rkey: 'bbbbbbbbbbbbb',
    });
    expect(await typeOf('bbbbbbbbbbbbb')).toBe('pdf');
  });

  it("a PDF wins over setArticleType, which otherwise sets 'article'", async () => {
    await seed('ccccccccccccc', 'url');
    await seed('ddddddddddddd', 'url');
    const c = await env.DB.prepare('SELECT id FROM saved_articles WHERE rkey = ?')
      .bind('ccccccccccccc')
      .first<{ id: number }>();
    const d = await env.DB.prepare('SELECT id FROM saved_articles WHERE rkey = ?')
      .bind('ddddddddddddd')
      .first<{ id: number }>();
    await fillExtractedContent(
      env,
      article({ contentType: 'pdf' }),
      { id: c!.id },
      { setArticleType: true }
    );
    await fillExtractedContent(env, article(), { id: d!.id }, { setArticleType: true });
    expect(await typeOf('ccccccccccccc')).toBe('pdf');
    expect(await typeOf('ddddddddddddd')).toBe('article');
  });
});
