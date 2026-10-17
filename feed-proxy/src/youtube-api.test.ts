import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  parseYouTubeFeedUrl,
  uploadsPlaylistId,
  YouTubeFeedSource,
  type YouTubeFetch,
} from './youtube-api';
import { parseFeed } from './feed-parser';
import {
  createApp,
  initDatabase,
  hashUrl,
  releaseYouTubeBackoffs,
  type AppConfig,
  type CacheRow,
} from './app';
import { RobotsPolicy } from './robots';

const CHANNEL_ID = 'UC9RM-iSvTu1uPJb8X5yp3EQ';
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

function playlistItem(videoId: string, title: string, publishedAt?: string) {
  return {
    snippet: {
      title,
      description: `About ${title}`,
      channelTitle: 'Wendover Productions',
      videoOwnerChannelTitle: 'Wendover Productions',
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` } },
      resourceId: { videoId },
    },
    contentDetails: publishedAt ? { videoId, videoPublishedAt: publishedAt } : { videoId },
  };
}

const UPLOADS = {
  items: [
    playlistItem('vid00000001', 'Why Planes <Board> "Slowly" & More', '2026-10-10T12:00:00Z'),
    playlistItem('vid00000002', 'Private video'),
    playlistItem('vid00000003', 'The Economics of Ports', '2026-10-01T12:00:00Z'),
  ],
};

function apiError(status: number, reason: string): Response {
  return Response.json({ error: { code: status, errors: [{ reason }] } }, { status });
}

// An API fake keyed by resource name; records every URL it was asked for.
function fakeApi(
  handlers: Record<string, (params: URLSearchParams) => Response>,
  calls: string[] = []
): YouTubeFetch {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    const resource = u.pathname.split('/').pop()!;
    const handler = handlers[resource];
    return handler ? handler(u.searchParams) : new Response('unexpected', { status: 500 });
  };
}

describe('parseYouTubeFeedUrl', () => {
  it('recognises channel, playlist and user feeds', () => {
    expect(parseYouTubeFeedUrl(FEED_URL)).toEqual({ kind: 'channel', channelId: CHANNEL_ID });
    expect(
      parseYouTubeFeedUrl('https://youtube.com/feeds/videos.xml?playlist_id=PLabc_123-x')
    ).toEqual({ kind: 'playlist', playlistId: 'PLabc_123-x' });
    expect(parseYouTubeFeedUrl('https://www.youtube.com/feeds/videos.xml?user=wendover')).toEqual({
      kind: 'user',
      username: 'wendover',
    });
  });

  it('ignores anything else', () => {
    expect(
      parseYouTubeFeedUrl('https://example.com/feeds/videos.xml?channel_id=' + CHANNEL_ID)
    ).toBeNull();
    expect(parseYouTubeFeedUrl('https://www.youtube.com/@Wendoverproductions')).toBeNull();
    expect(parseYouTubeFeedUrl('https://www.youtube.com/feeds/videos.xml')).toBeNull();
    expect(
      parseYouTubeFeedUrl('https://www.youtube.com/feeds/videos.xml?channel_id=bad')
    ).toBeNull();
    expect(parseYouTubeFeedUrl('not a url')).toBeNull();
  });

  it('maps a channel to its uploads playlist', () => {
    expect(uploadsPlaylistId(CHANNEL_ID)).toBe('UU9RM-iSvTu1uPJb8X5yp3EQ');
  });
});

describe('YouTubeFeedSource', () => {
  it('serves a channel feed from its uploads playlist in one call', async () => {
    const calls: string[] = [];
    const source = new YouTubeFeedSource({
      apiKey: 'k',
      fetch: fakeApi({ playlistItems: () => Response.json(UPLOADS) }, calls),
    });
    const res = await source.fetchFeed({ kind: 'channel', channelId: CHANNEL_ID }, FEED_URL);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const called = new URL(calls[0]);
    expect(called.searchParams.get('playlistId')).toBe('UU9RM-iSvTu1uPJb8X5yp3EQ');
    expect(called.searchParams.get('key')).toBe('k');

    const feed = parseFeed(await res.text(), FEED_URL);
    expect(feed.title).toBe('Wendover Productions');
    expect(feed.siteUrl).toBe(`https://www.youtube.com/channel/${CHANNEL_ID}`);
    // Private video dropped; guids match YouTube's own feed.
    expect(feed.items.map((i) => i.guid)).toEqual(['yt:video:vid00000001', 'yt:video:vid00000003']);
    expect(feed.items[0]).toMatchObject({
      url: 'https://www.youtube.com/watch?v=vid00000001',
      title: 'Why Planes <Board> "Slowly" & More',
      author: 'Wendover Productions',
      publishedAt: '2026-10-10T12:00:00.000Z',
    });
  });

  it('renders the same document for the same answer', async () => {
    const source = new YouTubeFeedSource({
      apiKey: 'k',
      fetch: fakeApi({ playlistItems: () => Response.json(UPLOADS) }),
    });
    const target = { kind: 'channel', channelId: CHANNEL_ID } as const;
    const a = await (await source.fetchFeed(target, FEED_URL)).text();
    const b = await (await source.fetchFeed(target, FEED_URL)).text();
    expect(a).toBe(b);
  });

  it('looks up the title of a channel with no uploads', async () => {
    const source = new YouTubeFeedSource({
      apiKey: 'k',
      fetch: fakeApi({
        playlistItems: () => Response.json({ items: [] }),
        channels: () => Response.json({ items: [{ snippet: { title: 'Quiet Channel' } }] }),
      }),
    });
    const res = await source.fetchFeed({ kind: 'channel', channelId: CHANNEL_ID }, FEED_URL);
    const feed = parseFeed(await res.text(), FEED_URL);
    expect(feed.title).toBe('Quiet Channel');
    expect(feed.items).toEqual([]);
  });

  it('serves a playlist feed with the playlist title', async () => {
    const source = new YouTubeFeedSource({
      apiKey: 'k',
      fetch: fakeApi({
        playlistItems: (p) => {
          expect(p.get('playlistId')).toBe('PLxyz');
          return Response.json(UPLOADS);
        },
        playlists: () =>
          Response.json({
            items: [{ snippet: { title: 'Best Of', channelTitle: 'W', channelId: CHANNEL_ID } }],
          }),
      }),
    });
    const url = 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLxyz';
    const res = await source.fetchFeed({ kind: 'playlist', playlistId: 'PLxyz' }, url);
    const feed = parseFeed(await res.text(), url);
    expect(feed.title).toBe('Best Of');
    expect(feed.siteUrl).toBe('https://www.youtube.com/playlist?list=PLxyz');
    expect(feed.items).toHaveLength(2);
  });

  it('resolves a legacy user feed to its channel', async () => {
    const source = new YouTubeFeedSource({
      apiKey: 'k',
      fetch: fakeApi({
        channels: (p) => {
          expect(p.get('forUsername')).toBe('wendover');
          return Response.json({ items: [{ id: CHANNEL_ID }] });
        },
        playlistItems: (p) => {
          expect(p.get('playlistId')).toBe(uploadsPlaylistId(CHANNEL_ID));
          return Response.json(UPLOADS);
        },
      }),
    });
    const res = await source.fetchFeed({ kind: 'user', username: 'wendover' }, FEED_URL);
    expect(res.status).toBe(200);
  });

  it('serves an empty feed for a real channel with no uploads playlist yet', async () => {
    const source = new YouTubeFeedSource({
      apiKey: 'k',
      fetch: fakeApi({
        playlistItems: () => apiError(404, 'playlistNotFound'),
        channels: () => Response.json({ items: [{ snippet: { title: 'Brand New' } }] }),
      }),
    });
    const res = await source.fetchFeed({ kind: 'channel', channelId: CHANNEL_ID }, FEED_URL);
    expect(res.status).toBe(200);
    expect(parseFeed(await res.text(), FEED_URL).title).toBe('Brand New');
  });

  it('answers 404 for a missing channel or user', async () => {
    const missing = new YouTubeFeedSource({
      apiKey: 'k',
      fetch: fakeApi({
        playlistItems: () => apiError(404, 'playlistNotFound'),
        channels: () => Response.json({ items: [] }),
      }),
    });
    expect(
      (await missing.fetchFeed({ kind: 'channel', channelId: CHANNEL_ID }, FEED_URL)).status
    ).toBe(404);
    const noUser = new YouTubeFeedSource({
      apiKey: 'k',
      fetch: fakeApi({ channels: () => Response.json({ items: [] }) }),
    });
    expect((await noUser.fetchFeed({ kind: 'user', username: 'nobody' }, FEED_URL)).status).toBe(
      404
    );
  });

  it('pauses after the quota runs out, then resumes', async () => {
    let now = 1_000_000;
    let quotaLeft = false;
    const calls: string[] = [];
    const source = new YouTubeFeedSource({
      apiKey: 'k',
      now: () => now,
      quotaPauseMs: 1000,
      fetch: fakeApi(
        {
          playlistItems: () =>
            quotaLeft ? Response.json(UPLOADS) : apiError(403, 'quotaExceeded'),
        },
        calls
      ),
    });
    const target = { kind: 'channel', channelId: CHANNEL_ID } as const;
    expect((await source.fetchFeed(target, FEED_URL)).status).toBe(429);
    expect(source.stats.quotaPausedUntil).toBe(now + 1000);
    // Paused: answered without calling the API.
    expect((await source.fetchFeed(target, FEED_URL)).status).toBe(429);
    expect(calls).toHaveLength(1);
    now += 1001;
    quotaLeft = true;
    expect((await source.fetchFeed(target, FEED_URL)).status).toBe(200);
    expect(source.stats).toEqual({ apiCalls: 2, quotaPausedUntil: null });
  });

  it('answers 503 for a refused key, never a 403 that reads as the site blocking us', async () => {
    const source = new YouTubeFeedSource({
      apiKey: 'k',
      fetch: fakeApi({ playlistItems: () => apiError(400, 'keyInvalid') }),
    });
    const res = await source.fetchFeed({ kind: 'channel', channelId: CHANNEL_ID }, FEED_URL);
    expect(res.status).toBe(503);
  });
});

describe('YouTube feeds through the crawl', () => {
  const SECRET = { 'X-Proxy-Secret': 'test-secret' };
  let fetchMock: ReturnType<typeof spyOn> | undefined;
  afterEach(() => fetchMock?.mockRestore());

  function setup(config: Partial<AppConfig>, db = new Database(':memory:')) {
    initDatabase(db);
    const { app } = createApp(db, {
      proxySecret: 'test-secret',
      cacheTtlMs: 15 * 60 * 1000,
      staleTtlMs: 60 * 60 * 1000,
      defaultLimit: 100,
      ...config,
    });
    return { db, app };
  }
  const row = (db: Database) =>
    db
      .query<
        CacheRow & { error_count: number; next_retry_at: number | null; last_error: string | null },
        [string]
      >('SELECT * FROM cache WHERE url_hash = ?')
      .get(hashUrl(FEED_URL));

  it('answers a YouTube feed from the API, skipping youtube.com and its robots.txt', async () => {
    const direct: string[] = [];
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown) => {
      direct.push(String(url));
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch);
    const robotsCalls: string[] = [];
    const robots = new RobotsPolicy({
      userAgent: 'Skyreader',
      fetch: async (url) => {
        robotsCalls.push(url);
        return new Response('User-agent: *\nDisallow: /');
      },
    });
    const youtube = new YouTubeFeedSource({
      apiKey: 'k',
      minRefreshMs: 45 * 60 * 1000,
      fetch: fakeApi({ playlistItems: () => Response.json(UPLOADS) }),
    });
    const { db, app } = setup({ youtube, robots });

    const before = Date.now();
    const res = await app.request(`/feed?url=${encodeURIComponent(FEED_URL)}`, { headers: SECRET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { feed: { title: string } };
    expect(body.feed.title).toBe('Wendover Productions');
    expect(direct).toEqual([]);
    expect(robotsCalls).toEqual([]);
    // Parked until the next API refresh, which is not an error.
    const r = row(db)!;
    expect(r.error_count).toBe(0);
    expect(r.next_retry_at).toBeGreaterThanOrEqual(before + 45 * 60 * 1000);
  });

  it('records an API failure with its own prefix, keeping the status for the reader UI', async () => {
    const youtube = new YouTubeFeedSource({
      apiKey: 'k',
      fetch: fakeApi({
        playlistItems: () => apiError(404, 'playlistNotFound'),
        channels: () => Response.json({ items: [] }),
      }),
    });
    const { db, app } = setup({ youtube });
    const res = await app.request(`/feed?url=${encodeURIComponent(FEED_URL)}`, { headers: SECRET });
    expect(res.status).toBe(502);
    expect(row(db)!.last_error).toBe('YouTube API: HTTP 404');
  });

  it('releases direct-fetch backoffs on YouTube feeds at boot, but not API ones', () => {
    const db = new Database(':memory:');
    initDatabase(db);
    const later = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const insert = (url: string, error: string | null, errorCount = 1) =>
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
         VALUES (?, ?, '{"title":"","items":[]}', 0, 0, ?, ?, ?)`,
        [hashUrl(url), url, errorCount, error, later]
      );
    const retryAt = (url: string) =>
      db
        .query<{ next_retry_at: number | null }, [string]>(
          'SELECT next_retry_at FROM cache WHERE url_hash = ?'
        )
        .get(hashUrl(url))!.next_retry_at;

    const direct = FEED_URL;
    const robotsBlocked = 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLa';
    const apiFailed = 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLb';
    const parked = 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLc';
    const other = 'https://example.com/feed.xml';
    insert(direct, 'HTTP 404');
    insert(robotsBlocked, 'www.youtube.com is blocking automated access (its robots.txt …)');
    insert(apiFailed, 'YouTube API: HTTP 503');
    insert(parked, null, 0);
    insert(other, 'HTTP 404');

    expect(releaseYouTubeBackoffs(db)).toBe(2);
    expect(retryAt(direct)).toBeNull();
    expect(retryAt(robotsBlocked)).toBeNull();
    expect(retryAt(apiFailed)).toBe(later);
    expect(retryAt(parked)).toBe(later);
    expect(retryAt(other)).toBe(later);
  });

  it('fetches youtube.com directly when no API key is configured', async () => {
    const direct: string[] = [];
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown) => {
      direct.push(String(url));
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch);
    const { db, app } = setup({});
    await app.request(`/feed?url=${encodeURIComponent(FEED_URL)}`, { headers: SECRET });
    expect(direct).toEqual([FEED_URL]);
    expect(row(db)!.last_error).toBe('HTTP 404');
  });
});
