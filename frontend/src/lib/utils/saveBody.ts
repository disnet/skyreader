// Which body a feed-article save keeps: the feed's own, or a web extraction.
//
// Extraction usually wins — a feed body is often just an excerpt, and a clean
// full-text extraction reads better. But when the feed already carried the
// whole piece (a full-content feed, an emailed newsletter), the web page can be
// *worse*: a paywall or sign-up wall hands the extractor a teaser, and saving
// that throws away the text the reader was just looking at. So extraction has
// to hold at least most of the feed body's text to replace it.

// An extraction this much shorter than the feed body is a stub, not a cleanup.
// A clean extraction of the same article drops boilerplate (share links,
// footers) but keeps the prose, so it lands well above this.
const MIN_EXTRACTED_SHARE = 0.8;

/** Words of visible text in an HTML body (tags don't count). */
export function htmlWordCount(html: string | null | undefined): number {
  if (!html) return 0;
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  return text ? text.split(/\s+/).length : 0;
}

/** Whether a save should replace the feed body with the extracted one. */
export function preferExtractedBody(
  feedBody: string | null | undefined,
  extractedBody: string | null | undefined
): boolean {
  const extractedWords = htmlWordCount(extractedBody);
  if (extractedWords === 0) return false;
  const feedWords = htmlWordCount(feedBody);
  return extractedWords >= feedWords * MIN_EXTRACTED_SHARE;
}
