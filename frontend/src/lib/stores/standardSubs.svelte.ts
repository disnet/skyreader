import { auth } from './auth.svelte';
import { subscriptionsStore } from './subscriptions.svelte';

/**
 * Your standard.site subscriptions, read straight from your PDS
 * (`site.standard.graph.subscription`). These are publications you already
 * follow elsewhere in the Atmosphere — surfaced on the Sources page so you can
 * pull them into Skyreader in one tap. Read-only discovery: no backend, fails
 * silently (they're suggestions, never load-bearing).
 *
 * Mirrors the loader that lived inside AddHandleModal, lifted here so the
 * Sources page can render the same suggestions inline.
 */
export interface StandardSub {
  /** rkey URI of the subscription record (stable list key). */
  uri: string;
  publisherDid: string;
  publication: {
    uri: string;
    name: string;
    url: string;
    description?: string;
  };
}

function parseAtUri(atUri: string): { did: string; collection: string; rkey: string } | null {
  const match = atUri.match(/^at:\/\/(did:[^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { did: match[1], collection: match[2], rkey: match[3] };
}

async function resolvePdsUrl(did: string): Promise<string | null> {
  try {
    if (did.startsWith('did:plc:')) {
      const res = await fetch(`https://plc.directory/${did}`);
      if (!res.ok) return null;
      const doc = (await res.json()) as {
        service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
      };
      const svc = doc.service?.find(
        (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
      );
      return svc?.serviceEndpoint || null;
    } else if (did.startsWith('did:web:')) {
      const domain = did.replace('did:web:', '');
      const res = await fetch(`https://${domain}/.well-known/did.json`);
      if (!res.ok) return null;
      const doc = (await res.json()) as {
        service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
      };
      const svc = doc.service?.find(
        (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
      );
      return svc?.serviceEndpoint || null;
    }
    return null;
  } catch {
    return null;
  }
}

function createStandardSubsStore() {
  let subs = $state<StandardSub[]>([]);
  let loading = $state(false);
  let loaded = $state(false);
  let subscribing = $state<string | null>(null);

  async function load(force = false): Promise<void> {
    if (loading || (loaded && !force)) return;
    loading = true;
    try {
      const pdsUrl = auth.user?.pdsUrl;
      const did = auth.user?.did;
      if (!pdsUrl || !did) {
        subs = [];
        return;
      }

      const params = new URLSearchParams({
        repo: did,
        collection: 'site.standard.graph.subscription',
        limit: '100',
      });
      const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`);
      if (!res.ok) {
        subs = [];
        return;
      }
      const data = (await res.json()) as {
        records: Array<{ uri: string; value: { publication?: string } }>;
      };
      if (data.records.length === 0) {
        subs = [];
        return;
      }

      const entries = data.records
        .map((r) => ({ uri: r.uri, pubUri: r.value.publication }))
        .filter((e): e is { uri: string; pubUri: string } => !!e.pubUri)
        .map((e) => ({ ...e, parsed: parseAtUri(e.pubUri) }))
        .filter((e): e is typeof e & { parsed: NonNullable<typeof e.parsed> } => !!e.parsed);

      const uniqueDids = [...new Set(entries.map((e) => e.parsed.did))];
      const pdsCache = new Map<string, string | null>();
      await Promise.all(
        uniqueDids.map(async (d) => {
          pdsCache.set(d, await resolvePdsUrl(d));
        })
      );

      const results = await Promise.allSettled(
        entries.map(async (entry): Promise<StandardSub | null> => {
          const pubPds = pdsCache.get(entry.parsed.did);
          if (!pubPds) return null;

          const pubParams = new URLSearchParams({
            repo: entry.parsed.did,
            collection: entry.parsed.collection,
            rkey: entry.parsed.rkey,
          });
          const pubRes = await fetch(`${pubPds}/xrpc/com.atproto.repo.getRecord?${pubParams}`);
          if (!pubRes.ok) return null;

          const pubData = (await pubRes.json()) as {
            value: { name?: string; url?: string; description?: string };
          };
          const pub = pubData.value;
          if (!pub.url) return null;

          return {
            uri: entry.uri,
            publisherDid: entry.parsed.did,
            publication: {
              uri: entry.pubUri,
              name: pub.name || pub.url,
              url: pub.url,
              description: pub.description,
            },
          };
        })
      );

      subs = results
        .filter((r): r is PromiseFulfilledResult<StandardSub | null> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((s): s is StandardSub => s !== null);
    } catch {
      // Silently fail — these are suggestions.
    } finally {
      loading = false;
      loaded = true;
    }
  }

  // Subscribe to a standard.site publication as an `atproto.documents` stream.
  async function subscribe(sub: StandardSub): Promise<void> {
    if (subscribing) return;
    subscribing = sub.uri;
    try {
      await subscriptionsStore.add(sub.publication.uri, sub.publication.name, {
        sourceType: 'atproto.documents',
        subjectDid: sub.publisherDid,
        siteUrl: sub.publication.url,
        feedUrl: sub.publication.uri,
      });
    } finally {
      subscribing = null;
    }
  }

  return {
    get subs() {
      return subs;
    },
    get loading() {
      return loading;
    },
    get loaded() {
      return loaded;
    },
    get subscribing() {
      return subscribing;
    },
    load,
    subscribe,
  };
}

export const standardSubsStore = createStandardSubsStore();
