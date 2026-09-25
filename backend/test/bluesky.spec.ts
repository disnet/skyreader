import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { bskyPostUrl, graphemeLength, linkFacets } from '../src/routes/bluesky';
import * as pdsClient from '../src/services/pds-client';
import {
  ALL_POSSIBLE_SCOPES,
  BLUESKY_IMAGE_SCOPES,
  BLUESKY_POST_SCOPES,
  GRANULAR_SCOPES,
} from '../src/config/scopes';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const DID = 'did:plc:blueskyposter';
const SESSION = 'sess-bluesky-post';
const ARTICLE = 'https://example.com/essays/on-reading';
const BLOB = {
  $type: 'blob',
  ref: { $link: 'bafkreitextshot' },
  mimeType: 'image/png',
  size: 48_000,
};

describe('linkFacets', () => {
  it('links the shortened article text to the full URL, byte-indexed', () => {
    const text = 'Café thoughts\n\nexample.com/essays/on-…';
    const facets = linkFacets(text, ARTICLE, 'example.com/essays/on-…');
    expect(facets).toHaveLength(1);
    const bytes = new TextEncoder().encode(text);
    const { byteStart, byteEnd } = facets[0].index;
    expect(new TextDecoder().decode(bytes.slice(byteStart, byteEnd))).toBe(
      'example.com/essays/on-…'
    );
    expect(facets[0].features[0]).toEqual({
      $type: 'app.bsky.richtext.facet#link',
      uri: ARTICLE,
    });
  });

  it('links bare URLs in the commentary, without trailing punctuation', () => {
    const facets = linkFacets('See https://other.example/a.', ARTICLE);
    expect(facets).toHaveLength(1);
    expect(facets[0].features[0].uri).toBe('https://other.example/a');
    expect(facets[0].index).toEqual({ byteStart: 4, byteEnd: 27 });
  });
});

describe('graphemeLength / bskyPostUrl', () => {
  it('counts an emoji sequence as one character', () => {
    expect(graphemeLength('👩‍👩‍👧 hi')).toBe(4);
  });

  it('maps a post URI to its bsky.app page', () => {
    expect(bskyPostUrl(`at://${DID}/app.bsky.feed.post/3abc`)).toBe(
      `https://bsky.app/profile/${DID}/post/3abc`
    );
  });
});

describe('POST /api/v2/bluesky/post', () => {
  let originalFetch: typeof globalThis.fetch;
  let putRecord: ReturnType<typeof vi.fn>;
  let uploadBlob: ReturnType<typeof vi.fn>;

  async function seedSession(grantedScopes = ALL_POSSIBLE_SCOPES) {
    await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
    await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, tier, created_at)
       VALUES (?, 'poster.bsky.social', 'https://pds.test', 'free', unixepoch())`
    )
      .bind(DID)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
       VALUES (?, ?, 'poster.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
    )
      .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, grantedScopes)
      .run();
  }

  function post(body: unknown) {
    return new IncomingRequest('http://localhost/api/v2/bluesky/post', {
      method: 'POST',
      headers: {
        Cookie: `session_id=${SESSION}`,
        Origin: env.FRONTEND_URL,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async function call(request: Request): Promise<{ status: number; body: any }> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  beforeEach(async () => {
    await seedSession();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://example.com/lead.png') {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Type': 'image/png' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;
    putRecord = vi.fn(async (collection: string) => ({
      success: true,
      data: { uri: `at://${DID}/${collection}/3newpost`, cid: 'bafypostcid' },
    }));
    uploadBlob = vi.fn(async () => ({ success: true, data: { blob: { ...BLOB, size: 3 } } }));
    vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue({ putRecord, uploadBlob } as never);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('writes a post with the article’s link card and thumbnail', async () => {
    const result = await call(
      post({
        text: 'Worth your time.',
        articleUrl: ARTICLE,
        title: 'On reading',
        description: 'An essay.',
        imageUrl: 'https://example.com/lead.png',
      })
    );

    expect(result.status).toBe(201);
    expect(result.body.url).toBe(`https://bsky.app/profile/${DID}/post/3newpost`);
    const [collection, , record] = putRecord.mock.calls[0];
    expect(collection).toBe('app.bsky.feed.post');
    expect(record).toMatchObject({
      $type: 'app.bsky.feed.post',
      text: 'Worth your time.',
      embed: {
        $type: 'app.bsky.embed.external',
        external: {
          uri: ARTICLE,
          title: 'On reading',
          description: 'An essay.',
          thumb: { ref: { $link: 'bafkreitextshot' } },
        },
      },
    });
    expect(record.facets).toBeUndefined();
  });

  it('posts a card without a thumbnail when the image cannot be fetched', async () => {
    const result = await call(
      post({ text: '', articleUrl: ARTICLE, imageUrl: 'https://example.com/missing.png' })
    );
    expect(result.status).toBe(201);
    expect(putRecord.mock.calls[0][2].embed.external.thumb).toBeUndefined();
  });

  it('embeds text shots and links the article in the text', async () => {
    const result = await call(
      post({
        text: 'Good bit.\n\nexample.com/essays/on-…',
        linkText: 'example.com/essays/on-…',
        articleUrl: ARTICLE,
        images: [
          { image: BLOB, alt: 'The quoted passage', aspectRatio: { width: 1200, height: 640 } },
        ],
      })
    );

    expect(result.status).toBe(201);
    const record = putRecord.mock.calls[0][2];
    expect(record.embed).toEqual({
      $type: 'app.bsky.embed.images',
      images: [
        { image: BLOB, alt: 'The quoted passage', aspectRatio: { width: 1200, height: 640 } },
      ],
    });
    expect(record.facets).toEqual([
      {
        index: {
          byteStart: 11,
          byteEnd: 11 + new TextEncoder().encode('example.com/essays/on-…').length,
        },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: ARTICLE }],
      },
    ]);
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it('refuses images without the article link in the text', async () => {
    const result = await call(
      post({ text: 'Good bit.', articleUrl: ARTICLE, images: [{ image: BLOB }] })
    );
    expect(result.status).toBe(400);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('refuses text over Bluesky’s 300 characters', async () => {
    const result = await call(post({ text: 'a'.repeat(301), articleUrl: ARTICLE }));
    expect(result.status).toBe(400);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('refuses a malformed image reference', async () => {
    const result = await call(
      post({
        text: 'x example.com/…',
        linkText: 'example.com/…',
        articleUrl: ARTICLE,
        images: [{ image: { ...BLOB, mimeType: 'text/html' } }],
      })
    );
    expect(result.status).toBe(400);
  });

  it('asks for the bluesky permission when the session lacks it', async () => {
    await seedSession(`${GRANULAR_SCOPES} ${BLUESKY_IMAGE_SCOPES.join(' ')}`);
    const result = await call(post({ text: 'Hi', articleUrl: ARTICLE }));
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: 'scope_upgrade_required', feature: 'bluesky' });
  });

  it('needs the blob scope too', async () => {
    await seedSession(`${GRANULAR_SCOPES} ${BLUESKY_POST_SCOPES.join(' ')}`);
    const result = await call(post({ text: 'Hi', articleUrl: ARTICLE }));
    expect(result.status).toBe(403);
  });
});
