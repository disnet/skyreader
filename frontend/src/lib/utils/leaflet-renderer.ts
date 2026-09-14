/**
 * Renderer for pub.leaflet.content block-based documents
 * Converts Leaflet blocks to HTML for display in ArticleCard.
 * Styling must use classes: sanitizeHtml deliberately strips inline styles.
 */

import { allowedIframeSrc, sanitizeHtml } from '$lib/utils/sanitize';
import { renderMathPlaceholder } from '$lib/utils/math';

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
  LeafletNestedList,
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

/** The `start` attribute for a list numbered from anything but 1, as an integer. */
function startAttr(startIndex?: number): string {
  const start = Math.trunc(Number(startIndex));
  return Number.isFinite(start) && start !== 1 && start !== 0 ? ` start="${start}"` : '';
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
 * Number the footnotes of one block, in its own reading order.
 *
 * Called as each block is rendered rather than from a pre-pass over the record, so
 * the numbering follows what a reader actually sees: a sub-page's footnotes are
 * numbered where the page is referenced, and a footnote in a members-gated or
 * unreferenced part of the record — which never reaches the page — never claims a
 * number or appears in the list at the end. (`applyFacets` wraps from the end of the
 * string backwards, so numbers can't be assigned while wrapping.)
 *
 * A footnoteId that appears more than once reuses its first number.
 */
function registerFootnotes(index: FootnoteIndex, facets?: LeafletFacet[]): void {
  if (!facets || facets.length === 0) return;
  const inOrder = [...facets].sort((a, b) => (a.index?.byteStart ?? 0) - (b.index?.byteStart ?? 0));
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
}

/** How deep a chain of sub-page references may nest before it stops being content. */
const MAX_PAGE_DEPTH = 5;

/**
 * What one render of a document accumulates: the numbering above, and the two honest
 * admissions the footer can make.
 */
interface RenderContext {
  authorDid: string;
  content: LeafletContent;
  footnotes: FootnoteIndex;
  /** Page ids reached by rendering, so an orphaned page is visible as a loss. */
  reached: Set<string>;
  /**
   * Something the reader can't show was dropped — an unsupported block type, a site
   * widget, a page reference that doesn't resolve, or a body truncated at ingest.
   * Deliberately *not* set by a block that simply renders to nothing: Leaflet's
   * editor writes empty text blocks for paragraph spacing, and a footer that appears
   * on ordinary documents is a footer readers learn to ignore.
   */
  degraded: boolean;
  /** The members-only notice, once the delimiter is reached. Stops the render. */
  gate: string | null;
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

  // Numbered here, in the block's own order, before the reverse walk below.
  if (footnotes) registerFootnotes(footnotes, facets);

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

      // The lexicon makes `children` and the two cross-type fields mutually
      // exclusive, and says `children` wins when a record carries both.
      const same = item.children;
      if (same?.length) {
        html += `<${listTag}>${renderListItems(same, listTag, footnotes)}</${listTag}>`;
      } else {
        const ordered = nestedList(item.orderedListChildren);
        const unordered = nestedList(item.unorderedListChildren);
        if (ordered?.children?.length) {
          const start = startAttr(ordered.startIndex);
          html += `<ol${start}>${renderListItems(ordered.children, 'ol', footnotes)}</ol>`;
        }
        if (unordered?.children?.length) {
          html += `<ul>${renderListItems(unordered.children, 'ul', footnotes)}</ul>`;
        }
      }

      html += '</li>';
      return html;
    })
    .join('');
}

/**
 * A cross-type nested list, as either shape the wire carries: the lexicon's list ref
 * (`{startIndex?, children[]}`) or a bare array of items. Reading it only as an array
 * is how mixed-type nesting used to vanish without even tripping the degradation
 * notice — `.length` on the list object is `undefined`, so the branch never ran.
 */
function nestedList(
  value: LeafletNestedList | LeafletListItemBlock[] | undefined
): LeafletNestedList | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? { children: value } : value;
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
  const start = startAttr(block.startIndex);
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

  // `width` is deliberately unused: the lexicon's value is pixels "capped at the page
  // width", and the page width it was capped against isn't in the record. Bucketing it
  // as a percentage of the reader's measure — which is what the Offprint renderer's
  // helper does with its CSS-string widths — renders a 60 px inline image at 60% of
  // the column and a 400 px one at full width, i.e. wrong in both directions. Full
  // measure is the honest default until the page width is available.
  const cls = `op-figure${block.fullBleed ? ' lf-full-bleed' : ''}`;
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
 * Render a page reference block (sub-page).
 *
 * Leaflet's publisher writes a sub-page into `content.pages` *and* references it from
 * its parent with this block, so the reference is where the page belongs in reading
 * order — see `renderLeafletContent` for why only `pages[0]` is rendered at the top.
 * `visited` is the chain of pages currently being expanded, which is what keeps a
 * record whose pages reference each other from recursing forever.
 */
function renderPageBlock(
  block: LeafletPageBlock,
  ctx: RenderContext,
  visited: Set<string>,
  depth: number
): string {
  const pageId = block.id;
  if (!pageId) {
    ctx.degraded = true;
    return '';
  }
  const page = ctx.content.pages?.find((candidate) => candidate.id === pageId);
  if (!page || visited.has(pageId) || depth >= MAX_PAGE_DEPTH) {
    ctx.degraded = true;
    return `<div class="lf-page-reference"><em>Sub-page: ${escapeHtml(pageId)}</em></div>`;
  }
  const inner = renderPage(page, ctx, new Set(visited).add(pageId), depth + 1);
  if (!inner) return '';
  if (block.display === 'compact') {
    return `<details class="lf-page-reference"><summary>Sub-page</summary>${inner}</details>`;
  }
  return `<section class="lf-page-reference">${inner}</section>`;
}

/**
 * Blocks this reader knows about but deliberately doesn't render: site widgets that
 * mean nothing outside the publication. They count as a loss so the footer says so.
 */
const SKIPPED_BLOCK_TYPES = new Set([
  'pub.leaflet.blocks.poll',
  'pub.leaflet.blocks.postsList',
  'pub.leaflet.blocks.signup',
]);

/**
 * The blocks with no dedicated renderer, plus the fallthrough for a type this build
 * has never heard of. Returns `null` — not `''` — for the latter, because "rendered
 * to nothing" and "can't be rendered" are different answers and only the second one
 * earns the degradation footer.
 */
function renderGenericBlock(block: Record<string, unknown>, authorDid: string): string | null {
  const type = String(block.$type || '');
  if (type === 'pub.leaflet.blocks.math') return renderMathPlaceholder(String(block.tex || ''));
  if (type === 'pub.leaflet.blocks.button') {
    const url = typeof block.url === 'string' ? block.url : '';
    return url
      ? `<p><a class="op-button" href="${escapeHtml(url)}">${escapeHtml(String(block.text || url))}</a></p>`
      : '';
  }
  if (type === 'pub.leaflet.blocks.imageGallery' && Array.isArray(block.images)) {
    const images = block.images as Array<Record<string, unknown>>;
    // `format` is `grid | carousel | strip`; a strip is a horizontally scrolling row,
    // which is the carousel markup rather than the grid's wrapped cells.
    const format = String(block.format || '').toLowerCase();
    const strip = format.includes('carousel') || format.includes('strip');
    const cls = strip ? 'op-carousel' : `op-grid op-grid--cols-${Math.min(images.length, 3)}`;
    const itemCls = strip ? 'op-carousel__item' : 'op-grid__cell';
    const body = images
      .map((entry) => {
        const image = (entry.image ?? entry.blob) as { ref?: { $link?: string } } | undefined;
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
        : null;
  }
  if (type === 'pub.leaflet.blocks.html' && typeof block.html === 'string') {
    // The lexicon renders this in a sandboxed iframe's srcdoc; the sanitizer strips
    // both `srcdoc` and every iframe outside the video allowlist, so an inline,
    // sanitized container is what can actually survive to the page. Script, inline
    // CSS and `<style>` are all gone by then — what an author wrote as a standalone
    // document renders as plain flow content rather than in its own box.
    const html = sanitizeHtml(block.html);
    return html ? `<div class="lf-html">${html}</div>` : null;
  }
  if (
    type === 'pub.leaflet.blocks.standardSitePost' ||
    type === 'pub.leaflet.blocks.standardSitePublication'
  ) {
    const uri = typeof block.uri === 'string' ? block.uri : '';
    return uri
      ? `<div class="website-preview"><div><a href="${escapeHtml(uri)}">View in the Atmosphere</a></div></div>`
      : null;
  }
  if (SKIPPED_BLOCK_TYPES.has(type)) return null;
  return null;
}

/**
 * Render a single block based on its type
 */
function renderBlock(
  block: LeafletBlock,
  ctx: RenderContext,
  visited: Set<string>,
  depth: number
): string {
  const { authorDid, footnotes } = ctx;
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
      return renderPageBlock(block as LeafletPageBlock, ctx, visited, depth);
    default: {
      // Unsupported block type - try to extract plaintext if available
      const unknownBlock = block as unknown as { plaintext?: string };
      if (unknownBlock.plaintext && typeof unknownBlock.plaintext === 'string') {
        return `<p>${escapeHtml(unknownBlock.plaintext)}</p>`;
      }
      const generic = renderGenericBlock(block as unknown as Record<string, unknown>, authorDid);
      // `null` is the renderer admitting it has nothing for this block; `''` is a
      // supported block that happens to carry nothing, which is not a loss.
      if (generic === null) {
        ctx.degraded = true;
        return '';
      }
      return generic;
    }
  }
}

function renderWrappedBlock(
  wrapper: LeafletBlockWrapper,
  ctx: RenderContext,
  visited: Set<string>,
  depth: number
): string {
  const blockHtml = renderBlock(wrapper.block, ctx, visited, depth);
  const alignment = alignmentClass(wrapper.alignment);
  return blockHtml && alignment ? `<div class="${alignment}">${blockHtml}</div>` : blockHtml;
}

/** Everything after the delimiter is the author's gated content; say so and stop. */
function membersOnlyNotice(audience?: string): string {
  // `subscribers` gates on following the publication, not on paying for it — calling
  // that "members-only" overstates the wall to a reader who could just subscribe.
  const who = audience === 'subscribers' ? 'subscribers' : 'members';
  return `<p class="op-degraded">The rest is for ${who} · Read on the publication</p>`;
}

/**
 * One page's blocks, in order, stopping at a members-only delimiter.
 */
function renderPage(
  page: LeafletContent['pages'][number],
  ctx: RenderContext,
  visited: Set<string>,
  depth: number
): string {
  if (page.$type !== 'pub.leaflet.pages.linearDocument' || !Array.isArray(page.blocks)) {
    // A `pub.leaflet.pages.canvas` page places its blocks on a freeform x/y surface;
    // there is no reading order to lay out here, so it counts as content we dropped.
    ctx.degraded = true;
    return '';
  }
  if (page.id) ctx.reached.add(page.id);

  const parts: string[] = [];
  for (const wrapper of page.blocks) {
    if (ctx.gate) break;
    const block = wrapper.block as { $type?: string; audience?: string };
    if (block.$type === 'pub.leaflet.blocks.membersOnlyDelimiter') {
      // Set on the shared context, not broken out of one loop: the gate applies to
      // the document, and the pages after this one are past it too.
      ctx.gate = membersOnlyNotice(block.audience);
      break;
    }
    const html = renderWrappedBlock(wrapper, ctx, visited, depth);
    if (html) parts.push(html);
  }
  return parts.join('\n');
}

/**
 * Main entry point: render Leaflet content to HTML.
 *
 * Only `pages[0]` is rendered at the top level. Leaflet's publisher pushes every
 * sub-page into `content.pages` *and* references it from its parent with a
 * `pub.leaflet.blocks.page` block, so the rest of the array is pulled in at the point
 * it is referenced — walking the array as well emitted each sub-page twice, once
 * inline and once appended after the document.
 */
export function renderLeafletContent(content: LeafletContent, authorDid: string): string {
  const pages = content.pages || [];
  if (pages.length === 0) {
    return '';
  }

  const ctx: RenderContext = {
    authorDid,
    content,
    footnotes: new Map(),
    reached: new Set(),
    // A body the ingest path truncated, or a `blobPages` stub it never inflated, is
    // missing content the reader should hear about even if every block it did get
    // rendered.
    degraded: Boolean(content.truncated || content.blobPages),
    gate: null,
  };

  const root = pages[0];
  const htmlParts: string[] = [];
  const body = renderPage(root, ctx, new Set(root.id ? [root.id] : []), 0);
  // Nothing rendered at all — an un-inflated `blobPages` stub, a canvas-only record.
  // Returning the empty string rather than a bare degradation notice is what lets the
  // callers fall back to the document's own `textContent`, which is more use to a
  // reader than a footer with no article above it.
  if (!body && !ctx.gate) return '';
  if (body) htmlParts.push(body);
  if (ctx.gate) htmlParts.push(ctx.gate);

  // A page nothing referenced is content this render never reached. Rare — the
  // publisher always writes the reference — but silent if we don't say it.
  //
  // Not once the gate is up, though: the render stopped at the delimiter, so a page
  // whose reference sits past it is unreached *by design* and indistinguishable here
  // from a genuine orphan. Claiming "some content can't be shown" under a notice that
  // already says exactly why the rest is missing is the less honest of the two. Any
  // degradation earned before the gate still stands — this only declines to add one.
  if (!ctx.gate && pages.slice(1).some((page) => !page.id || !ctx.reached.has(page.id))) {
    ctx.degraded = true;
  }

  const footnotesHtml = renderFootnotesSection(ctx.footnotes);
  if (footnotesHtml) {
    htmlParts.push(footnotesHtml);
  }
  if (ctx.degraded)
    htmlParts.push('<p class="op-degraded">Some content can’t be shown · View original</p>');

  return htmlParts.join('\n');
}
