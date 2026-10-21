import type { Env } from '../types';
import { parseAtUri } from '../utils/canonical-url';
import { isValidDid } from '../services/standard-site';

export interface DevLogPublication {
  authorDid: string;
  uri: string;
}

/**
 * The Skyreader Dev Log (`DEV_LOG_PUBLICATION`), whose posts surface in every
 * reader's notification bell as "New in Skyreader" (routes/updates.ts), or null
 * when this environment has none.
 *
 * It is an ordinary standard.site publication, so its posts reach D1 the way any
 * subscribed author's do: the JetstreamPoller watches this author, and the
 * reconcile re-lists them, whether or not anyone subscribes
 * (`watchedDocumentAuthors`, `staleDocumentAuthors`). The author also writes a
 * linkblog and other publications, which is why reads filter on the publication.
 */
export function devLogPublication(env: Env): DevLogPublication | null {
  const uri = env.DEV_LOG_PUBLICATION?.trim();
  if (!uri) return null;
  const parsed = parseAtUri(uri);
  if (!parsed || parsed.collection !== 'site.standard.publication' || !isValidDid(parsed.did)) {
    return null;
  }
  return { authorDid: parsed.did, uri };
}
