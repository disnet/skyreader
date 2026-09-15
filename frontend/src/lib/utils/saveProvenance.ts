import type { SaveProvenance } from '$lib/types';

// `at://did:plc:…/…` does not survive `new URL()` — the DID authority's colons
// read as an invalid port — so it is matched on shape, as the backend does.
const AT_URI_RE = /^at:\/\/[a-zA-Z0-9._:%-]+(\/[^\s]*)?$/;

/** An absolute http(s)/at:// referrer, or nothing — mirrors the backend's rule. */
function referrerUrl(url: string | null | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('at://')) return AT_URI_RE.test(trimmed) ? trimmed : undefined;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === 'http:' || protocol === 'https:' ? trimmed : undefined;
  } catch {
    // Not absolute (a standard.site document's relative `path`, say) — no referrer.
    return undefined;
  }
}

/**
 * Provenance for a link saved from inside something you were reading.
 *
 * The reading surfaces pass whatever the hosting item has, and that is often
 * partial: a saved standard.site document with no canonical URL carries `url:
 * ''`, `getDocumentEffectiveUrl` can yield a bare relative `path`, and an
 * untitled item has no title. Every unusable field is left off the request
 * rather than sent — the backend drops it too, and a save must never fail, or
 * carry junk, over its label.
 */
export function readerProvenance(from?: {
  title?: string | null;
  url?: string | null;
}): SaveProvenance {
  return {
    savedVia: 'reader',
    savedFromTitle: from?.title?.trim() || undefined,
    savedFromUrl: referrerUrl(from?.url),
  };
}
