// Content-script entry: bundle Defuddle and expose one extraction function for
// the background service worker to invoke via a follow-up executeScript call.
//
// Running Defuddle against the LIVE tab DOM is the whole point — the user's
// browser has the fully rendered article (logged in, past the paywall,
// JS-rendered), which the server-side extractor in feed-proxy often can't see.
//
// The result shape mirrors feed-proxy's ExtractedArticle (feed-proxy/src/app.ts
// extractArticle) so the backend receives identical fields either way.
import Defuddle from 'defuddle';

// Coerce a Defuddle date string to a valid ISO timestamp, rejecting obviously
// bogus values (pre-1990 or future-dated) — same rule as feed-proxy.
function toValidISODate(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (isNaN(ms)) return null;
  if (ms < 631152000000 || ms > Date.now() + 86400000) return null;
  return new Date(ms).toISOString();
}

// The DOI a page names for itself in its <head> — same tags, order and value
// forms as feed-proxy/src/citation-ids.ts. dc.identifier can name anything, so
// only a DOI-shaped value counts.
const DOI_META_NAMES = [
  'citation_doi',
  'bepress_citation_doi',
  'prism.doi',
  'dc.identifier.doi',
  'dc.identifier',
];
const DOI_VALUE =
  /^(?:doi:\s*|info:doi\/|https?:\/\/(?:dx\.|www\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i;

function decodeOr(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function doiFromMetaTags(tags) {
  if (!tags) return null;
  for (const wanted of DOI_META_NAMES) {
    for (const tag of tags) {
      const key = (tag.name || tag.property || '').trim().toLowerCase();
      if (key !== wanted) continue;
      const raw = tag.content?.trim();
      if (!raw) continue;
      // A doi.org link's DOI may be percent-encoded, as any URL path may.
      const match = (/^https?:/i.test(raw) ? decodeOr(raw) : raw).match(DOI_VALUE);
      if (match) return match[1];
    }
  }
  return null;
}

globalThis.__skyreaderExtract = function () {
  try {
    // Defuddle clones internally and does not modify the page.
    const result = new Defuddle(document, { url: location.href }).parse();
    return {
      title: result.title || null,
      author: result.author || null,
      description: result.description || null,
      content: result.content || null,
      domain: result.domain || location.hostname,
      image: result.image || null,
      published: toValidISODate(result.published),
      wordCount: result.wordCount || 0,
      doi: doiFromMetaTags(result.metaTags),
    };
  } catch (err) {
    return { error: String(err) };
  }
};
