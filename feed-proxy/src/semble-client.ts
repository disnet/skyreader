import { normalizeArticleUrl, constellationTargets } from './url-normalize';

const API_BASE = 'https://api.semble.so/xrpc';
const LIMIT = 20;
const TIMEOUT_MS = 6_000;
const MAX_TEXT = 2_000;

export interface SembleAuthor {
  did: string;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
}
/** One person's card for this URL. Consumed only here, to build the lane's
 *  human entries — it never crosses the wire (see `SembleContextWire`), so the
 *  reader isn't shipped the same people twice. */
export interface SembleSaver {
  author: SembleAuthor;
  note: string | null;
  savedAt: string | null;
}
export interface SembleContext {
  stats: {
    saves: number;
    notes: number;
    collections: number;
    connections: { total: number; incoming: number; outgoing: number };
  } | null;
  savers: SembleSaver[];
  notes: Array<{ id: string; text: string; author: SembleAuthor; createdAt: string | null }>;
  collections: Array<{
    id: string;
    name: string;
    url: string | null;
    author: { did: string; handle: string };
  }>;
  connections: Array<{
    id: string;
    direction: 'out' | 'in';
    type: string | null;
    note: string | null;
    curator: SembleAuthor;
    createdAt: string | null;
    other: {
      url: string;
      title: string | null;
      description: string | null;
      siteName: string | null;
      imageUrl: string | null;
    };
  }>;
  similar: Array<{
    url: string;
    title: string | null;
    description: string | null;
    siteName: string | null;
    saveCount: number;
  }>;
  truncated: { savers: boolean; notes: boolean; collections: boolean; connections: boolean };
  incomplete: boolean;
  source: 'semble-api' | 'constellation-fallback';
  /** This URL's own card on semble.so: the page these counts were read from,
   *  with its own Connections and Notes tabs. Built here rather than in the
   *  reader, so only this module has to know Semble's routes. */
  cardUrl: string | null;
}

/** What the reader actually receives. The savers are already in the lane's
 *  `entries`; sending them again would duplicate every person in the payload. */
export type SembleContextWire = Omit<SembleContext, 'savers'>;

/** Semble's card page is keyed by the article URL, not by a card id — every
 *  saver's card for a URL rolls up into the one page. */
export function sembleCardUrl(url: string | null): string | null {
  return url ? `https://semble.so/url/${encodeURIComponent(url)}` : null;
}

type Obj = Record<string, any>;
const text = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
const date = (v: unknown): string | null => {
  const s = text(v, 64);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
};
const author = (v: Obj | undefined): SembleAuthor => ({
  did: text(v?.id, 256) ?? '',
  handle: text(v?.handle, 256) ?? '',
  name: text(v?.name, 256),
  avatarUrl: httpUrl(v?.avatarUrl),
});
const httpUrl = (v: unknown): string | null => {
  const s = text(v, 2048);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
};
const hasMore = (v: Obj): boolean => v?.pagination?.hasMore === true;

async function call(nsid: string, url: string, extra: Record<string, string> = {}): Promise<Obj> {
  const qs = new URLSearchParams({ url, limit: String(LIMIT), ...extra });
  const res = await fetch(`${API_BASE}/${nsid}?${qs}`, {
    headers: { 'X-Semble-Client': 'skyreader', Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json'))
    throw new Error(`Semble ${nsid} ${res.status}`);
  const raw = await res.text();
  if (raw.length > 1_000_000) throw new Error(`Semble ${nsid} response too large`);
  return JSON.parse(raw) as Obj;
}

/** How much this URL form actually holds on Semble — the tiebreaker between the
 *  two trailing-slash variants below. */
function statsWeight(meta: Obj): number {
  const s = meta?.stats;
  if (!s) return 0;
  return (
    count(s.libraryCount) +
    count(s.noteCount) +
    count(s.collectionCount) +
    count(s.connections?.all?.total)
  );
}

/**
 * Which spelling of this URL to ask Semble about.
 *
 * Semble keys a card by the URL **string**, exactly the way Constellation keys a
 * target — so `/post` and `/post/` are two different keys there, and an article
 * whose site canonicalizes *with* the slash has all of its saves under the slash
 * form and none under the trimmed one. `normalizeArticleUrl` collapses to the
 * trimmed form for a stable cache key, so asking only that form reads as "nobody
 * saved this" for every slash-canonical article (verified live: 15 saves and 16
 * collections under the slash, zeros without it).
 *
 * So probe both forms with the cheap stats call, keep whichever Semble actually
 * holds, and hand its metadata back so the winner isn't fetched twice. One extra
 * request, on a lookup the caller caches. All probes failing yields the canonical
 * form and `metaOk: false` — the caller decides what an unreachable Semble means.
 */
async function pickUrlVariant(
  normUrl: string
): Promise<{ apiUrl: string; meta: Obj; metaOk: boolean }> {
  const targets = constellationTargets(normUrl);
  const probes = await Promise.allSettled(
    targets.map((target) =>
      call('network.cosmik.card.getUrlMetadata', target, { includeStats: 'true' })
    )
  );
  let best: { apiUrl: string; meta: Obj; metaOk: boolean } | null = null;
  let bestWeight = -1;
  targets.forEach((target, i) => {
    const probe = probes[i];
    if (probe.status !== 'fulfilled') return;
    const weight = statsWeight(probe.value);
    // Strictly greater, so a tie (both empty) keeps the canonical trimmed form.
    if (weight > bestWeight) {
      bestWeight = weight;
      best = { apiUrl: target, meta: probe.value, metaOk: true };
    }
  });
  return best ?? { apiUrl: normUrl, meta: {}, metaOk: false };
}

/** Semble answered, but with nothing: no people, notes, collections, edges, or
 *  recommendations. Worth naming because it isn't the same as Semble being down, and the
 *  lane treats it differently — see getMentionLaneItems. */
export function isEmptySembleContext(context: SembleContext): boolean {
  return (
    context.savers.length === 0 &&
    context.notes.length === 0 &&
    context.collections.length === 0 &&
    context.connections.length === 0 &&
    context.similar.length === 0
  );
}

export async function fetchSembleContext(rawUrl: string): Promise<SembleContext | null> {
  const url = normalizeArticleUrl(rawUrl);
  if (!url) return null;
  // Everything below asks about `apiUrl` (the form Semble holds); `url` stays the
  // canonical key, so the connection self-comparison keeps comparing like to like.
  const { apiUrl, meta, metaOk } = await pickUrlVariant(url);
  const calls = await Promise.allSettled([
    call('network.cosmik.card.getLibrariesForUrl', apiUrl),
    call('network.cosmik.card.getNoteCardsForUrl', apiUrl),
    call('network.cosmik.collection.getForUrl', apiUrl),
    call('network.cosmik.connection.getForUrl', apiUrl, { direction: 'both' }),
    call('network.cosmik.search.getSimilarUrls', apiUrl, { limit: '8' }),
  ]);
  const humanCalls = calls.slice(0, 4);
  if (!metaOk && humanCalls.every((r) => r.status === 'rejected')) return null;
  const value = (i: number): Obj => (calls[i].status === 'fulfilled' ? calls[i].value : {});
  const [libraries, noteCards, collectionData, connectionData, similarData] = [0, 1, 2, 3, 4].map(
    value
  );
  const stats = meta.stats
    ? {
        saves: count(meta.stats.libraryCount),
        notes: count(meta.stats.noteCount),
        collections: count(meta.stats.collectionCount),
        connections: {
          total: count(meta.stats.connections?.all?.total),
          incoming: count(meta.stats.connections?.incoming?.total),
          outgoing: count(meta.stats.connections?.outgoing?.total),
        },
      }
    : null;
  const savers = (Array.isArray(libraries.libraries) ? libraries.libraries : [])
    .slice(0, LIMIT)
    .map((x: Obj) => ({
      author: author(x.user ?? x.card?.author),
      note: text(x.card?.note?.text ?? x.card?.note),
      savedAt: date(x.card?.createdAt),
    }));
  const saverNotes = new Set(
    savers
      .map((s) => `${s.author.did}|${s.note?.trim().toLowerCase()}`)
      .filter((x) => !x.endsWith('|undefined') && !x.endsWith('|null'))
  );
  // Every id here keys a list on the reader's side, so it carries the same
  // hazard the connections below do: a missing one must not key every row to the
  // same empty string, and a repeat must not reach the reader at all. Who wrote
  // it and what it says identifies a note on its own.
  const noteSeen = new Set<string>();
  const notes = (Array.isArray(noteCards.notes) ? noteCards.notes : [])
    .slice(0, LIMIT)
    .flatMap((x: Obj) => {
      const body = text(x.note ?? x.text);
      if (!body) return [];
      const a = author(x.author);
      const fingerprint = `${a.did}|${body.trim().toLowerCase()}`;
      // Already shown as this person's saver card, so it isn't a second voice.
      if (saverNotes.has(fingerprint)) return [];
      const id = text(x.id, 256) ?? fingerprint;
      if (noteSeen.has(id) || noteSeen.has(fingerprint)) return [];
      noteSeen.add(id);
      noteSeen.add(fingerprint);
      return [{ id, text: body, author: a, createdAt: date(x.createdAt) }];
    });
  const collectionSeen = new Set<string>();
  const collections = (Array.isArray(collectionData.collections) ? collectionData.collections : [])
    .slice(0, LIMIT)
    .flatMap((x: Obj) => {
      const a = author(x.author);
      const rkey = text(x.uri, 512)?.split('/').pop();
      const name = text(x.name, 256) ?? 'Untitled collection';
      // Same rule as the notes above: prefer Semble's id, fall back to whose
      // collection it is and what it's called, never to the empty string. A URL
      // filed into the same collection twice arrives twice; it is one place.
      const id = text(x.id, 256) ?? text(x.uri, 512) ?? `${a.did}|${name.toLowerCase()}`;
      if (collectionSeen.has(id)) return [];
      collectionSeen.add(id);
      return [
        {
          id,
          name,
          url:
            a.handle && rkey ? `https://semble.so/profile/${a.handle}/collections/${rkey}` : null,
          author: { did: a.did, handle: a.handle },
        },
      ];
    });
  const seen = new Set<string>();
  const connections = (Array.isArray(connectionData.connections) ? connectionData.connections : [])
    .slice(0, LIMIT)
    .flatMap((x: Obj) => {
      const source = httpUrl(x.source?.url),
        target = httpUrl(x.target?.url);
      const sourceIsThis = source ? normalizeArticleUrl(source) === url : false;
      const targetIsThis = target ? normalizeArticleUrl(target) === url : false;
      if (sourceIsThis === targetIsThis) return [];
      const other = x[sourceIsThis ? 'target' : 'source'];
      const otherUrl = httpUrl(other?.url);
      if (!otherUrl) return [];
      const type = text(x.connection?.type, 128)?.replaceAll('_', ' ').toLowerCase() ?? null;
      const curator = author(x.connection?.curator);
      // Prefer Semble's own id, but never let a missing one key every edge to the
      // same empty string — that would silently collapse the whole graph to its
      // first edge. Who drew it, between which two pages, saying what, identifies
      // an edge on its own: two curators making the same claim are two edges.
      const id =
        text(x.connection?.id, 256) ??
        `${source ?? ''}|${target ?? ''}|${type ?? ''}|${curator.did}`;
      if (seen.has(id)) return [];
      seen.add(id);
      return [
        {
          id,
          direction: sourceIsThis ? ('out' as const) : ('in' as const),
          type,
          note: text(x.connection?.note),
          curator,
          createdAt: date(x.connection?.createdAt),
          other: {
            url: otherUrl,
            title: text(other?.metadata?.title, 500),
            description: text(other?.metadata?.description),
            siteName: text(other?.metadata?.siteName, 256),
            imageUrl: httpUrl(other?.metadata?.imageUrl),
          },
        },
      ];
    })
    .sort((a: any, b: any) =>
      a.direction === b.direction
        ? (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0)
        : a.direction === 'out'
          ? -1
          : 1
    );
  const connectedUrls = new Set(
    connections.map((connection) => normalizeArticleUrl(connection.other.url))
  );
  const similarSeen = new Set<string>();
  const similar = (Array.isArray(similarData.urls) ? similarData.urls : [])
    .flatMap((entry: Obj) => {
      const candidateUrl = httpUrl(entry.url);
      if (!candidateUrl) return [];
      const normalized = normalizeArticleUrl(candidateUrl);
      if (
        !normalized ||
        normalized === url ||
        connectedUrls.has(normalized) ||
        similarSeen.has(normalized)
      )
        return [];
      similarSeen.add(normalized);
      return [
        {
          url: candidateUrl,
          title: text(entry.metadata?.title, 500),
          description: text(entry.metadata?.description),
          siteName: text(entry.metadata?.siteName, 256),
          saveCount: count(entry.urlLibraryCount),
        },
      ];
    })
    .slice(0, 8);
  return {
    stats,
    savers,
    notes,
    collections,
    connections,
    similar,
    truncated: {
      savers: hasMore(libraries),
      notes: hasMore(noteCards),
      collections: hasMore(collectionData),
      connections: hasMore(connectionData),
    },
    incomplete: !metaOk || humanCalls.some((r) => r.status === 'rejected'),
    source: 'semble-api',
    cardUrl: sembleCardUrl(apiUrl),
  };
}
