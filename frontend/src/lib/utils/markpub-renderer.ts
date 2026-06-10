/**
 * Renderer for at.markpub.markdown documents (https://markpub.at/)
 *
 * markpub is an interop wrapper for embedding Markdown into a larger
 * standard.site document: the body lives at `content.text.markdown` (a
 * CommonMark/GFM string), with optional facets/textBlob overlays we don't
 * consume here. Like the greengale path it renders the raw markdown to HTML;
 * the result is sanitized downstream (sanitizeHtml) before display.
 */

import { marked } from 'marked';
import type { MarkpubContent } from '$lib/types';

/**
 * Check if content is at.markpub.markdown format
 */
export function isMarkpubContent(content: unknown): content is MarkpubContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    '$type' in content &&
    (content as { $type: string }).$type === 'at.markpub.markdown'
  );
}

/**
 * Main entry point: render markpub content to HTML.
 *
 * The markdown is read from `text.markdown`. When the body is stored only as a
 * blob (`text.textBlob`) with no inline string, there's nothing to render
 * synchronously and we return empty — the caller falls back to description.
 */
export function renderMarkpubContent(content: MarkpubContent): string {
  const markdown = content.text?.markdown;
  if (!markdown) {
    return '';
  }

  // commonmark variant disables GFM extensions; default to GFM (the common case).
  const gfm = content.flavor !== 'commonmark';

  return marked.parse(markdown, { gfm, async: false }) as string;
}
