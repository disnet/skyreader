/**
 * Renderer for app.greengale.document markdown-based documents
 * Converts Greengale markdown + blob references to HTML for display in ArticleCard
 */

import { marked } from 'marked';
import type { GreengaleContent } from '$lib/types';

/**
 * Check if content is app.greengale.document format
 */
export function isGreengaleContent(content: unknown): content is GreengaleContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    '$type' in content &&
    (content as { $type: string }).$type === 'app.greengale.document'
  );
}

/**
 * Construct a CDN URL for an AT Protocol blob
 */
function getBlobUrl(authorDid: string, cid: string): string {
  return `https://cdn.bsky.app/img/feed_fullsize/plain/${authorDid}/${cid}@jpeg`;
}

/**
 * Main entry point: render Greengale content to HTML
 */
export function renderGreengaleContent(content: GreengaleContent, authorDid: string): string {
  if (!content.markdown) {
    return '';
  }

  // Build blob lookup map: name → CDN URL
  const blobMap = new Map<string, string>();
  if (content.blobs) {
    for (const blob of content.blobs) {
      blobMap.set(blob.name, getBlobUrl(authorDid, blob.cid));
    }
  }

  // Preprocess markdown: resolve blob image references
  let markdown = content.markdown;
  if (blobMap.size > 0) {
    markdown = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
      // Skip already-absolute URLs
      if (src.startsWith('http://') || src.startsWith('https://')) {
        return match;
      }
      const resolved = blobMap.get(src);
      if (resolved) {
        return `![${alt}](${resolved})`;
      }
      return match;
    });
  }

  // Convert markdown to HTML with GFM enabled
  const html = marked.parse(markdown, { gfm: true, async: false }) as string;

  return html;
}
