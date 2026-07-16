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
    };
  } catch (err) {
    return { error: String(err) };
  }
};
