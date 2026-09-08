import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleGetFeedback } from '../src/routes/feedback';
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
