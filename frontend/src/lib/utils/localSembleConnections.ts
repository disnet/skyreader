// The reader's own record of new Semble connections on a save (GET
// /api/saved/connections), folded into the discussion's Semble context.
//
// The panel reads Semble's API through the feed proxy's cache, so a connection
// that just badged a save can be minutes from showing there. The badge and the
// panel must agree, so the edges Skyreader already holds are added to what
// Semble returned, skipping any Semble already has.

import { urlKey } from './urlKey';
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

// Semble's copy of an edge carries the record uri as its id; a match on the
// edge itself covers a copy that doesn't.
function edgeKey(curatorDid: string, direction: string, type: string | null, url: string): string {
  return `${curatorDid}|${direction}|${type ?? ''}|${urlKey(url) ?? url}`;
}

/** As the proxy writes Semble's types: "LEADS_TO" → "leads to". */
function typeLabel(type: string | null): string | null {
  return type ? type.replaceAll('_', ' ').toLowerCase() : null;
}

export function withLocalConnections(
  context: SembleContext | undefined,
  details: SavedConnectionDetail[],
  profiles: Map<string, BlueskyProfile> = new Map()
): SembleContext | undefined {
  if (details.length === 0) return context;
  const base = context ?? EMPTY;
  const byKey = new Map<string, number>();
  base.connections.forEach((c, i) => {
    byKey.set(c.id, i);
    byKey.set(edgeKey(c.curator.did, c.direction, c.type, c.other.url), i);
  });
  // A copy Semble already has keeps Semble's details, but is dated by when the
  // poller saw it, as the badge is: a record published late still reads as new.
  let existing = base.connections;
  const added: Connection[] = [];
  for (const detail of details) {
    const type = typeLabel(detail.type);
    const key = edgeKey(detail.curatorDid, detail.direction, type, detail.otherUrl);
    const indexedAt = new Date(detail.indexedAt).toISOString();
    const match = byKey.get(detail.uri) ?? byKey.get(key);
    if (match !== undefined) {
      if (match < 0) continue;
      const createdAt = existing[match].createdAt;
      if (!createdAt || Date.parse(createdAt) < Date.parse(indexedAt)) {
        if (existing === base.connections) existing = [...existing];
        existing[match] = { ...existing[match], createdAt: indexedAt };
      }
      continue;
    }
    byKey.set(detail.uri, -1);
    byKey.set(key, -1);
    const profile = profiles.get(detail.curatorDid);
    added.push({
      id: detail.uri,
      direction: detail.direction,
      type,
      note: detail.note,
      curator: {
        did: detail.curatorDid,
        handle: profile?.handle ?? '',
        name: profile?.displayName ?? null,
        avatarUrl: profile?.avatar ?? null,
      },
      createdAt: indexedAt,
      other: {
        url: detail.otherUrl,
        title: null,
        description: null,
        siteName: null,
        imageUrl: null,
      },
    });
  }
  if (added.length === 0 && existing === base.connections) return context;
  return { ...base, connections: [...added, ...existing] };
}
