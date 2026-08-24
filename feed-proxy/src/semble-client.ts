import { normalizeArticleUrl } from './url-normalize';

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
export interface SembleContext {
  stats: {
    saves: number;
    notes: number;
    collections: number;
    connections: { total: number; incoming: number; outgoing: number };
  } | null;
  savers: Array<{
    cardId: string;
    cardUri: string | null;
    author: SembleAuthor;
    note: string | null;
    savedAt: string | null;
    collections: Array<{ id: string; name: string; url: string | null }>;
  }>;
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
  truncated: { savers: boolean; notes: boolean; collections: boolean; connections: boolean };
  incomplete: boolean;
  source: 'semble-api' | 'constellation-fallback';
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

export async function fetchSembleContext(rawUrl: string): Promise<SembleContext | null> {
  const url = normalizeArticleUrl(rawUrl);
  if (!url) return null;
  const calls = await Promise.allSettled([
    call('network.cosmik.card.getUrlMetadata', url, { includeStats: 'true' }),
    call('network.cosmik.card.getLibrariesForUrl', url),
    call('network.cosmik.card.getNoteCardsForUrl', url),
    call('network.cosmik.collection.getForUrl', url),
    call('network.cosmik.connection.getForUrl', url, { direction: 'both' }),
  ]);
  if (calls.every((r) => r.status === 'rejected')) return null;
  const value = (i: number): Obj => (calls[i].status === 'fulfilled' ? calls[i].value : {});
  const [meta, libraries, noteCards, collectionData, connectionData] = [0, 1, 2, 3, 4].map(value);
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
      cardId: text(x.card?.id, 256) ?? text(x.card?.uri, 512) ?? '',
      cardUri: text(x.card?.uri, 512),
      author: author(x.user ?? x.card?.author),
      note: text(x.card?.note?.text ?? x.card?.note),
      savedAt: date(x.card?.createdAt),
      collections: [],
    }));
  const saverNotes = new Set(
    savers
      .map((s) => `${s.author.did}|${s.note?.trim().toLowerCase()}`)
      .filter((x) => !x.endsWith('|undefined') && !x.endsWith('|null'))
  );
  const notes = (Array.isArray(noteCards.notes) ? noteCards.notes : [])
    .slice(0, LIMIT)
    .map((x: Obj) => ({
      id: text(x.id, 256) ?? '',
      text: text(x.note ?? x.text) ?? '',
      author: author(x.author),
      createdAt: date(x.createdAt),
    }))
    .filter(
      (x: any) => x.text && !saverNotes.has(`${x.author.did}|${x.text.trim().toLowerCase()}`)
    );
  const collections = (Array.isArray(collectionData.collections) ? collectionData.collections : [])
    .slice(0, LIMIT)
    .map((x: Obj) => {
      const a = author(x.author);
      const rkey = text(x.uri, 512)?.split('/').pop();
      return {
        id: text(x.id, 256) ?? text(x.uri, 512) ?? '',
        name: text(x.name, 256) ?? 'Untitled collection',
        url: a.handle && rkey ? `https://semble.so/profile/${a.handle}/collections/${rkey}` : null,
        author: { did: a.did, handle: a.handle },
      };
    });
  const seen = new Set<string>();
  const connections = (Array.isArray(connectionData.connections) ? connectionData.connections : [])
    .slice(0, LIMIT)
    .flatMap((x: Obj) => {
      const id = text(x.connection?.id, 256) ?? '';
      if (seen.has(id)) return [];
      seen.add(id);
      const source = httpUrl(x.source?.url),
        target = httpUrl(x.target?.url);
      const n = normalizeArticleUrl(url);
      const sourceIsThis = source ? normalizeArticleUrl(source) === n : false;
      const targetIsThis = target ? normalizeArticleUrl(target) === n : false;
      if (sourceIsThis === targetIsThis) return [];
      const other = x[sourceIsThis ? 'target' : 'source'];
      const otherUrl = httpUrl(other?.url);
      if (!otherUrl) return [];
      return [
        {
          id,
          direction: sourceIsThis ? ('out' as const) : ('in' as const),
          type: text(x.connection?.type, 128)?.replaceAll('_', ' ').toLowerCase() ?? null,
          note: text(x.connection?.note),
          curator: author(x.connection?.curator),
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
  return {
    stats,
    savers,
    notes,
    collections,
    connections,
    truncated: {
      savers: hasMore(libraries),
      notes: hasMore(noteCards),
      collections: hasMore(collectionData),
      connections: hasMore(connectionData),
    },
    incomplete: calls.some((r) => r.status === 'rejected'),
    source: 'semble-api',
  };
}
