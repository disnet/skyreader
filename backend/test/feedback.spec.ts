import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  handleGetFeedback,
  handleGetFeedbackThread,
  handleGetMyFeedback,
} from '../src/routes/feedback';
import * as pdsClient from '../src/services/pds-client';
import {
  ALL_POSSIBLE_SCOPES,
  GRANULAR_SCOPES,
  USERINPUT_IMAGE_SCOPES,
  USERINPUT_SCOPES,
  USERINPUT_VOTE_SCOPES,
} from '../src/config/scopes';
import type { Env, Session } from '../src/types';

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

  /**
   * The owner's PDS, and the space record on it. The board response's
   * vocabulary comes from here rather than from the copy the board fetch
   * carries inline, so every test in here has to answer these two.
   */
  function spaceLookup(input: RequestInfo | URL, tags: { value: string; label: string }[]) {
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
      return new Response(
        JSON.stringify({
          uri: 'at://did:plc:skyreaderfeedback/app.userinput.space/3mobgsd6d5n27',
          cid: 'bafyspacecid',
          value: { $type: 'app.userinput.space', ...(tags.length > 0 ? { tags } : {}) },
        })
      );
    }
    return null;
  }

  /**
   * The whole world for a vocabulary test: the space record configures `tags`,
   * and the board fetch carries a deliberately different copy inline — which is
   * the only way to tell which of the two the response used.
   */
  function spaceAware(
    input: RequestInfo | URL,
    tags: { value: string; label: string }[]
  ): Response {
    const url = String(input);
    const space = spaceLookup(input, tags);
    if (space) return space;
    if (url.includes('getProfiles')) return new Response(JSON.stringify({ profiles: [] }));
    return new Response(
      JSON.stringify({
        complete: true,
        posts: [discussion()],
        board: { value: { tags: [{ value: 'inline', label: 'Inline' }] } },
      })
    );
  }

  beforeEach(async () => {
    await caches.default.delete('http://localhost/api/v2/feedback');
    // The board response publishes the same space entry a post is validated
    // against, so this path warms that cache too.
    await caches.default.delete('http://localhost/api/v2/feedback/space');
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // This fixture's space configures no tags, so the board falls back to the
      // default vocabulary — the same one it published before the response read
      // the space record at all.
      const space = spaceLookup(input, []);
      if (space) return space;
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
    // The browser gets no copy of its own: a reader who posts and reloads inside
    // the edge cache's five minutes would otherwise never reach the Worker.
    expect(response.headers.get('Cache-Control')).toBe('no-store');
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
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('keeps the five-minute cache at the edge, where posting can bust it', async () => {
    await handleGetFeedback(get(), env as Env, null);
    const stored = await caches.default.match('http://localhost/api/v2/feedback');
    expect(stored?.headers.get('Cache-Control')).toBe('public, max-age=300');
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
    // board + one profile batch + the space lookup's two, all on the first pass.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('publishes the vocabulary a post is validated against', async () => {
    // The board fetch carries its own copy of the space record, but the write
    // path reads the record straight off the owner's PDS and caches it for an
    // hour. Two views of one vocabulary on two clocks is a composer offering a
    // type the write then rejects, so the response serves the write path's copy.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      spaceAware(input, [{ value: 'defect', label: 'Defect' }])
    );
    const response = await handleGetFeedback(get(), env as Env, null);
    expect(((await response.json()) as { types: unknown }).types).toEqual([
      { value: 'defect', label: 'Defect' },
    ]);
  });

  it('falls back to the board’s own copy when the space record can’t be read', async () => {
    // Reading a board needs no space record; only posting to one does. A PDS
    // nobody can reach shouldn't take a healthy board's types with it.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://plc.directory/')) return new Response('nope', { status: 502 });
      return spaceAware(input, [{ value: 'defect', label: 'Defect' }]);
    });
    const response = await handleGetFeedback(get(), env as Env, null);
    expect(((await response.json()) as { types: unknown }).types).toEqual([
      { value: 'inline', label: 'Inline' },
    ]);
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

// Replies live in their authors' repos and reach us through a second upstream
// endpoint, so this covers the shape it returns (moderation flags, a parentUri
// for nesting, no profiles), the DID/rkey validation that keeps a caller from
// steering the upstream path, and the cache.
describe('GET /api/v2/feedback/thread', () => {
  const DID = 'did:plc:alice';
  const RKEY = '3abc123';
  const get = (did = DID, rkey = RKEY) =>
    new Request(
      `http://localhost/api/v2/feedback/thread?did=${encodeURIComponent(did)}&rkey=${encodeURIComponent(rkey)}`
    );
  const reply = (overrides: Record<string, unknown> = {}) => ({
    uri: 'at://did:plc:maintainer/app.userinput.reply/3rep1',
    authorDid: 'did:plc:maintainer',
    value: { body: 'Fixed in the next release.', createdAt: '2026-09-02T12:00:00Z' },
    parentUri: null,
    editedAt: null,
    votes: { up: 1, down: 0, net: 1 },
    hidden: false,
    banned: false,
    ...overrides,
  });

  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await caches.default.delete(
      `http://localhost/api/v2/feedback/thread?did=${encodeURIComponent(DID)}&rkey=${RKEY}`
    );
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('getProfiles')) {
        return new Response(
          JSON.stringify({
            profiles: [
              { did: 'did:plc:maintainer', handle: 'skyreader.app', displayName: 'Skyreader' },
            ],
          })
        );
      }
      return new Response(
        JSON.stringify({
          complete: true,
          modDids: ['did:plc:maintainer'],
          replies: [reply()],
        })
      );
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the replies, hydrated, oldest first', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('getProfiles')) {
        return new Response(JSON.stringify({ profiles: [] }));
      }
      return new Response(
        JSON.stringify({
          complete: true,
          modDids: ['did:plc:maintainer'],
          replies: [
            reply({
              uri: 'at://did:plc:bob/app.userinput.reply/3rep2',
              authorDid: 'did:plc:bob',
              value: { body: 'Seeing this too.', createdAt: '2026-09-03T12:00:00Z' },
              parentUri: 'at://did:plc:maintainer/app.userinput.reply/3rep1',
            }),
            reply(),
          ],
        })
      );
    });
    const response = await handleGetFeedbackThread(get(), env as Env, null);
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][0].toString()).toBe(
      'https://userinput.test/api/thread/did:plc:alice/3abc123'
    );
    // The browser gets no copy of its own, for the same reason the board doesn't.
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      total: 2,
      complete: true,
      replies: [
        expect.objectContaining({
          uri: 'at://did:plc:maintainer/app.userinput.reply/3rep1',
          parentUri: null,
          body: 'Fixed in the next release.',
          // No profile came back, so the DID stands in for the handle.
          author: expect.objectContaining({ handle: 'did:plc:maintainer', mod: true }),
        }),
        expect.objectContaining({
          uri: 'at://did:plc:bob/app.userinput.reply/3rep2',
          parentUri: 'at://did:plc:maintainer/app.userinput.reply/3rep1',
          author: expect.objectContaining({ did: 'did:plc:bob', mod: false }),
        }),
      ],
    });
  });

  it('hydrates profiles and marks the board’s moderators', async () => {
    const body = (await (await handleGetFeedbackThread(get(), env as Env, null)).json()) as {
      replies: Array<{ author: { handle: string; displayName: string | null; mod: boolean } }>;
    };
    expect(body.replies[0].author).toMatchObject({
      handle: 'skyreader.app',
      displayName: 'Skyreader',
      mod: true,
    });
  });

  it('excludes moderated replies', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('getProfiles')) {
        return new Response(JSON.stringify({ profiles: [] }));
      }
      return new Response(
        JSON.stringify({
          complete: true,
          replies: [reply({ hidden: true }), reply({ banned: true }), reply()],
        })
      );
    });
    const body = (await (await handleGetFeedbackThread(get(), env as Env, null)).json()) as {
      total: number;
    };
    expect(body.total).toBe(1);
  });

  it('refuses a did or rkey outside atproto’s own grammar', async () => {
    // These land in an upstream URL path, so nothing but a real record address
    // gets that far.
    for (const [did, rkey] of [
      ['../../etc', RKEY],
      ['not-a-did', RKEY],
      [DID, 'has/slash'],
      [DID, '..'],
      [DID, ''],
    ] as const) {
      expect((await handleGetFeedbackThread(get(did, rkey), env as Env, null)).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches at the edge and maps an upstream failure to 502', async () => {
    await handleGetFeedbackThread(get(), env as Env, null);
    await handleGetFeedbackThread(get(), env as Env, null);
    expect(fetchMock).toHaveBeenCalledTimes(2); // thread + one profile batch

    fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }));
    const response = await handleGetFeedbackThread(get(DID, '3zzz999'), env as Env, null);
    expect(response.status).toBe(502);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

// The notification inbox's poll: the board's own read, filtered to one author
// and reduced to the fields a change shows up in.
describe('GET /api/v2/feedback/mine', () => {
  const session = { did: 'did:plc:alice' } as Session;
  const get = () => new Request('http://localhost/api/v2/feedback/mine');

  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await caches.default.delete('http://localhost/api/v2/feedback');
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('getProfiles')) {
        return new Response(JSON.stringify({ profiles: [] }));
      }
      return new Response(
        JSON.stringify({
          complete: true,
          posts: [
            discussion(),
            discussion({
              uri: 'at://did:plc:bob/app.userinput.discussion/theirs',
              authorDid: 'did:plc:bob',
              value: { title: 'Someone else', createdAt: '2026-09-01T12:00:00Z' },
            }),
          ],
        })
      );
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns only the caller’s posts, reduced to what a diff needs', async () => {
    const response = await handleGetMyFeedback(get(), env as Env, session);
    expect(response.status).toBe(200);
    // Per-caller, so it must never be handed to the next reader from a cache.
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      posts: [
        {
          uri: 'at://did:plc:alice/app.userinput.discussion/3abc123',
          url: 'https://userinput.test/d/did%3Aplc%3Aalice/3abc123',
          title: 'A quieter reading mode',
          status: 'planned',
          replyCount: 3,
        },
      ],
    });
  });

  it('rides the board’s edge cache rather than its own upstream fetch', async () => {
    await handleGetFeedback(new Request('http://localhost/api/v2/feedback'), env as Env, null);
    fetchMock.mockClear();
    await handleGetMyFeedback(get(), env as Env, session);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an unreachable board rather than an empty one', async () => {
    // An empty list would read as "your posts are gone" and, worse, as a
    // baseline: the client would diff the next real board against nothing.
    fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }));
    const response = await handleGetMyFeedback(get(), env as Env, session);
    expect(response.status).toBe(502);
  });

  it('rejects a non-GET', async () => {
    expect(
      (await handleGetMyFeedback(new Request(get(), { method: 'POST' }), env as Env, session))
        .status
    ).toBe(405);
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

  it('matches those tags whatever their casing, and writes the board’s own', async () => {
    // Nothing says a space tag is lower case, and the composer offers its value
    // verbatim — while the request is folded to lower case on the way in, to
    // dedupe. Compared directly, a board that capitalises its tags would have
    // every post to it rejected, including one filed under the type it offered.
    spaceValue = { tags: [{ value: 'Bug', label: 'Bug' }] };
    expect((await call(post({ title: 'Typed', tags: ['Bug'] }))).status).toBe(201);
    expect(putRecord.mock.calls[0][2]).toMatchObject({ tags: ['Bug'] });
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
    for (const scope of [
      ...USERINPUT_SCOPES,
      ...USERINPUT_VOTE_SCOPES,
      ...USERINPUT_IMAGE_SCOPES,
    ]) {
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

  const blob = (overrides: Record<string, unknown> = {}) => ({
    $type: 'blob',
    ref: { $link: 'bafkreiscreenshot' },
    mimeType: 'image/png',
    size: 4096,
    ...overrides,
  });

  it('embeds uploaded images in the record it writes', async () => {
    const result = await call(
      post({
        title: 'Reader crops the last line',
        tags: ['bug'],
        images: [
          { alt: 'The clipped paragraph', image: blob() },
          // No alt is legal — the lexicon only requires the blob.
          { image: blob({ mimeType: 'image/jpeg' }) },
        ],
      })
    );

    expect(result.status).toBe(201);
    const [, , record] = putRecord.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(record.images).toEqual([
      { alt: 'The clipped paragraph', image: blob() },
      { image: blob({ mimeType: 'image/jpeg' }) },
    ]);
  });

  it.each([
    ['a fifth image', Array.from({ length: 5 }, () => ({ image: blob() })), 'at most 4 images'],
    ['a bare string', ['not-a-blob'], 'malformed image attachment'],
    ['a non-blob value', [{ image: { ref: { $link: 'x' } } }], 'malformed image attachment'],
    [
      'an unsupported type',
      [{ image: blob({ mimeType: 'image/avif' }) }],
      'malformed image attachment',
    ],
    ['an over-size blob', [{ image: blob({ size: 1_000_001 }) }], 'malformed image attachment'],
  ])('refuses %s', async (_name, images, error) => {
    const result = await call(post({ title: 'Attachments', tags: ['bug'], images }));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error });
    expect(putRecord).not.toHaveBeenCalled();
  });
});

describe('POST /api/v2/feedback/image', () => {
  const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
  const DID = 'did:plc:feedbackuploader';
  const SESSION = 'sess-feedback-image';
  const IMAGE_SCOPES = `${GRANULAR_SCOPES} ${USERINPUT_SCOPES.join(' ')} ${USERINPUT_IMAGE_SCOPES.join(' ')}`;

  let uploadBlob: ReturnType<typeof vi.fn>;

  async function seedSession(grantedScopes = IMAGE_SCOPES) {
    await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
    await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, tier, created_at)
       VALUES (?, 'uploader.bsky.social', 'https://pds.test', 'free', unixepoch())`
    )
      .bind(DID)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
       VALUES (?, ?, 'uploader.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
    )
      .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, grantedScopes)
      .run();
  }

  function upload(bytes: ArrayBuffer, contentType: string | null, withSession = true) {
    return new IncomingRequest('http://localhost/api/v2/feedback/image', {
      method: 'POST',
      headers: {
        ...(withSession ? { Cookie: `session_id=${SESSION}` } : {}),
        Origin: env.FRONTEND_URL,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body: bytes,
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
    uploadBlob = vi.fn(async () => ({
      success: true,
      data: {
        blob: { $type: 'blob', ref: { $link: 'bafkreiuploaded' }, mimeType: 'image/png', size: 12 },
      },
    }));
    vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue({ uploadBlob } as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it('uploads the bytes to the reader’s own blob store', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = await call(upload(bytes, 'image/png'));

    expect(result.status).toBe(201);
    expect(result.body.blob).toMatchObject({ $type: 'blob', mimeType: 'image/png' });
    // Raw bytes under the file's own type — uploadBlob is not a JSON call.
    const [sent, contentType] = uploadBlob.mock.calls[0] as [ArrayBuffer, string];
    expect(new Uint8Array(sent)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(contentType).toBe('image/png');
  });

  it('refuses a type the lexicon does not accept', async () => {
    const result = await call(upload(new Uint8Array([1]).buffer, 'image/avif'));
    expect(result.status).toBe(415);
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it('refuses an empty or over-size file before it reaches the PDS', async () => {
    expect((await call(upload(new ArrayBuffer(0), 'image/png'))).status).toBe(400);
    expect((await call(upload(new ArrayBuffer(1_000_001), 'image/png'))).status).toBe(413);
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it('stops reading an over-size body rather than holding it', async () => {
    // A chunked body declares no length, so the size rule has to be the read
    // itself: `arrayBuffer()` materializes everything sent before anything can
    // measure it, and this route is twenty a minute per reader.
    const CHUNK = 256 * 1024;
    let pulled = 0;
    const body = new ReadableStream({
      pull(controller) {
        // 10 MB on offer; nothing past the megabyte should ever be asked for.
        if (pulled >= 40) return controller.close();
        pulled++;
        controller.enqueue(new Uint8Array(CHUNK));
      },
    });
    const request = new IncomingRequest('http://localhost/api/v2/feedback/image', {
      method: 'POST',
      headers: {
        Cookie: `session_id=${SESSION}`,
        Origin: env.FRONTEND_URL,
        'Content-Type': 'image/png',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    expect((await call(request)).status).toBe(413);
    expect(uploadBlob).not.toHaveBeenCalled();
    // The fifth chunk is what crosses a megabyte, and the read ends there.
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it('needs a session, and the blob scope on top of the post scope', async () => {
    expect((await call(upload(new Uint8Array([1]).buffer, 'image/png', false))).status).toBe(401);

    // A session that can post but not attach: the composer asks up front so it
    // can hide the control, and this is the backstop behind that.
    await seedSession(`${GRANULAR_SCOPES} ${USERINPUT_SCOPES.join(' ')}`);
    const refused = await call(upload(new Uint8Array([1]).buffer, 'image/png'));
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'scope_upgrade_required' });
    expect(uploadBlob).not.toHaveBeenCalled();
  });
});
