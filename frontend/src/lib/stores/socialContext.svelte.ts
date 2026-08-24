// Constellation social context for link posts (Phase 3).
//
// A link post can be enriched with network-wide context pulled from Constellation
// via the backend (`/api/v2/social-context`): how many other posts quote it. This
// is *adornment only* — it loads lazily when a link post is opened and degrades
// silently (no line shown) if Constellation is unavailable.
//
// Session-scoped, in-memory memo keyed by the link post's record URI. The proxy
// caches the Constellation lookup behind it, so a per-session map is enough.

import { api } from '$lib/services/api';
import type { SocialContextResult } from '$lib/types';

interface Entry {
  status: 'loading' | 'ready';
  context?: SocialContextResult;
}

interface FetchArgs {
  docUri: string;
}

function createSocialContextStore() {
  let entries = $state<Map<string, Entry>>(new Map());

  // Fetch context for a link post. No-op if already loading/loaded. Keyed by
  // docUri so re-opening the same post is free.
  async function fetch({ docUri }: FetchArgs) {
    if (!docUri || entries.has(docUri)) return;

    entries.set(docUri, { status: 'loading' });
    entries = new Map(entries);

    try {
      const res = await api.fetchSocialContext([{ key: docUri, docUri }]);
      const context = res.items?.find((i) => i.key === docUri) ?? res.items?.[0];
      if (context) {
        entries.set(docUri, { status: 'ready', context });
      } else {
        // Nothing came back — drop the entry so a later open can retry.
        entries.delete(docUri);
      }
    } catch (e) {
      console.error('Failed to fetch social context:', e);
      // Silent degradation: drop the entry rather than pinning an error state.
      entries.delete(docUri);
    }
    entries = new Map(entries);
  }

  // The resolved context for a link post, or undefined if not loaded yet.
  function get(docUri: string): SocialContextResult | undefined {
    const entry = entries.get(docUri);
    return entry?.status === 'ready' ? entry.context : undefined;
  }

  return { fetch, get };
}

export const socialContextStore = createSocialContextStore();
