// YouTube feeds via the YouTube Data API v3.
//
// Why: youtube.com/feeds/videos.xml answers 404 to requests from cloud and
// datacenter IPs (ours included) while the same URL works from a browser, so
// fetched directly a YouTube subscription never loads. The Data API is the
// supported way to read a channel's uploads from a server.
//
// Shape: the crawl keeps treating these as ordinary feeds. A subscription stays
// keyed by its youtube.com/feeds/videos.xml URL; on fetch we ask the API instead
// and hand the crawl an Atom document in YouTube's own feed format, so the
// parser, body-hash fast path, item log and ingest push all run unchanged, and
// item guids (`yt:video:<id>`) match what a direct fetch produced. Nothing
// about youtube.com is fetched here, so robots.txt does not apply.
//
// Quota: the default project allowance is 10,000 units a day, and every call
// made here is a 1-unit list call. A channel feed costs 1 unit per refresh
// (its uploads playlist), a playlist feed 2 (items + title), a legacy `user=`
// feed 3 (resolve the username first). The crawl refreshes feeds every ~15 min,
// which would spend ~100 units per channel per day, so API-backed feeds are
// refreshed at most once per `minRefreshMs` (45 min by default: 32 units per
// channel per day, ~300 channels). Keep it under the crawl-cycle warning
// threshold (WARM_TARGET_CYCLE, 1h by default): a feed waiting out its refresh
// still counts toward the observed cycle the moment it comes due. When the quota runs out anyway, calls stop
// for `quotaPauseMs` and fetches answer 429, which the crawl backs off on like
// any transient failure.
import { safeFetch } from './ssrf-guard';

export type YouTubeFeedTarget =
  | { kind: 'channel'; channelId: string }
  | { kind: 'playlist'; playlistId: string }
  | { kind: 'user'; username: string };

const YOUTUBE_FEED_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com']);
const YOUTUBE_FEED_PATH = '/feeds/videos.xml';
const API_BASE = 'https://www.googleapis.com/youtube/v3';
// YouTube's own feed lists the 15 newest videos.
const MAX_VIDEOS = 15;
const API_TIMEOUT_MS = 15 * 1000;
export const DEFAULT_MIN_REFRESH_MS = 45 * 60 * 1000;
const DEFAULT_QUOTA_PAUSE_MS = 60 * 60 * 1000;

// Channel IDs are `UC` + 22 base64url chars; playlist IDs vary in length.
const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const PLAYLIST_ID_RE = /^[\w-]{2,64}$/;
const USERNAME_RE = /^[\w.-]{1,100}$/;

/** The YouTube feed a URL names, or null when it isn't a YouTube feed URL. */
export function parseYouTubeFeedUrl(url: string): YouTubeFeedTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!YOUTUBE_FEED_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  if (parsed.pathname !== YOUTUBE_FEED_PATH) return null;
  const channelId = parsed.searchParams.get('channel_id');
  if (channelId) return CHANNEL_ID_RE.test(channelId) ? { kind: 'channel', channelId } : null;
  const playlistId = parsed.searchParams.get('playlist_id');
  if (playlistId) return PLAYLIST_ID_RE.test(playlistId) ? { kind: 'playlist', playlistId } : null;
  const username = parsed.searchParams.get('user');
  if (username) return USERNAME_RE.test(username) ? { kind: 'user', username } : null;
  return null;
}

/** A channel's uploads playlist: `UC…` → `UU…`. */
export function uploadsPlaylistId(channelId: string): string {
  return `UU${channelId.slice(2)}`;
}

export type YouTubeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface YouTubeFeedSourceOptions {
  apiKey: string;
  fetch?: YouTubeFetch;
  minRefreshMs?: number;
  quotaPauseMs?: number;
  now?: () => number;
}

interface ApiVideo {
  videoId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl?: string;
  description?: string;
}

interface FeedHeader {
  id: string;
  title: string;
  alternateUrl: string;
  authorName: string;
  authorUrl: string;
}

// An API answer we turn into a feed-fetch status instead of a feed.
class ApiStatus extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export class YouTubeFeedSource {
  readonly minRefreshMs: number;
  private readonly apiKey: string;
  private readonly fetchImpl: YouTubeFetch;
  private readonly quotaPauseMs: number;
  private readonly now: () => number;
  private quotaPausedUntil = 0;
  private apiCalls = 0;

  constructor(opts: YouTubeFeedSourceOptions) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? ((url, init) => safeFetch(url, init));
    this.minRefreshMs = opts.minRefreshMs ?? DEFAULT_MIN_REFRESH_MS;
    this.quotaPauseMs = opts.quotaPauseMs ?? DEFAULT_QUOTA_PAUSE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** For /stats. */
  get stats(): { apiCalls: number; quotaPausedUntil: number | null } {
    return {
      apiCalls: this.apiCalls,
      quotaPausedUntil: this.quotaPausedUntil > this.now() ? this.quotaPausedUntil : null,
    };
  }

  /**
   * Fetch a YouTube feed through the API, answered as the HTTP response a direct
   * fetch of `feedUrl` would have been: 200 with an Atom body, 404 when the
   * channel or playlist doesn't exist, 429 while the quota is exhausted, 503 for
   * any other API refusal (a bad key is our fault, not the feed's). Network
   * failures throw, as a direct fetch would.
   */
  async fetchFeed(target: YouTubeFeedTarget, feedUrl: string): Promise<Response> {
    if (this.now() < this.quotaPausedUntil) {
      return statusResponse(429, 'YouTube API quota exhausted');
    }
    try {
      const atom = await this.buildAtom(target, feedUrl);
      return new Response(atom, {
        status: 200,
        headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' },
      });
    } catch (error) {
      if (error instanceof ApiStatus) return statusResponse(error.status, error.message);
      throw error;
    }
  }

  private async buildAtom(target: YouTubeFeedTarget, feedUrl: string): Promise<string> {
    if (target.kind === 'playlist') {
      const [videos, header] = await Promise.all([
        this.playlistVideos(target.playlistId),
        this.playlistHeader(target.playlistId),
      ]);
      return renderAtom(feedUrl, header, videos);
    }
    const channelId =
      target.kind === 'channel' ? target.channelId : await this.channelIdForUser(target.username);
    // A channel that has never uploaded may have no uploads playlist yet; that
    // 404 isn't the channel's. channelTitle below decides whether it exists.
    const videos = await this.playlistVideos(uploadsPlaylistId(channelId)).catch((error) => {
      if (error instanceof ApiStatus && error.status === 404) return [];
      throw error;
    });
    // The channel's name rides on every upload; only an empty channel needs
    // the extra lookup.
    const channelTitle = videos[0]?.channelTitle ?? (await this.channelTitle(channelId));
    const channelUrl = `https://www.youtube.com/channel/${channelId}`;
    return renderAtom(
      feedUrl,
      {
        id: `yt:channel:${channelId.slice(2)}`,
        title: channelTitle,
        alternateUrl: channelUrl,
        authorName: channelTitle,
        authorUrl: channelUrl,
      },
      videos
    );
  }

  private async playlistVideos(playlistId: string): Promise<ApiVideo[]> {
    const body = await this.call('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: String(MAX_VIDEOS),
    });
    const videos: ApiVideo[] = [];
    for (const item of arrayOf(body.items)) {
      const snippet = item?.snippet ?? {};
      const videoId = str(item?.contentDetails?.videoId) ?? str(snippet.resourceId?.videoId);
      // Private and deleted videos stay in a playlist with no publish date.
      const publishedAt = str(item?.contentDetails?.videoPublishedAt);
      if (!videoId || !publishedAt) continue;
      videos.push({
        videoId,
        title: str(snippet.title) ?? 'Untitled',
        channelTitle: str(snippet.videoOwnerChannelTitle) ?? str(snippet.channelTitle) ?? '',
        publishedAt,
        thumbnailUrl: bestThumbnail(snippet.thumbnails),
        description: str(snippet.description) ?? undefined,
      });
    }
    return videos;
  }

  private async playlistHeader(playlistId: string): Promise<FeedHeader> {
    const body = await this.call('playlists', { part: 'snippet', id: playlistId });
    const snippet = arrayOf(body.items)[0]?.snippet;
    if (!snippet) throw new ApiStatus(404, 'YouTube playlist not found');
    const channelId = str(snippet.channelId) ?? '';
    return {
      id: `yt:playlist:${playlistId}`,
      title: str(snippet.title) ?? 'Untitled',
      alternateUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
      authorName: str(snippet.channelTitle) ?? '',
      authorUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : '',
    };
  }

  private async channelTitle(channelId: string): Promise<string> {
    const body = await this.call('channels', { part: 'snippet', id: channelId });
    const title = str(arrayOf(body.items)[0]?.snippet?.title);
    if (!title) throw new ApiStatus(404, 'YouTube channel not found');
    return title;
  }

  private async channelIdForUser(username: string): Promise<string> {
    const body = await this.call('channels', { part: 'id', forUsername: username });
    const id = str(arrayOf(body.items)[0]?.id);
    if (!id || !CHANNEL_ID_RE.test(id)) throw new ApiStatus(404, 'YouTube user not found');
    return id;
  }

  private async call(resource: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`${API_BASE}/${resource}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('key', this.apiKey);
    this.apiCalls++;
    const response = await this.fetchImpl(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (response.ok) return body ?? {};

    const reasons = arrayOf(body?.error?.errors).map((e) => str(e?.reason) ?? '');
    if (response.status === 404 || reasons.some((r) => r.endsWith('NotFound'))) {
      throw new ApiStatus(404, `YouTube ${resource} not found`);
    }
    if (reasons.some((r) => r === 'quotaExceeded' || r === 'dailyLimitExceeded')) {
      this.quotaPausedUntil = this.now() + this.quotaPauseMs;
      console.error('[YouTube] API quota exhausted; pausing API calls');
      throw new ApiStatus(429, 'YouTube API quota exhausted');
    }
    if (response.status === 429 || reasons.includes('rateLimitExceeded')) {
      throw new ApiStatus(429, 'YouTube API rate limited');
    }
    // Never echo the request URL: it carries the key.
    const detail = reasons.filter(Boolean).join(', ') || `HTTP ${response.status}`;
    console.error(`[YouTube] ${resource} refused: ${detail}`);
    throw new ApiStatus(503, `YouTube API error (${detail})`);
  }
}

function statusResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain' } });
}

function arrayOf(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function bestThumbnail(thumbnails: any): string | undefined {
  if (!thumbnails || typeof thumbnails !== 'object') return undefined;
  for (const size of ['high', 'medium', 'standard', 'default', 'maxres']) {
    const url = str(thumbnails[size]?.url);
    if (url) return url;
  }
  return undefined;
}

function escapeXml(s: string): string {
  return (
    s
      // Control characters are illegal in XML 1.0 and would fail the whole feed's parse.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}

/**
 * The Atom document youtube.com/feeds/videos.xml would have served. Deterministic
 * for the same API answer (no fetch timestamps), so an unchanged channel hits
 * the crawl's body-hash fast path.
 */
export function renderAtom(feedUrl: string, header: FeedHeader, videos: ApiVideo[]): string {
  const x = escapeXml;
  const entries = videos.map((v) => {
    const watchUrl = `https://www.youtube.com/watch?v=${v.videoId}`;
    return [
      ' <entry>',
      `  <id>yt:video:${x(v.videoId)}</id>`,
      `  <yt:videoId>${x(v.videoId)}</yt:videoId>`,
      `  <title>${x(v.title)}</title>`,
      `  <link rel="alternate" href="${x(watchUrl)}"/>`,
      `  <author><name>${x(v.channelTitle || header.authorName)}</name></author>`,
      `  <published>${x(v.publishedAt)}</published>`,
      `  <updated>${x(v.publishedAt)}</updated>`,
      '  <media:group>',
      `   <media:title>${x(v.title)}</media:title>`,
      v.thumbnailUrl ? `   <media:thumbnail url="${x(v.thumbnailUrl)}"/>` : null,
      v.description ? `   <media:description>${x(v.description)}</media:description>` : null,
      '  </media:group>',
      ' </entry>',
    ]
      .filter((line) => line !== null)
      .join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">',
    ` <link rel="self" href="${x(feedUrl)}"/>`,
    ` <id>${x(header.id)}</id>`,
    ` <title>${x(header.title)}</title>`,
    ` <link rel="alternate" href="${x(header.alternateUrl)}"/>`,
    ` <author><name>${x(header.authorName)}</name><uri>${x(header.authorUrl)}</uri></author>`,
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}
