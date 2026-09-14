/**
 * Renderer for pub.leaflet.content block-based documents
 * Converts Leaflet blocks to HTML for display in ArticleCard.
 * Styling must use classes: sanitizeHtml deliberately strips inline styles.
 */

import temml from 'temml';
import { allowedIframeSrc, sanitizeHtml } from '$lib/utils/sanitize';

import type {
  LeafletContent,
  LeafletBlock,
  LeafletFacet,
  LeafletTextBlock,
  LeafletHeaderBlock,
  LeafletCodeBlock,
  LeafletBlockquoteBlock,
  LeafletUnorderedListBlock,
  LeafletOrderedListBlock,
  LeafletImageBlock,
  LeafletListItemBlock,
  LeafletWebsiteBlock,
  LeafletBskyPostBlock,
  LeafletPageBlock,
  LeafletBlockWrapper,
} from '$lib/types';
import { escapeHtml } from '$lib/utils/html';

/**
 * Check if content is pub.leaflet.content format
 */
export function isLeafletContent(content: unknown): content is LeafletContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    '$type' in content &&
    (content as { $type: string }).$type === 'pub.leaflet.content'
  );
}

/**
 * Construct a CDN URL for an AT Protocol blob
 * Uses bsky.app CDN which serves blobs from any PDS
 */
function getBlobUrl(authorDid: string, blobCid: string): string {
  return `https://cdn.bsky.app/img/feed_fullsize/plain/${authorDid}/${blobCid}@jpeg`;
}

function sizeAttrs(aspectRatio?: { width: number; height: number }): string {
  if (!aspectRatio) return '';
  const { width, height } = aspectRatio;
  if (![width, height].every((n) => Number.isFinite(n) && n > 0)) return '';
  return ` width="${Math.round(width)}" height="${Math.round(height)}"`;
}

function widthClass(width?: string): string {
  if (!width) return '';
  const pct = Number.parseFloat(width);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 97) return '';
  return ` op-figure--w${Math.max(30, Math.min(90, Math.round(pct / 10) * 10))}`;
}

function alignmentClass(value?: string): string {
  const token = value
    ?.split('#')
    .pop()
    ?.replace(/^textAlign/, '')
    .toLowerCase();
  if (token === 'center') return 'op-align-center';
  if (token === 'right') return 'op-align-right';
  if (token === 'justify') return 'lf-align-justify';
  return '';
}

const FOOTNOTE_FEATURE = 'pub.leaflet.richtext.facet#footnote';

/** A footnote collected in document order, keyed by its footnoteId. */
interface FootnoteEntry {
  /** 1-based number shown in the marker and in the list at the end. */
  number: number;
  contentPlaintext: string;
  contentFacets?: LeafletFacet[];
}

type FootnoteIndex = Map<string, FootnoteEntry>;

/**
 * Visit every facet-bearing block in document order.
 * Used to number footnotes by reading order (applyFacets walks facets in
 * reverse, so numbers can't be assigned while wrapping).
 */
function forEachFacetList(
  content: LeafletContent,
  visit: (facets: LeafletFacet[] | undefined) => void
): void {
  const visitItems = (items: LeafletListItemBlock[] | undefined) => {
    for (const item of items || []) {
      visit(item.content?.facets);
      visitItems(item.children);
    }
  };

  for (const page of content.pages || []) {
    if (page.$type !== 'pub.leaflet.pages.linearDocument' || !page.blocks) {
      continue;
    }
    for (const wrapper of page.blocks) {
      const block = wrapper.block;
      switch (block.$type) {
        case 'pub.leaflet.blocks.text':
        case 'pub.leaflet.blocks.header':
        case 'pub.leaflet.blocks.blockquote':
          visit(block.facets);
          break;
        case 'pub.leaflet.blocks.unorderedList':
        case 'pub.leaflet.blocks.orderedList':
          visitItems(block.children);
          break;
      }
    }
  }
}

/**
 * Number every footnote in the document by reading order.
 * A footnoteId that appears more than once reuses its first number.
 */
function buildFootnoteIndex(content: LeafletContent): FootnoteIndex {
  const index: FootnoteIndex = new Map();

  forEachFacetList(content, (facets) => {
    if (!facets || facets.length === 0) return;
    const inOrder = [...facets].sort(
      (a, b) => (a.index?.byteStart ?? 0) - (b.index?.byteStart ?? 0)
    );
    for (const facet of inOrder) {
      for (const feature of facet.features || []) {
        if (feature.$type !== FOOTNOTE_FEATURE) continue;
        const id = feature.footnoteId;
        if (!id || index.has(id)) continue;
        index.set(id, {
          number: index.size + 1,
          contentPlaintext: feature.contentPlaintext || '',
          contentFacets: feature.contentFacets,
        });
      }
    }
  });

  return index;
}

/**
 * The inline reference. Leaflet puts a bare marker character (a `*`) at the
 * reference position, so we replace the faceted span rather than wrap it —
 * the number is what makes each reference identifiable.
 *
 * `href="#"` is a placeholder: the sanitizer rewrites real hash hrefs to the
 * source article and forces target="_blank", so the jump is handled by the
 * delegated click handler in `footnoteNav.ts` instead.
 */
function renderFootnoteRef(number: number): string {
  return `<sup class="footnote-ref"><a href="#" data-footnote-ref="${number}" aria-label="Footnote ${number}">${number}</a></sup>`;
}

/**
 * The list of footnote bodies, appended once at the end of the document.
 */
function renderFootnotesSection(footnotes: FootnoteIndex): string {
  if (footnotes.size === 0) {
    return '';
  }

  const items = [...footnotes.values()]
    .sort((a, b) => a.number - b.number)
    .map((footnote) => {
      // No footnote index passed down: a footnote nested inside a footnote body
      // (the lexicon allows it) renders as plain text rather than recursing.
      const body = applyFacets(footnote.contentPlaintext, footnote.contentFacets);
      const backref = `<a class="footnote-backref" href="#" data-footnote-backref="${footnote.number}" aria-label="Back to reference ${footnote.number}">↩</a>`;
      return `<li data-footnote-id="${footnote.number}">${body} ${backref}</li>`;
    })
    .join('');

  return `<section class="footnotes" role="doc-endnotes" aria-label="Footnotes"><ol>${items}</ol></section>`;
}

/**
 * Apply facets (rich text formatting) to plaintext
 * Facets use byte ranges, so we need to handle UTF-8 encoding properly
 *
 * @param footnotes - Document footnote numbering; omitted inside footnote
 *   bodies so nested footnotes degrade to plain text.
 */
function applyFacets(
  plaintext: string,
  facets?: LeafletFacet[],
  footnotes?: FootnoteIndex
): string {
  if (!facets || facets.length === 0) {
    return escapeHtml(plaintext);
  }

  // Convert string to UTF-8 bytes for proper indexing
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(plaintext);

  // Sort facets by byteStart in reverse order to apply from end to start
  // This ensures byte indices remain valid as we insert HTML tags
  const sortedFacets = [...facets].sort((a, b) => b.index.byteStart - a.index.byteStart);

  let result = bytes;

  for (const facet of sortedFacets) {
    const { byteStart, byteEnd } = facet.index;

    // Extract the text slice
    const beforeBytes = result.slice(0, byteStart);
    const facetBytes = result.slice(byteStart, byteEnd);
    const afterBytes = result.slice(byteEnd);

    const facetText = escapeHtml(decoder.decode(facetBytes));

    // Build the wrapped text based on facet features
    let wrappedText = facetText;

    // A footnote replaces the marker outright, so the other features on that
    // facet don't apply (a bold footnote number means nothing). A malformed
    // feature — no footnoteId, or one the pre-pass never saw — falls through
    // to the normal wrapping below.
    const footnoteId = footnotes
      ? facet.features?.find((f) => f.$type === FOOTNOTE_FEATURE && f.footnoteId)?.footnoteId
      : undefined;
    const footnote = footnoteId ? footnotes?.get(footnoteId) : undefined;

    for (const feature of footnote ? [] : facet.features) {
      switch (feature.$type) {
        case 'pub.leaflet.richtext.facet#bold':
        case 'app.bsky.richtext.facet#bold':
          wrappedText = `<strong>${wrappedText}</strong>`;
          break;
        case 'pub.leaflet.richtext.facet#italic':
        case 'app.bsky.richtext.facet#italic':
          wrappedText = `<em>${wrappedText}</em>`;
          break;
        case 'pub.leaflet.richtext.facet#strikethrough':
        case 'app.bsky.richtext.facet#strikethrough':
          wrappedText = `<del>${wrappedText}</del>`;
          break;
        case 'pub.leaflet.richtext.facet#underline':
          wrappedText = `<u>${wrappedText}</u>`;
          break;
        case 'pub.leaflet.richtext.facet#code':
          wrappedText = `<code>${wrappedText}</code>`;
          break;
        case 'pub.leaflet.richtext.facet#highlight':
          wrappedText = `<mark>${wrappedText}</mark>`;
          break;
        case 'pub.leaflet.richtext.facet#link':
        case 'app.bsky.richtext.facet#link':
          if (feature.uri) {
            wrappedText = `<a href="${escapeHtml(feature.uri)}" target="_blank" rel="noopener">${wrappedText}</a>`;
          }
          break;
        case 'pub.leaflet.richtext.facet#mention':
        case 'pub.leaflet.richtext.facet#didMention':
        case 'app.bsky.richtext.facet#mention':
          if (feature.did) {
            // In-app, a mention opens the add-feed dialog for the DID (see
            // ArticleCardView's content click handler); the bsky href is the
            // fallback wherever that handler isn't present (e.g. the reader).
            wrappedText = `<a class="mention" data-mention-did="${escapeHtml(feature.did)}" href="https://bsky.app/profile/${escapeHtml(feature.did)}" target="_blank" rel="noopener">${wrappedText}</a>`;
          }
          break;
        case 'pub.leaflet.richtext.facet#atMention': {
          const at = feature as typeof feature & { atURI?: string; href?: string };
          const href = at.href || at.atURI;
          if (href) wrappedText = `<a href="${escapeHtml(href)}">${wrappedText}</a>`;
          break;
        }
        case 'pub.leaflet.richtext.facet#id': {
          const anchor = feature as typeof feature & { id?: string };
          if (anchor.id)
            wrappedText = `<span id="lf-anchor-${escapeHtml(anchor.id)}">${wrappedText}</span>`;
          break;
        }
      }
    }

    if (footnote) {
      wrappedText = renderFootnoteRef(footnote.number);
    }

    // Reconstruct the byte array with the HTML-wrapped text
    const wrappedBytes = encoder.encode(wrappedText);
    const newResult = new Uint8Array(beforeBytes.length + wrappedBytes.length + afterBytes.length);
    newResult.set(beforeBytes, 0);
    newResult.set(wrappedBytes, beforeBytes.length);
    newResult.set(afterBytes, beforeBytes.length + wrappedBytes.length);
    result = newResult;
  }

  return decoder.decode(result);
}

/**
 * Render a text block
 */
function renderTextBlock(block: LeafletTextBlock, footnotes?: FootnoteIndex): string {
  if (!block.plaintext) {
    return '';
  }
  const content = applyFacets(block.plaintext, block.facets, footnotes);

  let sizeClass = '';
  if (block.textSize === 'small') {
    sizeClass = ' class="lf-text-small"';
  } else if (block.textSize === 'large') {
    sizeClass = ' class="lf-text-large"';
  }

  return `<p${sizeClass}>${content}</p>`;
}

/**
 * Render a header block
 */
function renderHeaderBlock(block: LeafletHeaderBlock, footnotes?: FootnoteIndex): string {
  if (!block.plaintext) {
    return '';
  }
  const content = applyFacets(block.plaintext, block.facets, footnotes);
  const level = block.level || 2; // Default to h2
  const tag = `h${Math.min(Math.max(level, 1), 6)}`;
  return `<${tag}>${content}</${tag}>`;
}

/**
 * Render a code block
 */
function renderCodeBlock(block: LeafletCodeBlock): string {
  if (!block.plaintext) {
    return '';
  }
  const escaped = escapeHtml(block.plaintext);
  const langClass = block.language ? ` class="language-${escapeHtml(block.language)}"` : '';
  return `<pre><code${langClass}>${escaped}</code></pre>`;
}

/**
 * Render a blockquote block
 */
function renderBlockquoteBlock(block: LeafletBlockquoteBlock, footnotes?: FootnoteIndex): string {
  if (!block.plaintext) {
    return '';
  }
  const content = applyFacets(block.plaintext, block.facets, footnotes);
  return `<blockquote>${content}</blockquote>`;
}

/**
 * Render a horizontal rule block
 */
function renderHorizontalRuleBlock(): string {
  return '<hr />';
}

/**
 * Render list items recursively
 * @param children - List item children to render
 * @param listTag - Tag for nested lists ('ul' or 'ol')
 */
function renderListItems(
  children: LeafletListItemBlock[] | undefined,
  listTag: 'ul' | 'ol' = 'ul',
  footnotes?: FootnoteIndex
): string {
  if (!children || children.length === 0) {
    return '';
  }

  return children
    .map((item) => {
      // Extract plaintext and facets from the content block
      const plaintext = item.content?.plaintext || '';
      const facets = item.content?.facets;
      const content = applyFacets(plaintext, facets, footnotes);
      let html = `<li>${content}`;

      const checked = item.checked;
      if (checked !== undefined)
        html = `<li class="op-tasklist__item"><input type="checkbox"${checked ? ' checked' : ''} disabled /> ${content}`;
      const same = item.children;
      const ordered = item.orderedListChildren;
      const unordered = item.unorderedListChildren;
      if (same?.length)
        html += `<${listTag}>${renderListItems(same, listTag, footnotes)}</${listTag}>`;
      if (ordered?.length) html += `<ol>${renderListItems(ordered, 'ol', footnotes)}</ol>`;
      if (unordered?.length) html += `<ul>${renderListItems(unordered, 'ul', footnotes)}</ul>`;

      html += '</li>';
      return html;
    })
    .join('');
}

/**
 * Render an unordered list block
 */
function renderUnorderedListBlock(
  block: LeafletUnorderedListBlock,
  footnotes?: FootnoteIndex
): string {
  const itemsHtml = renderListItems(block.children, 'ul', footnotes);
  if (!itemsHtml) {
    return '';
  }
  return `<ul${block.children.some((item) => item.checked !== undefined) ? ' class="op-tasklist"' : ''}>${itemsHtml}</ul>`;
}

/**
 * Render an ordered list block
 */
function renderOrderedListBlock(block: LeafletOrderedListBlock, footnotes?: FootnoteIndex): string {
  const itemsHtml = renderListItems(block.children, 'ol', footnotes);
  if (!itemsHtml) {
    return '';
  }
  const start = block.startIndex && block.startIndex !== 1 ? ` start="${block.startIndex}"` : '';
  return `<ol${start}>${itemsHtml}</ol>`;
}

/**
 * Render an image block
 */
function renderImageBlock(block: LeafletImageBlock, authorDid: string): string {
  const blobCid = block.image?.ref?.$link;
  if (!blobCid) {
    return '';
  }

  const url = getBlobUrl(authorDid, blobCid);
  const alt = block.alt ? escapeHtml(block.alt) : '';

  const cls = `op-figure${widthClass(block.width)}${block.fullBleed ? ' lf-full-bleed' : ''}`;
  return `<figure class="${cls}"><img src="${url}" alt="${alt}"${sizeAttrs(block.aspectRatio)} loading="lazy" /></figure>`;
}

/**
 * Render a website preview block
 */
function renderWebsiteBlock(block: LeafletWebsiteBlock, authorDid: string): string {
  const url = block.src;
  if (!url) {
    return '';
  }

  const title = block.title || url;
  const description = block.description || '';
  const thumbCid = block.previewImage?.ref?.$link;

  let html = '<div class="website-preview">';

  if (thumbCid) {
    const thumbUrl = getBlobUrl(authorDid, thumbCid);
    html += `<div class="website-preview__media"><img class="op-media" src="${thumbUrl}" alt="" loading="lazy" /></div>`;
  }

  html += '<div>';
  html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`;

  if (description) {
    html += `<p>${escapeHtml(description)}</p>`;
  }

  html += '</div></div>';

  return html;
}

/**
 * Render a Bluesky post embed block
 * Returns a placeholder div that gets hydrated by the bskyEmbed action
 */
function renderBskyPostBlock(block: LeafletBskyPostBlock): string {
  const postUri = block.postRef?.uri;
  if (!postUri) {
    return '';
  }

  // Return placeholder that will be hydrated by Svelte action
  return `<div class="bsky-post-embed" data-uri="${escapeHtml(postUri)}"></div>`;
}

/**
 * Render a page reference block (sub-page)
 */
function renderPageBlock(
  block: LeafletPageBlock,
  authorDid: string,
  footnotes: FootnoteIndex | undefined,
  content: LeafletContent,
  visited: Set<string>,
  depth: number
): string {
  const pageId = block.id;
  if (!pageId) {
    return '';
  }
  const page = content.pages.find((candidate) => candidate.id === pageId);
  if (!page || visited.has(pageId) || depth >= 5) {
    return `<div class="lf-page-reference"><em>Sub-page: ${escapeHtml(pageId)}</em></div>`;
  }
  const nextVisited = new Set(visited).add(pageId);
  const inner = page.blocks
    .map((wrapper) =>
      renderWrappedBlock(wrapper, authorDid, footnotes, content, nextVisited, depth + 1)
    )
    .join('\n');
  if (block.display === 'compact') {
    return `<details class="lf-page-reference"><summary>Sub-page</summary>${inner}</details>`;
  }
  return `<section class="lf-page-reference">${inner}</section>`;
}

function renderMath(tex: string): string {
  if (!tex) return '';
  try {
    return `<div class="op-math">${temml.renderToString(tex, { displayMode: true, throwOnError: true })}</div>`;
  } catch {
    return `<pre class="op-math-fallback"><code>${escapeHtml(tex)}</code></pre>`;
  }
}

function renderGenericBlock(block: Record<string, unknown>, authorDid: string): string {
  const type = String(block.$type || '');
  if (type === 'pub.leaflet.blocks.math') return renderMath(String(block.tex || ''));
  if (type === 'pub.leaflet.blocks.button') {
    const url = typeof block.url === 'string' ? block.url : '';
    return url
      ? `<p><a class="op-button" href="${escapeHtml(url)}">${escapeHtml(String(block.text || url))}</a></p>`
      : '';
  }
  if (type === 'pub.leaflet.blocks.imageGallery' && Array.isArray(block.images)) {
    const images = block.images as Array<Record<string, unknown>>;
    const carousel = String(block.format || '')
      .toLowerCase()
      .includes('carousel');
    const cls = carousel ? 'op-carousel' : `op-grid op-grid--cols-${Math.min(images.length, 3)}`;
    const itemCls = carousel ? 'op-carousel__item' : 'op-grid__cell';
    const body = images
      .map((entry) => {
        const image = entry.image as { ref?: { $link?: string } } | undefined;
        const cid = image?.ref?.$link;
        return cid
          ? `<div class="${itemCls}"><img class="op-media" src="${getBlobUrl(authorDid, cid)}" alt="${escapeHtml(String(entry.alt || ''))}"${sizeAttrs(entry.aspectRatio as { width: number; height: number } | undefined)} loading="lazy" /></div>`
          : '';
      })
      .join('');
    return body ? `<div class="${cls}">${body}</div>` : '';
  }
  if (type === 'pub.leaflet.blocks.iframe') {
    const url = typeof block.url === 'string' ? block.url : '';
    const src = allowedIframeSrc(url, null);
    return src
      ? `<div class="op-embed"><iframe src="${escapeHtml(src)}" loading="lazy"></iframe></div>`
      : url
        ? `<div class="website-preview"><div><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></div></div>`
        : '';
  }
  if (type === 'pub.leaflet.blocks.html' && typeof block.html === 'string') {
    return `<div class="lf-html">${sanitizeHtml(block.html)}</div>`;
  }
  if (
    type === 'pub.leaflet.blocks.standardSitePost' ||
    type === 'pub.leaflet.blocks.standardSitePublication'
  ) {
    const uri = typeof block.uri === 'string' ? block.uri : '';
    return uri
      ? `<div class="website-preview"><div><a href="${escapeHtml(uri)}">View in the Atmosphere</a></div></div>`
      : '';
  }
  return '';
}

/**
 * Render a single block based on its type
 */
function renderBlock(
  block: LeafletBlock,
  authorDid: string,
  footnotes: FootnoteIndex | undefined,
  content: LeafletContent,
  visited: Set<string>,
  depth: number
): string {
  switch (block.$type) {
    case 'pub.leaflet.blocks.text':
      return renderTextBlock(block as LeafletTextBlock, footnotes);
    case 'pub.leaflet.blocks.header':
      return renderHeaderBlock(block as LeafletHeaderBlock, footnotes);
    case 'pub.leaflet.blocks.code':
      return renderCodeBlock(block as LeafletCodeBlock);
    case 'pub.leaflet.blocks.blockquote':
      return renderBlockquoteBlock(block as LeafletBlockquoteBlock, footnotes);
    case 'pub.leaflet.blocks.horizontalRule':
      return renderHorizontalRuleBlock();
    case 'pub.leaflet.blocks.unorderedList':
      return renderUnorderedListBlock(block as LeafletUnorderedListBlock, footnotes);
    case 'pub.leaflet.blocks.orderedList':
      return renderOrderedListBlock(block as LeafletOrderedListBlock, footnotes);
    case 'pub.leaflet.blocks.image':
      return renderImageBlock(block as LeafletImageBlock, authorDid);
    case 'pub.leaflet.blocks.website':
      return renderWebsiteBlock(block as LeafletWebsiteBlock, authorDid);
    case 'pub.leaflet.blocks.bskyPost':
      return renderBskyPostBlock(block as LeafletBskyPostBlock);
    case 'pub.leaflet.blocks.page':
      return renderPageBlock(
        block as LeafletPageBlock,
        authorDid,
        footnotes,
        content,
        visited,
        depth
      );
    default: {
      // Unsupported block type - try to extract plaintext if available
      const unknownBlock = block as unknown as { plaintext?: string };
      if (unknownBlock.plaintext && typeof unknownBlock.plaintext === 'string') {
        return `<p>${escapeHtml(unknownBlock.plaintext)}</p>`;
      }
      return renderGenericBlock(block as unknown as Record<string, unknown>, authorDid);
    }
  }
}

function renderWrappedBlock(
  wrapper: LeafletBlockWrapper,
  authorDid: string,
  footnotes: FootnoteIndex | undefined,
  content: LeafletContent,
  visited: Set<string>,
  depth: number
): string {
  const blockHtml = renderBlock(wrapper.block, authorDid, footnotes, content, visited, depth);
  const alignment = alignmentClass(wrapper.alignment);
  return blockHtml && alignment ? `<div class="${alignment}">${blockHtml}</div>` : blockHtml;
}

/**
 * Main entry point: render Leaflet content to HTML
 */
export function renderLeafletContent(content: LeafletContent, authorDid: string): string {
  if (!content.pages || content.pages.length === 0) {
    return '';
  }

  const htmlParts: string[] = [];

  // Numbered up front, in reading order, so markers and the list at the end agree.
  const footnotes = buildFootnoteIndex(content);

  let degraded = Boolean(content.truncated || content.blobPages);
  for (const page of content.pages) {
    if (page.$type !== 'pub.leaflet.pages.linearDocument' || !page.blocks) {
      degraded = true;
      continue;
    }

    for (const wrapper of page.blocks) {
      if (wrapper.block.$type === 'pub.leaflet.blocks.membersOnlyDelimiter') {
        htmlParts.push('<p class="op-degraded">Members-only · Read on the publication</p>');
        degraded = false;
        break;
      }
      const blockHtml = renderWrappedBlock(
        wrapper,
        authorDid,
        footnotes,
        content,
        new Set(page.id ? [page.id] : []),
        0
      );
      if (blockHtml) {
        htmlParts.push(blockHtml);
      } else {
        degraded = true;
      }
    }
  }

  const footnotesHtml = renderFootnotesSection(footnotes);
  if (footnotesHtml) {
    htmlParts.push(footnotesHtml);
  }
  if (degraded)
    htmlParts.push('<p class="op-degraded">Some content can’t be shown · View original</p>');

  return htmlParts.join('\n');
}
