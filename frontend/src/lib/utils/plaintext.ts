/**
 * Rendering for document bodies that are declared plaintext.
 *
 * A `site.standard.document` carries its body two ways: the structured `content`
 * open union (Leaflet, pckt, Offprint, Greengale, markpub — each with its own
 * renderer), and `textContent`, which the lexicon defines as the "plaintext
 * representation of the documents contents. Should not contain markdown or other
 * formatting."
 *
 * `content` is optional, and some publishers ship only `textContent` (HappyView's
 * blog, for one). That body still has to reach the reader, which renders HTML via
 * `{@html}` — so handing it the raw string is wrong twice over: the blank lines
 * that separate its paragraphs collapse into spaces, turning the whole article
 * into one run-on block, and any angle bracket in the prose is parsed as a tag and
 * dropped by the sanitizer (`space:<spaceType>[?authority=<did>]` renders as
 * `space:[?authority=]`).
 *
 * So escape it and rebuild the block structure its newlines describe. Text the
 * author never marked up stays text.
 */

import { decodeEntities } from '$lib/utils/entities';
import { escapeHtml } from '$lib/utils/html';

/**
 * Render a plaintext body to HTML: blank-line-separated blocks become paragraphs,
 * single newlines inside a block become line breaks, and everything else is
 * escaped. Returns '' for an empty or whitespace-only body, so callers keep their
 * existing description fallback.
 *
 * Entities are decoded before escaping. Some publishers ship entity-encoded text
 * in these plaintext fields (`Tom &amp;amp; Jerry`, `don&amp;#8217;t`) — the old
 * `{@html}` render let the browser decode them, so escaping alone would newly
 * show them raw. `getItemTitle` already decodes document titles for the same
 * reason; this keeps the body consistent with its own headline.
 */
export function renderPlaintextBody(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(decodeEntities(block)).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
