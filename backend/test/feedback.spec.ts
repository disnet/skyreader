import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { handleGetFeedback } from '../src/routes/feedback';
import * as pdsClient from '../src/services/pds-client';
import {
  ALL_POSSIBLE_SCOPES,
  GRANULAR_SCOPES,
  USERINPUT_SCOPES,
  USERINPUT_VOTE_SCOPES,
} from '../src/config/scopes';
import type { Env } from '../src/types';

const get = () => new Request('http://localhost/api/v2/feedback');
const discussion = (overrides: Record<string, unknown> = {}) => ({
  uri: 'at://did:plc:alice/app.userinput.discussion/3abc123',
  authorDid: 'did:plc:alice',
  value: {
    title: 'A quieter reading mode',
    body: 'Let the text take up the whole screen.',
    tags: ['feature'],
    createdAt: '2026-09-01T12:00:00Z',
  },
  votes: { up: 8, down: 2, net: 6 },
  replyCount: 3,
  status: { state: 'planned' },
  ...overrides,
});

describe('GET /api/v2/feedback', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await caches.default.delete('http://localhost/api/v2/feedback');
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('getProfiles')) {
        return new Response(
          JSON.stringify({
            profiles: [
              {
                did: 'did:plc:alice',
                handle: 'alice.test',
                displayName: 'Alice',
                avatar: 'https://cdn.test/alice.jpg',
              },
            ],
          })
        );
      }
      return new Response(JSON.stringify({ complete: true, total: 3, posts: [discussion()] }));
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns a stable, hydrated and sorted board payload', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('getProfiles')) {
        return new Response(
          JSON.stringify({
            profiles: [
              {
                did: 'did:plc:alice',
                handle: 'alice.test',
                displayName: 'Alice',
                avatar: 'https://cdn.test/alice.jpg',
              },
            ],
          })
        );
      }
      return new Response(
        JSON.stringify({
          complete: true,
          posts: [
            discussion({
              uri: 'at://did:plc:alice/app.userinput.discussion/newer',
              votes: { up: 2, down: 0, net: 2 },
              value: { title: 'Second', body: '', createdAt: '2026-09-02T12:00:00Z' },
            }),
            discussion(),
          ],
        })
      );
    });
    const response = await handleGetFeedback(get(), env as Env, null);
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][0].toString()).toBe(
      'https://userinput.test/api/board/did:plc:skyreaderfeedback/3mobgsd6d5n27'
    );
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(await response.json()).toEqual({
      spaceUrl: 'https://userinput.test/s/did%3Aplc%3Askyreaderfeedback/3mobgsd6d5n27',
      total: 2,
      complete: true,
      // No space tags configured upstream in this fixture, so the board falls
      // back to the default vocabulary the composer files posts under.
      types: [
        { value: 'bug', label: 'Bug' },
        { value: 'feature', label: 'Feature request' },
        { value: 'question', label: 'Question' },
      ],
      posts: [
        {
          uri: 'at://did:plc:alice/app.userinput.discussion/3abc123',
          url: 'https://userinput.test/d/did%3Aplc%3Aalice/3abc123',
          author: {
            did: 'did:plc:alice',
            handle: 'alice.test',
            displayName: 'Alice',
            avatar: 'https://cdn.test/alice.jpg',
          },
          title: 'A quieter reading mode',
          body: 'Let the text take up the whole screen.',
          tags: ['feature'],
          createdAt: '2026-09-01T12:00:00Z',
          votes: { up: 8, down: 2, net: 6 },
          replyCount: 3,
          status: 'planned',
        },
        expect.objectContaining({ title: 'Second', tags: [], status: 'planned' }),
      ],
    });
  });

  it('excludes moderated posts and defaults missing tags', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          complete: false,
          posts: [
            discussion({ hidden: true }),
            discussion({ banned: true }),
            discussion({
              uri: 'at://did:plc:alice/app.userinput.discussion/visible',
              value: { title: 'Visible', body: '', createdAt: '2026-09-01T12:00:00Z' },
            }),
          ],
        })
      )
    );
    const body = (await (await handleGetFeedback(get(), env as Env, null)).json()) as {
      complete: boolean;
      posts: Array<{ tags: string[] }>;
    };
    expect(body.complete).toBe(false);
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0].tags).toEqual([]);
  });

  it('falls back to the DID when profile hydration fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ complete: true, posts: [discussion()] }))
      )
      .mockResolvedValueOnce(new Response('no', { status: 503 }));
    const body = (await (await handleGetFeedback(get(), env as Env, null)).json()) as {
      posts: Array<{ author: { handle: string } }>;
    };
    expect(body.posts[0].author.handle).toBe('did:plc:alice');
  });

  it.each([
    new Response('upstream broke', { status: 500 }),
    new Response('not json'),
    new Response(JSON.stringify({ posts: {} })),
  ])('maps an invalid upstream response to 502', async (upstream) => {
    fetchMock.mockResolvedValueOnce(upstream);
    const response = await handleGetFeedback(get(), env as Env, null);
    expect(response.status).toBe(502);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=30');
  });

  it('briefly caches upstream failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream broke', { status: 500 }));
    await handleGetFeedback(get(), env as Env, null);
    await handleGetFeedback(get(), env as Env, null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves repeat requests from the edge cache', async () => {
    await handleGetFeedback(get(), env as Env, null);
    await handleGetFeedback(get(), env as Env, null);
    expect(fetchMock).toHaveBeenCalledTimes(2); // board + one profile batch
  });

  it('rejects non-GET methods and missing configuration', async () => {
    expect(
      (await handleGetFeedback(new Request(get(), { method: 'POST' }), env as Env, null)).status
    ).toBe(405);
    expect(
      (await handleGetFeedback(get(), { ...(env as Env), USERINPUT_SPACE_DID: '' }, null)).status
    ).toBe(503);
  });
});

// Posting is a write to the reader's OWN repo — userinput.app has no backend, a
// post is an app.userinput.discussion record. So this covers the record shape
// (a foreign, unversioned lexicon, pinned verbatim), the scope split that keeps
// the board readable for sessions that predate the write scope, and the space
// strong ref, which is the one field a post can't be assembled without.
describe('POST /api/v2/feedback', () => {
  const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
  const DID = 'did:plc:feedbackposter';
  const SESSION = 'sess-feedback-post';
  const SPACE_URI = 'at://did:plc:skyreaderfeedback/app.userinput.space/3mobgsd6d5n27';
  const SPACE_CID = 'bafyspacecid';
  const READ_ONLY_SCOPES = GRANULAR_SCOPES;
  const POST_ONLY_SCOPES = `${GRANULAR_SCOPES} ${USERINPUT_SCOPES.join(' ')}`;

  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let putRecord: ReturnType<typeof vi.fn>;
  let spaceValue: Record<string, unknown>;

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

  function post(body: unknown, withSession = true) {
    return new IncomingRequest('http://localhost/api/v2/feedback', {
      method: 'POST',
      headers: {
        ...(withSession ? { Cookie: `session_id=${SESSION}` } : {}),
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
    await caches.default.delete('http://localhost/api/v2/feedback');
    await caches.default.delete('http://localhost/api/v2/feedback/space');
    await seedSession();
    spaceValue = { $type: 'app.userinput.space', name: 'Skyreader feedback' };
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://plc.directory/')) {
        return new Response(
          JSON.stringify({
            id: 'did:plc:skyreaderfeedback',
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: 'https://space-pds.test',
              },
            ],
          })
        );
      }
      if (url.includes('com.atproto.repo.getRecord')) {
        return new Response(JSON.stringify({ uri: SPACE_URI, cid: SPACE_CID, value: spaceValue }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    putRecord = vi.fn(async (collection: string) => ({
      success: true,
      data: {
        uri: `at://${DID}/${collection}/3newpost`,
        cid: collection === 'app.userinput.discussion' ? 'bafypostcid' : 'bafyvotecid',
      },
    }));
    vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue({ putRecord } as never);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('writes the discussion to the reader’s repo and self-upvotes it', async () => {
    const result = await call(
      post({ title: '  Quieter reading mode  ', body: ' Please ', tags: ['Feature'] })
    );

    expect(result.status).toBe(201);
    const [collection, rkey, record] = putRecord.mock.calls[0];
    expect(collection).toBe('app.userinput.discussion');
    expect(record).toEqual({
      $type: 'app.userinput.discussion',
      space: { uri: SPACE_URI, cid: SPACE_CID },
      title: 'Quieter reading mode',
      body: 'Please',
      tags: ['feature'],
      createdAt: expect.any(String),
    });
    expect(result.body).toEqual({
      uri: `at://${DID}/app.userinput.discussion/3newpost`,
      cid: 'bafypostcid',
      url: `https://userinput.test/d/${encodeURIComponent(DID)}/${rkey}`,
      createdAt: record.createdAt,
      upvoted: true,
    });
    // userinput.app's own composer votes for the post it just made, keyed by the
    // discussion's rkey, so a post starts at one vote rather than zero.
    expect(putRecord.mock.calls[1]).toEqual([
      'app.userinput.upvote',
      rkey,
      {
        $type: 'app.userinput.upvote',
        subject: { uri: `at://${DID}/app.userinput.discussion/3newpost`, cid: 'bafypostcid' },
        createdAt: record.createdAt,
      },
    ]);
  });

  it('drops the cached board so the next read can contain the new post', async () => {
    await caches.default.put(
      'http://localhost/api/v2/feedback',
      new Response(JSON.stringify({ posts: [] }), {
        headers: { 'Cache-Control': 'public, max-age=300', 'Content-Type': 'application/json' },
      })
    );
    await call(post({ title: 'Something' }));
    expect(await caches.default.match('http://localhost/api/v2/feedback')).toBeUndefined();
  });

  it('files posts under the board’s own tags when it configures them', async () => {
    spaceValue = { tags: [{ value: 'defect', label: 'Defect' }] };
    expect((await call(post({ title: 'Typed', tags: ['defect'] }))).status).toBe(201);
    expect((await call(post({ title: 'Untyped', tags: ['feature'] }))).body).toEqual({
      error: 'unknown tag: feature',
    });
  });

  it('posts without the vote scope, and refuses without the write scope', async () => {
    await seedSession(POST_ONLY_SCOPES);
    const unvoted = await call(post({ title: 'No self-vote' }));
    expect(unvoted.status).toBe(201);
    expect(putRecord).toHaveBeenCalledTimes(1);
    // The post landed with zero votes; the page renders that, not an assumed one.
    expect(unvoted.body).toMatchObject({ upvoted: false });

    await seedSession(READ_ONLY_SCOPES);
    const refused = await call(post({ title: 'Refused' }));
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: 'scope_upgrade_required',
      integration: 'userinput',
    });
  });

  it('is requested at login', () => {
    for (const scope of [...USERINPUT_SCOPES, ...USERINPUT_VOTE_SCOPES]) {
      expect(ALL_POSSIBLE_SCOPES).toContain(scope);
    }
  });

  it('needs a session', async () => {
    expect((await call(post({ title: 'Anonymous' }, false))).status).toBe(401);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it.each([
    [{}, 'title is required'],
    // Valid JSON, but not a post: reading a field off any of these used to throw.
    [null, 'title is required'],
    ['a post, honest', 'title is required'],
    [['bug'], 'title is required'],
    [{ title: 'x'.repeat(301) }, 'title is over 300 characters'],
    [{ title: 'ok', body: 'x'.repeat(10001) }, 'body is over 10000 characters'],
    [{ title: 'ok', tags: ['bug', 'feature', 'question'] }, 'at most 2 tags'],
    [{ title: 'ok', tags: ['nonsense'] }, 'unknown tag: nonsense'],
  ])('rejects %j', async (body, error) => {
    const result = await call(post(body));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error });
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON at all', async () => {
    const request = new IncomingRequest('http://localhost/api/v2/feedback', {
      method: 'POST',
      headers: {
        Cookie: `session_id=${SESSION}`,
        Origin: env.FRONTEND_URL,
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    const result = await call(request);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'Invalid JSON body' });
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('does not write when the space record cannot be read', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes('getRecord')
        ? new Response('nope', { status: 500 })
        : new Response(
            JSON.stringify({
              id: 'did:plc:skyreaderfeedback',
              service: [
                {
                  id: '#atproto_pds',
                  type: 'AtprotoPersonalDataServer',
                  serviceEndpoint: 'https://space-pds.test',
                },
              ],
            })
          )
    );
    expect((await call(post({ title: 'Unreachable' }))).status).toBe(502);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('reports a refused self-upvote without failing the post', async () => {
    putRecord.mockImplementationOnce(async (collection: string) => ({
      success: true,
      data: { uri: `at://${DID}/${collection}/3newpost`, cid: 'bafypostcid' },
    }));
    putRecord.mockResolvedValueOnce({ success: false, error: 'InvalidRequest' });
    const result = await call(post({ title: 'Vote refused' }));
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ upvoted: false });
  });

  it('surfaces a refused PDS write as a 502', async () => {
    putRecord.mockResolvedValueOnce({ success: false, error: 'InvalidRequest' });
    const result = await call(post({ title: 'Refused by the PDS' }));
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ error: 'Failed to post feedback' });
  });
});
