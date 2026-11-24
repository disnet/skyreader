import { highlightQuote } from '$lib/utils/highlightSource';
import type { Highlight } from '$lib/types';

/**
 * Highlights as Markdown, for the clipboard: each passage a blockquote, its
 * note under it, and the article they came from last.
 */
export function highlightsMarkdown(
  highlights: readonly Pick<Highlight, 'selector' | 'passage' | 'note'>[],
  source: { title?: string; url?: string }
): string {
  const parts = highlights.map((hl) => {
    const quote = highlightQuote(hl)
      .trim()
      .split(/\n+/)
      .map((line) => `> ${line}`)
      .join('\n>\n');
    const note = hl.note?.trim();
    return note ? `${quote}\n\n${note}` : quote;
  });
  const title = source.title?.trim();
  const url = source.url;
  const credit =
    title && url ? `— [${title.replace(/[[\]]/g, '\\$&')}](${url})` : title ? `— ${title}` : url;
  if (credit) parts.push(credit);
  return parts.join('\n\n');
}
