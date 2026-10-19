// The reader's own record of new Semble connections on a save (GET
// /api/saved/connections), folded into the discussion's Semble context.
//
// The panel reads Semble's API through the feed proxy's cache, so a connection
// that just badged a save can be minutes from showing there. The badge and the
// panel must agree, so the edges Skyreader already holds are added to what
// Semble returned, skipping any Semble already has.

import type { BlueskyProfile, SavedConnectionDetail, SembleContext } from '$lib/types';

type Connection = SembleContext['connections'][number];

const EMPTY: SembleContext = {
  stats: null,
  notes: [],
  collections: [],
  connections: [],
  similar: [],
  truncated: { savers: false, notes: false, collections: false, connections: false },
  incomplete: false,
  source: 'semble-api',
  cardUrl: null,
};

/** Loose enough that Semble's copy of the same edge matches ours. */
function urlKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    return `${host}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function edgeKey(curatorDid: string, direction: string, url: string): string {
  return `${curatorDid}|${direction}|${urlKey(url)}`;
}

export function withLocalConnections(
  context: SembleContext | undefined,
  details: SavedConnectionDetail[],
  profiles: Map<string, BlueskyProfile> = new Map()
): SembleContext | undefined {
  if (details.length === 0) return context;
  const base = context ?? EMPTY;
  const known = new Set(
    base.connections.map((c) => edgeKey(c.curator.did, c.direction, c.other.url))
  );
  const added: Connection[] = [];
  for (const detail of details) {
    const key = edgeKey(detail.curatorDid, detail.direction, detail.otherUrl);
    if (known.has(key)) continue;
    known.add(key);
    const profile = profiles.get(detail.curatorDid);
    added.push({
      id: detail.uri,
      direction: detail.direction,
      // As the proxy writes Semble's types: "LEADS_TO" → "leads to".
      type: detail.type ? detail.type.replaceAll('_', ' ').toLowerCase() : null,
      note: detail.note,
      curator: {
        did: detail.curatorDid,
        handle: profile?.handle ?? '',
        name: profile?.displayName ?? null,
        avatarUrl: profile?.avatar ?? null,
      },
      createdAt: new Date(detail.indexedAt).toISOString(),
      other: {
        url: detail.otherUrl,
        title: null,
        description: null,
        siteName: null,
        imageUrl: null,
      },
    });
  }
  if (added.length === 0) return context;
  return { ...base, connections: [...added, ...base.connections] };
}
